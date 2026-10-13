//! Offline transport contracts. All TLS certificates and the private key below were generated
//! solely for loopback test servers. They are unrelated to a real tunnel or user certificate.
//! No ordinary test contacts the Internet, opens APPDATA, or writes a novel database.

use super::comfy_tls::{
    certificate_info, normalize_base_url, origin_for, ComfyCertificateInfo, ComfyTrustService,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rustls::{Certificate, PrivateKey, ServerConfig};
use serde_json::{json, Value};
use std::{
    future::Future,
    io::Cursor,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    sync::Notify,
    task::{JoinHandle, JoinSet},
    time::timeout,
};
use tokio_rustls::TlsAcceptor;

const VALID_CERT: &[u8] =
    include_bytes!("../../test-resources/comfy-tls/valid-tunnel-certificate.pem");
const EXPIRED_CERT: &[u8] =
    include_bytes!("../../test-resources/comfy-tls/expired-tunnel-certificate.pem");
const WRONG_HOST_CERT: &[u8] =
    include_bytes!("../../test-resources/comfy-tls/wrong-host-tunnel-certificate.pem");
const RENEWED_CERT: &[u8] =
    include_bytes!("../../test-resources/comfy-tls/renewed-same-key-certificate.pem");
const PRIVATE_KEY: &[u8] = include_bytes!("../../test-resources/comfy-tls/mock-private-key.pem");
const STATS: &str = r#"{"system":{"os":"offline-test","python_version":"3.12"},"devices":[]}"#;
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfixture-only";

#[derive(Clone, Debug)]
struct MockRequest {
    method: String,
    target: String,
    body: Vec<u8>,
}

struct MockResponse {
    status: u16,
    body: Vec<u8>,
    headers: Vec<(String, String)>,
    body_gate: Option<(Arc<Notify>, Arc<Notify>)>,
}

impl MockResponse {
    fn ok(body: impl AsRef<[u8]>) -> Self {
        Self {
            status: 200,
            body: body.as_ref().to_vec(),
            headers: Vec::new(),
            body_gate: None,
        }
    }
    fn redirect(location: impl Into<String>) -> Self {
        Self {
            status: 302,
            body: b"not followed".to_vec(),
            headers: vec![("Location".into(), location.into())],
            body_gate: None,
        }
    }
}

type ResponseFuture = Pin<Box<dyn Future<Output = MockResponse> + Send>>;
type Handler = Arc<dyn Fn(MockRequest) -> ResponseFuture + Send + Sync>;

struct MockServer {
    base: String,
    requests: Arc<Mutex<Vec<MockRequest>>>,
    listener: JoinHandle<()>,
}

impl Drop for MockServer {
    fn drop(&mut self) {
        // The listener owns a JoinSet; aborting it also closes all pending TLS / HTTP peers.
        self.listener.abort();
    }
}

impl MockServer {
    async fn plain_http(status: u16, body: &'static str, location: Option<&'static str>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let requests_task = requests.clone();
        let listener = tokio::spawn(async move {
            let mut peers = JoinSet::new();
            loop {
                tokio::select! {
                    incoming = listener.accept() => {
                        let Ok((stream, _)) = incoming else { break };
                        let requests = requests_task.clone();
                        peers.spawn(async move {
                            let mut stream = BufReader::new(stream);
                            let mut first = String::new();
                            if stream.read_line(&mut first).await.unwrap_or(0) == 0 { return; }
                            let mut parts = first.split_whitespace();
                            let method = parts.next().unwrap_or_default().to_owned();
                            let target = parts.next().unwrap_or_default().to_owned();
                            loop {
                                let mut line = String::new();
                                if stream.read_line(&mut line).await.unwrap_or(0) == 0 { return; }
                                if line == "\r\n" { break; }
                            }
                            requests.lock().unwrap().push(MockRequest { method, target, body: Vec::new() });
                            let location = location.map(|l| format!("Location: {}\r\n", l)).unwrap_or_default();
                            let response = format!("HTTP/1.1 {} Test\r\nContent-Length: {}\r\nConnection: close\r\n{}\r\n{}", status, body.len(), location, body);
                            let _ = stream.get_mut().write_all(response.as_bytes()).await;
                            let _ = stream.get_mut().shutdown().await;
                        });
                    }
                    _ = peers.join_next(), if !peers.is_empty() => {}
                }
            }
        });
        Self {
            base,
            requests,
            listener,
        }
    }

    async fn new(cert: &[u8], handler: Handler) -> Self {
        let key = rustls_pemfile::pkcs8_private_keys(&mut Cursor::new(PRIVATE_KEY))
            .unwrap()
            .remove(0);
        let config = ServerConfig::builder()
            .with_safe_defaults()
            .with_no_client_auth()
            .with_single_cert(vec![Certificate(der(cert))], PrivateKey(key))
            .unwrap();
        let acceptor = TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!(
            "https://127.0.0.1:{}",
            listener.local_addr().unwrap().port()
        );
        let requests = Arc::new(Mutex::new(Vec::new()));
        let requests_task = requests.clone();
        let listener = tokio::spawn(async move {
            let mut peers = JoinSet::new();
            loop {
                tokio::select! {
                    incoming = listener.accept() => {
                        let Ok((stream, _)) = incoming else { break };
                        let acceptor = acceptor.clone();
                        let requests = requests_task.clone();
                        let handler = handler.clone();
                        peers.spawn(async move {
                            let Ok(stream) = acceptor.accept(stream).await else { return };
                            let mut stream = BufReader::new(stream);
                            loop {
                                let mut first = String::new();
                                if stream.read_line(&mut first).await.unwrap_or(0) == 0 { return; }
                                let mut parts = first.split_whitespace();
                                let method = parts.next().unwrap_or_default().to_owned();
                                let target = parts.next().unwrap_or_default().to_owned();
                                let mut length = 0usize;
                                let mut header_bytes = first.len();
                                loop {
                                    let mut line = String::new();
                                    if stream.read_line(&mut line).await.unwrap_or(0) == 0 { return; }
                                    header_bytes += line.len();
                                    if header_bytes > 32 * 1024 { return; }
                                    if line == "\r\n" { break; }
                                    if let Some((key, value)) = line.split_once(':') {
                                        if key.eq_ignore_ascii_case("content-length") {
                                            length = value.trim().parse().unwrap_or(0);
                                        }
                                    }
                                }
                                if length > 2 * 1024 * 1024 { return; }
                                let mut body = vec![0; length];
                                if stream.read_exact(&mut body).await.is_err() { return; }
                                let request = MockRequest { method, target, body };
                                requests.lock().unwrap().push(request.clone());
                                let response = handler(request).await;
                                let mut header = format!(
                                    "HTTP/1.1 {} Test\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: keep-alive\r\n",
                                    response.status, response.body.len()
                                );
                                for (key, value) in response.headers { header.push_str(&format!("{}: {}\r\n", key, value)); }
                                header.push_str("\r\n");
                                if stream.get_mut().write_all(header.as_bytes()).await.is_err()
                                    || stream.get_mut().flush().await.is_err() { return; }
                                if let Some((started, release)) = response.body_gate {
                                    started.notify_one();
                                    release.notified().await;
                                }
                                if stream.get_mut().write_all(&response.body).await.is_err()
                                    || stream.get_mut().flush().await.is_err() { return; }
                            }
                        });
                    }
                    _ = peers.join_next(), if !peers.is_empty() => {}
                }
            }
        });
        Self {
            base,
            requests,
            listener,
        }
    }

    async fn stats(cert: &[u8]) -> Self {
        Self::new(
            cert,
            Arc::new(|_| Box::pin(async { MockResponse::ok(STATS) })),
        )
        .await
    }

    fn recorded(&self) -> Vec<MockRequest> {
        self.requests.lock().unwrap().clone()
    }
}

fn der(pem: &[u8]) -> Vec<u8> {
    let certificates = rustls_pemfile::certs(&mut Cursor::new(pem)).unwrap();
    assert_eq!(
        certificates.len(),
        1,
        "fixture must contain one certificate"
    );
    certificates.into_iter().next().unwrap()
}

fn info(base: &str, cert: &[u8]) -> ComfyCertificateInfo {
    let url = normalize_base_url(base).unwrap();
    certificate_info(&origin_for(&url).unwrap(), &der(cert)).unwrap()
}

fn service() -> (TempDir, ComfyTrustService) {
    let root = tempfile::tempdir().unwrap();
    let service = ComfyTrustService::new(root.path().to_path_buf());
    (root, service)
}

async fn connects(service: &ComfyTrustService, address: &str) -> bool {
    let Ok(client) = service.client_for(Some(address.to_owned())) else {
        return false;
    };
    timeout(Duration::from_secs(5), client.test_connection())
        .await
        .unwrap()
        .unwrap_or(false)
}

fn history(prompt_id: &str) -> String {
    json!({(prompt_id): {
        "status": {"completed": true, "status_str": "success"},
        "outputs": {"9": {"images": [{"filename": "封面 &?#.png", "subfolder": "作品/封面", "type": "output"}]}}
    }}).to_string()
}

#[tokio::test]
async fn self_signed_is_rejected_without_http_and_approval_stays_private() {
    let server = MockServer::stats(VALID_CERT).await;
    let (_root, service) = service();
    assert!(!connects(&service, &server.base).await);
    assert!(server.recorded().is_empty());
    service
        .approve(&server.base, &info(&server.base, VALID_CERT))
        .unwrap();
    assert!(connects(&service, &server.base).await);
    assert_eq!(server.recorded().len(), 1);
    // A private ComfyUI approval must not change reqwest's default TLS configuration.
    let default = reqwest::Client::new()
        .get(format!("{}/system_stats", server.base))
        .send()
        .await;
    assert!(default.is_err());
    assert_eq!(server.recorded().len(), 1);
}

#[tokio::test]
async fn wrong_hash_cannot_authorize_a_correct_certificate() {
    let server = MockServer::stats(VALID_CERT).await;
    let (_root, service) = service();
    let mut invalid = info(&server.base, VALID_CERT);
    invalid.certificate_sha256 = "00".repeat(32);
    assert!(service.approve(&server.base, &invalid).is_err());
    assert!(!connects(&service, &server.base).await);
    assert!(server.recorded().is_empty());
}

#[tokio::test]
async fn exact_pin_never_overrides_hostname_or_expiry_checks() {
    for pem in [WRONG_HOST_CERT, EXPIRED_CERT] {
        let server = MockServer::stats(pem).await;
        let (_root, service) = service();
        // Whether caught at approval or handshake, HTTP must never receive the request.
        let _ = service.approve(&server.base, &info(&server.base, pem));
        assert!(!connects(&service, &server.base).await);
        assert!(server.recorded().is_empty());
    }
}

#[tokio::test]
async fn a_new_certificate_with_same_private_key_does_not_inherit_exact_der_pin() {
    assert_ne!(der(VALID_CERT), der(RENEWED_CERT));
    let server = MockServer::stats(RENEWED_CERT).await;
    let (_root, service) = service();
    service
        .approve(&server.base, &info(&server.base, VALID_CERT))
        .unwrap();
    assert!(!connects(&service, &server.base).await);
    assert!(server.recorded().is_empty());
    service
        .approve(&server.base, &info(&server.base, RENEWED_CERT))
        .unwrap();
    assert!(
        connects(&service, &server.base).await,
        "renewed cert fixture itself must be valid"
    );
}

#[tokio::test]
async fn origin_port_host_scheme_are_isolated_but_proxy_paths_share_one_origin() {
    let server = MockServer::stats(VALID_CERT).await;
    let other = MockServer::stats(VALID_CERT).await;
    let (_root, service) = service();
    service
        .approve(&server.base, &info(&server.base, VALID_CERT))
        .unwrap();
    assert!(service
        .get_approval(&format!("{}/proxy/comfy", server.base))
        .unwrap()
        .is_some());
    for address in [
        other.base.clone(),
        server.base.replace("127.0.0.1", "localhost"),
        server.base.replace("https:", "http:"),
    ] {
        assert!(
            service.get_approval(&address).unwrap().is_none(),
            "{} inherited an approval",
            address
        );
    }
    assert!(!connects(&service, &other.base).await);
    assert!(!connects(&service, &server.base.replace("127.0.0.1", "localhost")).await);
    // Don't send a plaintext HTTP request to the TLS listener; authority isolation is checked above.
    assert!(server.recorded().is_empty());
    assert!(other.recorded().is_empty());
}

#[test]
fn endpoint_normalization_rejects_ambiguous_credentials_query_fragment_and_bad_scheme() {
    assert_eq!(
        normalize_base_url(" localhost:8188/proxy/comfy/ ")
            .unwrap()
            .as_str(),
        "http://localhost:8188/proxy/comfy"
    );
    assert_eq!(
        origin_for(&normalize_base_url("https://LOCALHOST:443/proxy").unwrap()).unwrap(),
        "https://localhost"
    );
    assert_eq!(
        origin_for(&normalize_base_url("https://localhost/proxy").unwrap()).unwrap(),
        "https://localhost"
    );
    assert_eq!(
        origin_for(&normalize_base_url("https://[::1]:443/proxy").unwrap()).unwrap(),
        "https://[::1]"
    );
    assert_eq!(
        origin_for(&normalize_base_url("https://[::1]:35961/proxy").unwrap()).unwrap(),
        "https://[::1]:35961"
    );
    for bad in [
        "ftp://localhost",
        "https://user:secret@localhost",
        "https://@localhost",
        "https://localhost/path?token=secret",
        "https://localhost/path#fragment",
        "https://localhost:0",
        "https://localhost/a b",
        "https://localhost\\proxy",
        "https://localhost/a\nb",
    ] {
        assert!(
            normalize_base_url(bad).is_err(),
            "accepted ambiguous endpoint {}",
            bad
        );
    }
}

#[tokio::test]
async fn certificate_inspection_observes_metadata_without_http_or_silent_approval() {
    let server = MockServer::stats(VALID_CERT).await;
    let (_root, service) = service();
    let observed = timeout(
        Duration::from_secs(5),
        service.inspect_certificate(&format!("{}/proxy/comfy", server.base)),
    )
    .await
    .unwrap()
    .unwrap();
    let expected = info(&server.base, VALID_CERT);
    assert_eq!(observed.certificate_sha256, expected.certificate_sha256);
    assert_eq!(
        observed.certificate_der_base64,
        expected.certificate_der_base64
    );
    assert_eq!(observed.origin, expected.origin);
    assert_eq!(observed.subject, expected.subject);
    assert_eq!(observed.issuer, expected.issuer);
    assert_eq!(observed.not_before_epoch_ms, expected.not_before_epoch_ms);
    assert_eq!(observed.not_after_epoch_ms, expected.not_after_epoch_ms);
    assert!(server.recorded().is_empty());
    assert!(service.get_approval(&server.base).unwrap().is_none());
    assert!(!connects(&service, &server.base).await);
}

#[tokio::test]
async fn inspection_can_display_expired_dates_but_never_authorizes_it() {
    let server = MockServer::stats(EXPIRED_CERT).await;
    let (_root, service) = service();
    let observed = timeout(
        Duration::from_secs(5),
        service.inspect_certificate(&server.base),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(observed.not_after_epoch_ms < chrono::Utc::now().timestamp_millis());
    assert!(service.approve(&server.base, &observed).is_err());
    assert!(server.recorded().is_empty());
}

#[tokio::test]
async fn inspection_rejects_plain_http_without_connecting() {
    let (_root, service) = service();
    assert!(service
        .inspect_certificate("http://127.0.0.1:12345")
        .await
        .is_err());
}

#[tokio::test]
async fn cancelling_inspection_closes_its_blocked_tls_peer() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!(
        "https://127.0.0.1:{}",
        listener.local_addr().unwrap().port()
    );
    let started = Arc::new(Notify::new());
    let started_peer = started.clone();
    let peer = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut bytes = [0u8; 8192];
        assert!(socket.read(&mut bytes).await.unwrap() > 0);
        started_peer.notify_one();
        loop {
            match socket.read(&mut bytes).await {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
        }
    });
    let (_root, service) = service();
    let inspection = tokio::spawn(async move { service.inspect_certificate(&address).await });
    timeout(Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    inspection.abort();
    assert!(inspection.await.unwrap_err().is_cancelled());
    timeout(Duration::from_secs(5), peer)
        .await
        .expect("cancel must close socket")
        .unwrap();
}

#[tokio::test]
async fn neither_same_origin_nor_cross_origin_nor_downgrade_redirect_is_followed() {
    let target = MockServer::stats(VALID_CERT).await;
    for location in [
        "/redirect-target".to_owned(),
        format!("{}/system_stats", target.base),
        format!("{}/system_stats", target.base.replace("https:", "http:")),
    ] {
        let server = MockServer::new(
            VALID_CERT,
            Arc::new(move |_| {
                let location = location.clone();
                Box::pin(async move { MockResponse::redirect(location) })
            }),
        )
        .await;
        let (_root, service) = service();
        service
            .approve(&server.base, &info(&server.base, VALID_CERT))
            .unwrap();
        assert!(!connects(&service, &server.base).await);
        assert_eq!(server.recorded().len(), 1);
        assert_eq!(server.recorded()[0].target, "/system_stats");
    }
    assert!(target.recorded().is_empty());
}

#[tokio::test]
async fn full_generation_keeps_proxy_prefix_and_encodes_prompt_id_and_image_queries() {
    let server = MockServer::new(
        VALID_CERT,
        Arc::new(|request| {
            Box::pin(async move {
                if request.target == "/proxy/comfy/prompt" {
                    MockResponse::ok(r#"{"prompt_id":"tls-job /?#"}"#)
                } else if request.target.starts_with("/proxy/comfy/history/") {
                    MockResponse::ok(history("tls-job /?#"))
                } else if request.target.starts_with("/proxy/comfy/view?") {
                    MockResponse::ok(PNG)
                } else {
                    MockResponse {
                        status: 404,
                        body: b"bad proxy route".to_vec(),
                        headers: Vec::new(),
                        body_gate: None,
                    }
                }
            })
        }),
    )
    .await;
    let (_root, service) = service();
    let address = format!("{}/proxy/comfy", server.base);
    service
        .approve(&address, &info(&address, VALID_CERT))
        .unwrap();
    let image = timeout(
        Duration::from_secs(5),
        service
            .client_for(Some(address))
            .unwrap()
            .generate_image_base64("封面", "blur", 256, 256),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        image,
        format!("data:image/png;base64,{}", STANDARD.encode(PNG))
    );
    let requests = server.recorded();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0].method, "POST");
    assert_eq!(requests[0].target, "/proxy/comfy/prompt");
    let body: Value = serde_json::from_slice(&requests[0].body).unwrap();
    assert_eq!(body["prompt"]["45"]["inputs"]["text"], "封面");
    assert_eq!(body["prompt"]["41"]["inputs"]["width"], 256);
    assert!(
        requests[1].target.contains("tls-job%20%2F%3F%23"),
        "unescaped prompt id: {}",
        requests[1].target
    );
    let url = reqwest::Url::parse(&format!("{}{}", server.base, requests[2].target)).unwrap();
    let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(url.path(), "/proxy/comfy/view");
    assert_eq!(query.get("filename").unwrap(), "封面 &?#.png");
    assert_eq!(query.get("subfolder").unwrap(), "作品/封面");
    assert_eq!(query.get("type").unwrap(), "output");
}

