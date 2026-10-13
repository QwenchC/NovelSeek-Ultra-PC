//! Device-local, explicit certificate authorization for ComfyUI only.
//! A captured certificate is NOT trusted until the user verifies its fingerprint.
//! Normal HTTPS uses the operating-system trust store; authorized self-signed
//! certificates retain WebPKI name, time, usage, signature and exact-leaf checks.
use super::comfyui::ComfyUIClient;
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::{redirect::Policy, Client, Url};
use rustls::client::{ServerCertVerified, ServerCertVerifier, WebPkiVerifier};
use rustls::{Certificate, ClientConfig, RootCertStore, ServerName};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::future::Future;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tokio::net::TcpStream;
use tokio::sync::watch;
use tokio_rustls::TlsConnector;
use x509_parser::parse_x509_certificate;

const MAX_STORE_BYTES: u64 = 1_048_576;
const MAX_CERT_BYTES: usize = 16_384;
const MAX_RECORDS: usize = 32;
const REVOKED_MESSAGE: &str = "ComfyUI 证书授权已撤销或替换，请重新发起请求。";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComfyCertificateInfo {
    pub origin: String,
    pub certificate_sha256: String,
    pub certificate_der_base64: String,
    pub subject: String,
    pub issuer: String,
    pub not_before_epoch_ms: i64,
    pub not_after_epoch_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ComfyCertificateApproval {
    pub origin: String,
    pub certificate_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustRecord {
    origin: String,
    certificate_sha256: String,
    certificate_der_base64: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct TrustFile {
    version: u32,
    records: Vec<TrustRecord>,
}

struct ServiceState {
    // A failed durable revoke must still deny old on-disk authority in this process.
    denied_origins: HashSet<String>,
    revision: u64,
}

pub struct ComfyTrustService {
    root: PathBuf,
    state: Mutex<ServiceState>,
    revisions: watch::Sender<u64>,
}

impl ComfyTrustService {
    /// Do not fail application startup or create files for an unused feature.
    pub fn new(root: PathBuf) -> Self {
        let (revisions, _) = watch::channel(0);
        Self {
            root,
            state: Mutex::new(ServiceState {
                denied_origins: HashSet::new(),
                revision: 0,
            }),
            revisions,
        }
    }

    fn read_records(&self) -> Result<Vec<TrustRecord>> {
        let path = self.root.join("certificates.json");
        let source = match std::fs::File::open(&path) {
            Ok(value) => value,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e).context("无法读取本机 ComfyUI 证书授权"),
        };
        let metadata = source.metadata()?;
        if !metadata.is_file() || metadata.len() > MAX_STORE_BYTES {
            return Err(anyhow!("本机 ComfyUI 证书授权文件无效；已停止使用该文件。"));
        }
        let mut bytes = Vec::new();
        source.take(MAX_STORE_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_STORE_BYTES {
            return Err(anyhow!("本机 ComfyUI 证书授权文件过大。"));
        }
        let file: TrustFile = serde_json::from_slice(&bytes)
            .context("本机 ComfyUI 证书授权文件损坏；已停止使用该文件。")?;
        if file.version != 1 || file.records.len() > MAX_RECORDS {
            return Err(anyhow!("本机 ComfyUI 证书授权版本或数量无效。"));
        }
        let mut origins = HashSet::new();
        for record in &file.records {
            validate_record(record)?;
            if !origins.insert(&record.origin) {
                return Err(anyhow!("本机 ComfyUI 证书授权包含重复服务器。"));
            }
        }
        Ok(file.records)
    }

    fn write_records(&self, records: Vec<TrustRecord>) -> Result<()> {
        std::fs::create_dir_all(&self.root).context("无法创建本机 ComfyUI 证书授权目录")?;
        let bytes = serde_json::to_vec(&TrustFile {
            version: 1,
            records,
        })?;
        if bytes.len() as u64 > MAX_STORE_BYTES {
            return Err(anyhow!("ComfyUI 证书授权文件过大"));
        }
        // NamedTempFile::persist performs an atomic replace on Windows and Unix;
        // the original remains intact if writing or replacing fails.
        let mut temporary = tempfile::NamedTempFile::new_in(&self.root)?;
        temporary.write_all(&bytes)?;
        temporary.as_file().sync_all()?;
        temporary
            .persist(self.root.join("certificates.json"))
            .map_err(|e| anyhow!("无法原子保存 ComfyUI 证书授权: {}", e.error))?;
        Ok(())
    }

    pub fn get_approval(&self, base_url: &str) -> Result<Option<ComfyCertificateApproval>> {
        let url = normalize_base_url(base_url)?;
        if url.scheme() != "https" {
            return Ok(None);
        }
        let origin = origin_for(&url)?;
        let state = self
            .state
            .lock()
            .map_err(|_| anyhow!("ComfyUI 授权锁失效"))?;
        if state.denied_origins.contains(&origin) {
            return Ok(None);
        }
        Ok(self
            .read_records()?
            .into_iter()
            .find(|r| r.origin == origin)
            .map(|r| ComfyCertificateApproval {
                origin: r.origin,
                certificate_sha256: r.certificate_sha256,
            }))
    }

    pub fn approve(
        &self,
        base_url: &str,
        certificate: &ComfyCertificateInfo,
    ) -> Result<ComfyCertificateApproval> {
        let origin = origin_for(&normalize_base_url(base_url)?)?;
        if origin != certificate.origin {
            return Err(anyhow!("待授权证书与当前 HTTPS 服务器地址不一致。"));
        }
        let record = TrustRecord {
            origin: origin.clone(),
            certificate_sha256: certificate.certificate_sha256.clone(),
            certificate_der_base64: certificate.certificate_der_base64.clone(),
        };
        let der = validate_record(&record)?;
        if certificate_info(&origin, &der)? != *certificate {
            return Err(anyhow!("证书显示信息与证书内容不一致。"));
        }
        // Validate the actual certificate's hostname, validity and server usage
        // before saving authority, not the untrusted values supplied by the UI.
        verify_approved_certificate(&origin, &der, SystemTime::now())?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("ComfyUI 授权锁失效"))?;
        let mut records = self.read_records()?;
        records.retain(|r| r.origin != origin);
        if records.len() >= MAX_RECORDS {
            return Err(anyhow!("最多保存 32 个本机 ComfyUI 证书授权。"));
        }
        records.push(record);
        self.write_records(records)?;
        state.denied_origins.remove(&origin);
        self.invalidate(&mut state);
        Ok(ComfyCertificateApproval {
            origin,
            certificate_sha256: certificate.certificate_sha256.clone(),
        })
    }

    pub fn revoke(&self, base_url: &str) -> Result<()> {
        let origin = origin_for(&normalize_base_url(base_url)?)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| anyhow!("ComfyUI 授权锁失效"))?;
        state.denied_origins.insert(origin.clone());
        self.invalidate(&mut state);
        let durable = (|| {
            let mut records = self.read_records()?;
            records.retain(|r| r.origin != origin);
            self.write_records(records)
        })();
        durable.map_err(|e| anyhow!(
            "COMFY_REVOKE_NOT_DURABLE: 本进程已停止使用证书授权，但无法保存撤销；请重试，重启后可能恢复旧授权。 {}", e
        ))
    }

    fn invalidate(&self, state: &mut ServiceState) {
        state.revision = state.revision.wrapping_add(1);
        self.revisions.send_replace(state.revision);
    }

    /// Snapshot disk authority and its revision under one lock; never attach a
    /// stale certificate to a new authorization revision during replacement.
    pub fn client_for(&self, base_url: Option<String>) -> Result<ComfyUIClient> {
        let url = normalize_base_url(base_url.as_deref().unwrap_or("http://localhost:8188"))?;
        let state = self
            .state
            .lock()
            .map_err(|_| anyhow!("ComfyUI 授权锁失效"))?;
        let mut approved = None;
        if url.scheme() == "https" {
            let origin = origin_for(&url)?;
            if !state.denied_origins.contains(&origin) {
                approved = self
                    .read_records()?
                    .into_iter()
                    .find(|r| r.origin == origin);
            }
        }
        let lease = ComfyRequestLease {
            revision: state.revision,
            revisions: self.revisions.subscribe(),
            certificate: approved.as_ref().map(validate_record).transpose()?,
        };
        let client = build_http_client(approved.as_ref())?;
        Ok(ComfyUIClient::from_transport(client, url, Some(lease)))
    }

    pub async fn inspect_certificate(&self, base_url: &str) -> Result<ComfyCertificateInfo> {
        inspect_certificate(base_url).await
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ComfyRequestLease {
    revision: u64,
    revisions: watch::Receiver<u64>,
    certificate: Option<Vec<u8>>,
}

impl ComfyRequestLease {
    fn ensure_current(&self) -> Result<()> {
        if *self.revisions.borrow() != self.revision {
            return Err(anyhow!(REVOKED_MESSAGE));
        }
        if let Some(der) = &self.certificate {
            let (_, certificate) = parse_x509_certificate(der)
                .map_err(|_| anyhow!("授权的 ComfyUI 证书格式已失效"))?;
            if !certificate.validity().is_valid() {
                return Err(anyhow!(
                    "授权的 ComfyUI 证书已过期或尚未生效，请核对服务器证书。"
                ));
            }
        }
        Ok(())
    }

    pub(crate) async fn run<F, T>(&self, future: F) -> Result<T>
    where
        F: Future<Output = Result<T>>,
    {
        self.ensure_current()?;
        let mut receiver = self.revisions.clone();
        let result = tokio::select! {
            biased;
            _ = receiver.changed() => Err(anyhow!(REVOKED_MESSAGE)),
            result = future => result,
        };
        self.ensure_current()?;
        result
    }
}

/// Reject credentials and ambiguous URL decorations. A bare host:port remains
/// plain HTTP until the user explicitly chooses HTTPS (no silent downgrade).
pub(crate) fn normalize_base_url(input: &str) -> Result<Url> {
    let input = input.trim();
    if input.is_empty() {
        return Err(anyhow!("请输入 ComfyUI 服务器地址。"));
    }
    if input
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '\\')
    {
        return Err(anyhow!("ComfyUI 地址不能包含空白、控制字符或反斜杠。"));
    }
    let value = if input.contains("://") {
        input.to_owned()
    } else {
        format!("http://{}", input)
    };
    if value
        .split("://")
        .nth(1)
        .and_then(|v| v.split('/').next())
        .map(|v| v.contains('@'))
        .unwrap_or(false)
    {
        return Err(anyhow!("ComfyUI 地址不能包含账号或密码。"));
    }
    let mut url = Url::parse(&value).context("ComfyUI 地址格式无效")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.port() == Some(0)
    {
        return Err(anyhow!(
            "ComfyUI 地址只支持 HTTP/HTTPS，不允许账号、密码、查询参数或片段。"
        ));
    }
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(if path.is_empty() { "/" } else { &path });
    Ok(url)
}

pub(crate) fn origin_for(url: &Url) -> Result<String> {
    if url.scheme() != "https" {
        return Err(anyhow!("证书授权只支持明确的 HTTPS 地址。"));
    }
    Ok(url.origin().ascii_serialization())
}

pub(crate) fn certificate_info(origin: &str, der: &[u8]) -> Result<ComfyCertificateInfo> {
    if der.is_empty() || der.len() > MAX_CERT_BYTES {
        return Err(anyhow!("服务器证书大小无效。"));
    }
    let (rest, parsed) = parse_x509_certificate(der).map_err(|_| anyhow!("服务器证书无法解析"))?;
    if !rest.is_empty() {
        return Err(anyhow!("服务器证书包含多余数据"));
    }
    Ok(ComfyCertificateInfo {
        origin: origin.to_owned(),
        certificate_sha256: format!("{:x}", Sha256::digest(der)),
        certificate_der_base64: STANDARD.encode(der),
        subject: parsed.subject().to_string(),
        issuer: parsed.issuer().to_string(),
        not_before_epoch_ms: parsed
            .validity()
            .not_before
            .timestamp()
            .checked_mul(1000)
            .ok_or_else(|| anyhow!("证书生效时间无效"))?,
        not_after_epoch_ms: parsed
            .validity()
            .not_after
            .timestamp()
            .checked_mul(1000)
            .ok_or_else(|| anyhow!("证书失效时间无效"))?,
    })
}

fn validate_record(record: &TrustRecord) -> Result<Vec<u8>> {
    let url = normalize_base_url(&record.origin)?;
    if record.origin != origin_for(&url)? || url.path() != "/" {
        return Err(anyhow!("本机证书授权地址不是规范的 HTTPS origin"));
    }
    if record.certificate_der_base64.len() > MAX_CERT_BYTES * 2 {
        return Err(anyhow!("本机证书授权内容过大"));
    }
    let der = STANDARD
        .decode(&record.certificate_der_base64)
        .context("本机证书授权内容无效")?;
    let info = certificate_info(&record.origin, &der)?;
    if info.certificate_sha256 != record.certificate_sha256 {
        return Err(anyhow!("本机证书 SHA-256 与证书内容不符"));
    }
    Ok(der)
}

fn verifier_for(der: &[u8]) -> Result<WebPkiVerifier> {
    let mut roots = RootCertStore::empty();
    roots
        .add(&Certificate(der.to_vec()))
        .map_err(|e| anyhow!("授权证书无法作为信任锚: {}", e))?;
    Ok(WebPkiVerifier::new(roots, None))
}

fn verify_approved_certificate(origin: &str, der: &[u8], now: SystemTime) -> Result<()> {
    let url = normalize_base_url(origin)?;
    let host = tls_host(&url)?;
    let name = ServerName::try_from(host.as_str()).map_err(|_| anyhow!("TLS 服务器域名无效"))?;
    verifier_for(der)?
        .verify_server_cert(
            &Certificate(der.to_vec()),
            &[],
            &name,
            &mut std::iter::empty(),
            &[],
            now,
        )
        .map_err(|e| anyhow!("服务器证书域名、有效期或签名验证失败: {}", e))?;
    Ok(())
}

fn tls_host(url: &Url) -> Result<String> {
    let host = url.host_str().ok_or_else(|| anyhow!("缺少服务器域名"))?;
    // URL IPv6 hosts have brackets; socket resolution and rustls ServerName
    // expect the address itself. Do not alter domains or bypass SAN matching.
    Ok(host
        .strip_prefix('[')
        .and_then(|v| v.strip_suffix(']'))
        .unwrap_or(host)
        .to_owned())
}

struct PinnedVerifier {
    verifier: WebPkiVerifier,
    exact_der: Vec<u8>,
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &Certificate,
        intermediates: &[Certificate],
        server_name: &ServerName,
        scts: &mut dyn Iterator<Item = &[u8]>,
        ocsp_response: &[u8],
        now: SystemTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        if end_entity.0 != self.exact_der {
            return Err(rustls::Error::General(
                "ComfyUI 服务器证书已改变；请重新独立核对指纹。".to_owned(),
            ));
        }
        // Not a trust-all verifier: delegate full chain/name/validity checks,
        // and retain rustls's default TLS handshake signature verification.
        self.verifier.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            scts,
            ocsp_response,
            now,
        )
    }
}

fn build_http_client(approval: Option<&TrustRecord>) -> Result<Client> {
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(300))
        .connect_timeout(Duration::from_secs(10))
        .redirect(Policy::none());
    if let Some(record) = approval {
        let der = validate_record(record)?;
        verify_approved_certificate(&record.origin, &der, SystemTime::now())?;
        let verifier = PinnedVerifier {
            verifier: verifier_for(&der)?,
            exact_der: der,
        };
        let mut config = ClientConfig::builder()
            .with_safe_defaults()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth();
        // Every new TLS connection must present the exact approved certificate;
        // resumption would otherwise authenticate a saved session without a new
        // certificate message and could conceal same-key certificate rotation.
        config.resumption = rustls::client::Resumption::disabled();
        builder = builder.use_preconfigured_tls(config);
    }
    // Intentionally keep native/platform trust for the normal client. A builder
    // failure is an error; never replace it with a less strict fallback client.
    builder.build().context("无法创建安全的 ComfyUI 连接")
}

pub(crate) fn default_http_client() -> Result<Client> {
    build_http_client(None)
}

struct InspectionVerifier {
    captured: Arc<Mutex<Option<Vec<u8>>>>,
}

impl ServerCertVerifier for InspectionVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &Certificate,
        _intermediates: &[Certificate],
        _server_name: &ServerName,
        _scts: &mut dyn Iterator<Item = &[u8]>,
        _ocsp_response: &[u8],
        _now: SystemTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        if end_entity.0.len() <= MAX_CERT_BYTES {
            if let Ok(mut captured) = self.captured.lock() {
                *captured = Some(end_entity.0.clone());
            }
        }
        // Capture only. The handshake MUST abort: no HTTP, cookie, prompt,
        // credentials or successful TLS session can ever follow this path.
        Err(rustls::Error::General(
            "certificate inspection only; never authorized".to_owned(),
        ))
    }
}