#[tokio::test]
async fn revoke_blocks_an_old_client_and_its_previously_pooled_tls_connection() {
    let server = MockServer::stats(VALID_CERT).await;
    let (_root, service) = service();
    service
        .approve(&server.base, &info(&server.base, VALID_CERT))
        .unwrap();
    let client = service.client_for(Some(server.base.clone())).unwrap();
    assert!(client.test_connection().await.unwrap());
    assert_eq!(server.recorded().len(), 1);
    service.revoke(&server.base).unwrap();
    assert!(client.test_connection().await.is_err());
    assert!(!connects(&service, &server.base).await);
    assert_eq!(server.recorded().len(), 1);
}

#[tokio::test]
async fn replacing_approval_also_fences_a_preexisting_client() {
    let server = MockServer::stats(VALID_CERT).await;
    let (_root, service) = service();
    let approved = info(&server.base, VALID_CERT);
    service.approve(&server.base, &approved).unwrap();
    let old = service.client_for(Some(server.base.clone())).unwrap();
    service.approve(&server.base, &approved).unwrap();
    assert!(old.test_connection().await.is_err());
    assert!(server.recorded().is_empty());
    assert!(connects(&service, &server.base).await);
}

#[tokio::test]
async fn revoke_cancels_inflight_health_request_instead_of_reporting_success() {
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let started_handler = started.clone();
    let release_handler = release.clone();
    let server = MockServer::new(
        VALID_CERT,
        Arc::new(move |_| {
            let started = started_handler.clone();
            let release = release_handler.clone();
            Box::pin(async move {
                started.notify_one();
                release.notified().await;
                MockResponse::ok(STATS)
            })
        }),
    )
    .await;
    let (_root, service) = service();
    service
        .approve(&server.base, &info(&server.base, VALID_CERT))
        .unwrap();
    let client = service.client_for(Some(server.base.clone())).unwrap();
    let pending = tokio::spawn(async move { client.test_connection().await });
    timeout(Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    service.revoke(&server.base).unwrap();
    // Keep server blocked: the cancelled request must finish without receiving its response.
    let result = timeout(Duration::from_secs(2), pending)
        .await
        .expect("revocation must cancel blocked send")
        .unwrap();
    assert!(result.is_err());
    release.notify_waiters();
}

#[tokio::test]
async fn revoke_cancels_response_body_read_even_after_successful_tls_and_http_headers() {
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let started_handler = started.clone();
    let release_handler = release.clone();
    let server = MockServer::new(
        VALID_CERT,
        Arc::new(move |_| {
            let started = started_handler.clone();
            let release = release_handler.clone();
            Box::pin(async move {
                let mut response = MockResponse::ok(STATS);
                response.body_gate = Some((started, release));
                response
            })
        }),
    )
    .await;
    let (_root, service) = service();
    service
        .approve(&server.base, &info(&server.base, VALID_CERT))
        .unwrap();
    let client = service.client_for(Some(server.base.clone())).unwrap();
    let pending = tokio::spawn(async move { client.test_connection().await });
    timeout(Duration::from_secs(5), started.notified())
        .await
        .unwrap();
    service.revoke(&server.base).unwrap();
    assert!(timeout(Duration::from_secs(2), pending)
        .await
        .expect("revocation must cancel blocked body read")
        .unwrap()
        .is_err());
    release.notify_waiters();
}

#[tokio::test]
async fn revoke_during_history_blocks_the_following_image_download() {
    let history_started = Arc::new(Notify::new());
    let history_release = Arc::new(Notify::new());
    let started_handler = history_started.clone();
    let release_handler = history_release.clone();
    let server = MockServer::new(
        VALID_CERT,
        Arc::new(move |request| {
            let started = started_handler.clone();
            let release = release_handler.clone();
            Box::pin(async move {
                if request.target == "/prompt" {
                    MockResponse::ok(r#"{"prompt_id":"tls-job"}"#)
                } else if request.target == "/history/tls-job" {
                    started.notify_one();
                    release.notified().await;
                    MockResponse::ok(history("tls-job"))
                } else {
                    MockResponse::ok(PNG)
                }
            })
        }),
    )
    .await;
    let (_root, service) = service();
    service
        .approve(&server.base, &info(&server.base, VALID_CERT))
        .unwrap();
    let client = service.client_for(Some(server.base.clone())).unwrap();
    let pending =
        tokio::spawn(async move { client.generate_image_base64("cover", "", 256, 256).await });
    timeout(Duration::from_secs(5), history_started.notified())
        .await
        .unwrap();
    service.revoke(&server.base).unwrap();
    history_release.notify_waiters();
    assert!(timeout(Duration::from_secs(2), pending)
        .await
        .unwrap()
        .unwrap()
        .is_err());
    assert!(server
        .recorded()
        .iter()
        .all(|r| !r.target.starts_with("/view")));
}

#[tokio::test]
async fn approval_survives_reopen_in_separate_store_but_revoke_survives_it_too() {
    let server = MockServer::stats(VALID_CERT).await;
    let (root, service) = service();
    service
        .approve(&server.base, &info(&server.base, VALID_CERT))
        .unwrap();
    let reopened = ComfyTrustService::new(root.path().to_path_buf());
    assert!(reopened.get_approval(&server.base).unwrap().is_some());
    assert!(connects(&reopened, &server.base).await);
    reopened.revoke(&server.base).unwrap();
    let third = ComfyTrustService::new(root.path().to_path_buf());
    assert!(third.get_approval(&server.base).unwrap().is_none());
    assert!(!connects(&third, &server.base).await);
}

#[test]
fn new_store_does_not_create_or_touch_a_database() {
    let root = tempfile::tempdir().unwrap();
    let store_root = root.path().join("private-cert-authority");
    let service = ComfyTrustService::new(store_root.clone());
    assert!(service
        .get_approval("https://localhost:8188")
        .unwrap()
        .is_none());
    assert!(!store_root.exists());
    assert!(root.path().read_dir().unwrap().next().is_none());
}

#[test]
fn malformed_certificate_der_or_unbound_metadata_cannot_be_approved() {
    let (_root, service) = service();
    let base = "https://127.0.0.1:12345";
    let valid = info(base, VALID_CERT);
    for encoded in [
        "garbage".to_owned(),
        STANDARD.encode([der(VALID_CERT), vec![1]].concat()),
        STANDARD.encode([der(VALID_CERT), der(VALID_CERT)].concat()),
    ] {
        let mut invalid = valid.clone();
        invalid.certificate_der_base64 = encoded;
        assert!(service.approve(base, &invalid).is_err());
    }
    assert!(service.approve("https://localhost:12345", &valid).is_err());
    assert!(service.approve("http://127.0.0.1:12345", &valid).is_err());
    assert!(service.get_approval(base).unwrap().is_none());
}

#[test]
fn untrusted_display_metadata_cannot_override_the_certificate_contents() {
    let (_root, service) = service();
    let base = "https://127.0.0.1:12345";
    let valid = info(base, VALID_CERT);
    for invalid in [
        ComfyCertificateInfo {
            subject: "different subject".into(),
            ..valid.clone()
        },
        ComfyCertificateInfo {
            issuer: "different issuer".into(),
            ..valid.clone()
        },
        ComfyCertificateInfo {
            not_after_epoch_ms: valid.not_after_epoch_ms + 1,
            ..valid.clone()
        },
        ComfyCertificateInfo {
            not_before_epoch_ms: valid.not_before_epoch_ms - 1,
            ..valid.clone()
        },
    ] {
        assert!(service.approve(base, &invalid).is_err());
    }
    assert!(service.get_approval(base).unwrap().is_none());
}

#[test]
fn oversized_duplicate_and_noncanonical_store_records_fail_closed() {
    let base = "https://127.0.0.1:12345";
    let valid = info(base, VALID_CERT);
    let record = json!({"origin": valid.origin, "certificateSha256": valid.certificate_sha256, "certificateDerBase64": valid.certificate_der_base64});
    let mut noncanonical = record.clone();
    noncanonical["origin"] = json!("https://127.0.0.1:12345/proxy");
    for bytes in [
        vec![b' '; 1_048_577],
        json!({"version": 1, "records": [record.clone(), record.clone()]})
            .to_string()
            .into_bytes(),
        json!({"version": 1, "records": vec![record; 33]})
            .to_string()
            .into_bytes(),
        json!({"version": 1, "records": [noncanonical]})
            .to_string()
            .into_bytes(),
    ] {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("certificates.json");
        std::fs::write(&file, &bytes).unwrap();
        let service = ComfyTrustService::new(root.path().to_path_buf());
        assert!(service.get_approval(base).is_err());
        assert!(service.client_for(Some(base.to_owned())).is_err());
        assert_eq!(std::fs::read(file).unwrap(), bytes);
    }
}

#[tokio::test]
async fn successful_status_with_html_or_non_comfy_json_is_not_connection_success() {
    for body in ["<html>Login required</html>", r#"{"ok":true}"#] {
        let body = body.to_owned();
        let server = MockServer::new(
            VALID_CERT,
            Arc::new(move |_| {
                let body = body.clone();
                Box::pin(async move { MockResponse::ok(body) })
            }),
        )
        .await;
        let (_root, service) = service();
        service
            .approve(&server.base, &info(&server.base, VALID_CERT))
            .unwrap();
        assert!(!connects(&service, &server.base).await);
        assert_eq!(server.recorded().len(), 1);
    }
}

#[tokio::test]
async fn ordinary_http_remains_usable_but_tunnel_errors_suggest_https_without_following_it() {
    for (status, body, location, succeeds, suggests_https) in [
        (200, STATS, None, true, false),
        (501, "SakuraFrp requires HTTPS", None, false, true),
        (302, "redirect", Some("/redirect-target"), false, true),
        (404, "not found", None, false, false),
    ] {
        let server = MockServer::plain_http(status, body, location).await;
        let (_root, service) = service();
        let client = service.client_for(Some(server.base.clone())).unwrap();
        let result = timeout(Duration::from_secs(5), client.diagnose_connection())
            .await
            .unwrap();
        assert_eq!(result.success, succeeds, "HTTP {}", status);
        assert_eq!(
            result.suggested_url.is_some(),
            suggests_https,
            "HTTP {}",
            status
        );
        if let Some(url) = result.suggested_url {
            assert_eq!(url, server.base.replace("http:", "https:"));
        }
        assert_eq!(
            server.recorded().len(),
            1,
            "diagnosis must not follow redirects"
        );
        assert_eq!(server.recorded()[0].target, "/system_stats");
        assert!(service.get_approval(&server.base).unwrap().is_none());
    }
}

#[test]
fn corrupt_store_unknown_version_and_invalid_record_fail_closed_without_repairing_bytes() {
    let base = "https://127.0.0.1:12345";
    let valid = info(base, VALID_CERT);
    let record = json!({"origin": valid.origin, "certificateSha256": valid.certificate_sha256, "certificateDerBase64": valid.certificate_der_base64});
    for bytes in [
        b"not-json".to_vec(),
        json!({"version": 999, "records": []}).to_string().into_bytes(),
        json!({"version": 1, "records": [{"origin": base, "certificateSha256": "not-hash", "certificateDerBase64": "bad"}]}).to_string().into_bytes(),
        json!({"version": 1, "records": [record, {"origin": "https://localhost:12345", "certificateSha256": "00".repeat(32), "certificateDerBase64": "bad"}]}).to_string().into_bytes(),
    ] {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("certificates.json");
        std::fs::write(&file, &bytes).unwrap();
        let service = ComfyTrustService::new(root.path().to_path_buf());
        assert!(service.get_approval(base).is_err());
        assert!(service.approve(base, &info(base, VALID_CERT)).is_err());
        assert_eq!(std::fs::read(&file).unwrap(), bytes);
    }
}

#[tokio::test]
async fn failed_revocation_write_denies_old_authority_in_memory_and_cancels_old_client() {
    let server = MockServer::stats(VALID_CERT).await;
    let (root, service) = service();
    service
        .approve(&server.base, &info(&server.base, VALID_CERT))
        .unwrap();
    let client = service.client_for(Some(server.base.clone())).unwrap();
    let file = root.path().join("certificates.json");
    let original = std::fs::read(&file).unwrap();
    // Windows: allow reading but not replacement or deletion of the authoritative file. This
    // forces a real atomic-persist failure after the revoke has read otherwise valid records.
    #[cfg(windows)]
    let _locked = {
        use std::os::windows::fs::OpenOptionsExt;
        std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&file)
            .unwrap()
    };
    // Other platforms have no Windows share lock; exercise the same in-process fail-closed
    // boundary using an unreadable-authority directory, keeping the historical bytes separately.
    #[cfg(not(windows))]
    let preserved = {
        let preserved = root.path().join("certificates.json.saved");
        std::fs::rename(&file, &preserved).unwrap();
        std::fs::create_dir(&file).unwrap();
        std::fs::write(file.join("blocker"), b"fixture").unwrap();
        preserved
    };
    assert!(service.revoke(&server.base).is_err());
    assert!(service.get_approval(&server.base).unwrap().is_none());
    assert!(client.test_connection().await.is_err());
    assert!(!connects(&service, &server.base).await);
    #[cfg(windows)]
    assert_eq!(std::fs::read(&file).unwrap(), original);
    #[cfg(not(windows))]
    assert_eq!(std::fs::read(preserved).unwrap(), original);
    assert!(server.recorded().is_empty());
    assert!(service
        .approve(&server.base, &info(&server.base, VALID_CERT))
        .is_err());
    assert!(service.get_approval(&server.base).unwrap().is_none());
}

/// Explicitly opt-in live acceptance. The verified hash must come from an independently checked
/// tunnel public certificate, not from the inspector's own observed output. No user hostname or
/// production certificate is compiled into this test. Run at most once with generation enabled.
#[tokio::test]
#[ignore = "requires COMFY_TEST_ORIGIN and independently verified COMFY_VERIFIED_SHA256; COMFY_GENERATE=1 optionally runs one small image"]
async fn comfy_live_verified_origin_connection_and_optional_small_image() {
    let address = std::env::var("COMFY_TEST_ORIGIN").expect("COMFY_TEST_ORIGIN required");
    let fingerprint = std::env::var("COMFY_VERIFIED_SHA256")
        .expect("independently verified COMFY_VERIFIED_SHA256 required")
        .replace(':', "")
        .to_ascii_lowercase();
    assert_eq!(fingerprint.len(), 64);
    assert!(fingerprint.bytes().all(|b| b.is_ascii_hexdigit()));
    let (_root, service) = service();
    let observed = service.inspect_certificate(&address).await.unwrap();
    assert_eq!(
        observed.certificate_sha256, fingerprint,
        "public peer does not match independent certificate"
    );
    assert!(
        !connects(&service, &address).await,
        "this opt-in test expects a self-signed tunnel"
    );
    service.approve(&address, &observed).unwrap();
    assert!(connects(&service, &address).await);
    let client = service.client_for(Some(address.clone())).unwrap();
    if std::env::var("COMFY_GENERATE").as_deref() == Ok("1") {
        let image = timeout(
            Duration::from_secs(300),
            client.generate_image_base64(
                "A blue ceramic cup on a plain wooden table, soft natural lighting, no text",
                "text, watermark, blur",
                256,
                256,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        let encoded = image
            .strip_prefix("data:image/png;base64,")
            .expect("expected PNG result");
        let png = STANDARD.decode(encoded).unwrap();
        assert!(png.starts_with(b"\x89PNG\r\n\x1a\n"));
        assert!(png.len() > 24);
        assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 256);
        assert_eq!(u32::from_be_bytes(png[20..24].try_into().unwrap()), 256);
        if let Ok(path) = std::env::var("COMFY_TEST_PNG") {
            let path = std::path::PathBuf::from(path);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::write(path, &png).unwrap();
        }
        println!(
            "Live public-origin prompt/history/download accepted: 256x256 PNG, {} bytes",
            png.len()
        );
    }
    service.revoke(&address).unwrap();
    assert!(client.test_connection().await.is_err());
    assert!(!connects(&service, &address).await);
}