async fn inspect_certificate(base_url: &str) -> Result<ComfyCertificateInfo> {
    let url = normalize_base_url(base_url)?;
    let origin = origin_for(&url)?;
    let host = tls_host(&url)?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| anyhow!("缺少服务器端口"))?;
    let server_name =
        ServerName::try_from(host.as_str()).map_err(|_| anyhow!("TLS 服务器域名无效"))?;
    let captured = Arc::new(Mutex::new(None));
    let config = ClientConfig::builder()
        .with_safe_defaults()
        .with_custom_certificate_verifier(Arc::new(InspectionVerifier {
            captured: captured.clone(),
        }))
        .with_no_client_auth();
    let connector = TlsConnector::from(Arc::new(config));
    // Dropping timeout/future drops the TCP stream too; no detached inspection
    // worker can continue or emit application bytes after cancellation.
    let handshake = tokio::time::timeout(Duration::from_secs(15), async {
        let stream = TcpStream::connect((host.as_str(), port)).await?;
        connector.connect(server_name, stream).await
    })
    .await;
    let der = captured
        .lock()
        .map_err(|_| anyhow!("证书查看锁失效"))?
        .take();
    if let Some(der) = der {
        return certificate_info(&origin, &der);
    }
    match handshake {
        Err(_) => Err(anyhow!("查看服务器证书超时，请检查域名、端口及隧道。")),
        Ok(Err(e)) => Err(anyhow!("无法读取服务器 TLS 证书: {}", e)),
        // Unreachable with InspectionVerifier; fail closed if refactored.
        Ok(Ok(_)) => Err(anyhow!("查看证书时握手异常完成；未授权任何证书。")),
    }
}
