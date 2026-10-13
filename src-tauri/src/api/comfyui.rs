use super::comfy_tls::{default_http_client, normalize_base_url, ComfyRequestLease};
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose, Engine as _};
use reqwest::{Client, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::future::Future;
use std::time::{Duration, Instant};

/// ComfyUI HTTP client.
/// Submits a hardcoded z-image-turbo workflow with variable
/// positive/negative prompts and image dimensions.
#[derive(Debug, Clone)]
pub struct ComfyUIClient {
    client: Client,
    base_url: Url,
    lease: Option<ComfyRequestLease>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComfyConnectionResult {
    pub success: bool,
    pub message: String,
    pub normalized_url: String,
    pub suggested_url: Option<String>,
    pub certificate_inspection_available: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct PromptResponse {
    prompt_id: String,
}

#[derive(Debug, Deserialize)]
struct HistoryOutput {
    images: Vec<HistoryImage>,
}

#[derive(Debug, Deserialize)]
struct HistoryImage {
    filename: String,
    subfolder: String,
    #[serde(rename = "type")]
    image_type: String,
}

impl ComfyUIClient {
    pub fn new(base_url: Option<String>) -> Result<Self> {
        let url = normalize_base_url(base_url.as_deref().unwrap_or("http://localhost:8188"))?;
        Ok(Self::from_transport(default_http_client()?, url, None))
    }

    pub(crate) fn from_transport(
        client: Client,
        base_url: Url,
        lease: Option<ComfyRequestLease>,
    ) -> Self {
        Self {
            client,
            base_url,
            lease,
        }
    }

    async fn guarded<F, T>(&self, future: F) -> Result<T>
    where
        F: Future<Output = Result<T>>,
    {
        match &self.lease {
            Some(lease) => lease.run(future).await,
            None => future.await,
        }
    }

    fn endpoint(&self, segments: &[&str]) -> Result<Url> {
        let mut url = self.base_url.clone();
        {
            let mut path = url
                .path_segments_mut()
                .map_err(|_| anyhow!("ComfyUI 地址不能构造 API 路径"))?;
            path.pop_if_empty();
            for segment in segments {
                if *segment == "." || *segment == ".." {
                    return Err(anyhow!("ComfyUI 返回了不安全的 API 路径字段"));
                }
                path.push(segment);
            }
        }
        Ok(url)
    }

    /// A successful status alone is not proof of a ComfyUI API (many gateways
    /// return a 200 login/HTML page). Require its actual system/devices payload.
    pub async fn test_connection(&self) -> Result<bool> {
        let diagnostic = self.diagnose_connection().await;
        if diagnostic.success {
            Ok(true)
        } else {
            Err(anyhow!(diagnostic.message))
        }
    }

    pub async fn diagnose_connection(&self) -> ComfyConnectionResult {
        let mut result = ComfyConnectionResult {
            success: false,
            message: String::new(),
            normalized_url: self.base_url.as_str().trim_end_matches('/').to_owned(),
            suggested_url: None,
            certificate_inspection_available: false,
        };
        let check = async {
            let url = self.endpoint(&["system_stats"])?;
            let response = self
                .guarded(async {
                    Ok(self
                        .client
                        .get(url)
                        .timeout(Duration::from_secs(15))
                        .send()
                        .await?)
                })
                .await?;
            let status = response.status();
            let bytes = self
                .guarded(async {
                    let mut response = response;
                    let mut bytes = Vec::new();
                    while let Some(chunk) = response.chunk().await? {
                        if bytes.len() + chunk.len() > 1_048_576 {
                            return Err(anyhow!("ComfyUI 连接诊断响应过大"));
                        }
                        bytes.extend_from_slice(&chunk);
                    }
                    Ok(bytes)
                })
                .await?;
            Ok::<_, anyhow::Error>((status, bytes))
        }
        .await;
        match check {
            Ok((status, bytes)) => {
                let body = String::from_utf8_lossy(&bytes);
                if status != StatusCode::OK {
                    if self.base_url.scheme() == "http"
                        && (status == StatusCode::NOT_IMPLEMENTED
                            || body.to_ascii_lowercase().contains("https")
                            || status.is_redirection())
                    {
                        let mut suggested = self.base_url.clone();
                        if suggested.set_scheme("https").is_ok() {
                            result.suggested_url =
                                Some(suggested.as_str().trim_end_matches('/').to_owned());
                        }
                        result.message = format!("连接未通过（HTTP {}）。隧道可能要求 HTTPS；请明确切换地址并核对证书，程序不会自动信任或降级。", status.as_u16());
                    } else if status.is_redirection() {
                        result.message = format!("服务器返回重定向（HTTP {}），未跟随。请填写最终 ComfyUI 地址，避免授权发送到其他服务器。", status.as_u16());
                    } else {
                        result.message = format!(
                            "ComfyUI 接口返回 HTTP {}，请检查隧道、服务器与反向代理配置。",
                            status.as_u16()
                        );
                    }
                } else if serde_json::from_slice::<Value>(&bytes)
                    .ok()
                    .map(|v| {
                        v.get("system").map(Value::is_object).unwrap_or(false)
                            && v.get("devices").map(Value::is_array).unwrap_or(false)
                    })
                    .unwrap_or(false)
                {
                    result.success = true;
                    result.message =
                        "连接成功：已识别 ComfyUI API；模型和工作流兼容性需在生成时验证。"
                            .to_owned();
                } else {
                    result.message = "服务器返回内容不是 ComfyUI API；请检查是否连接到了登录页面、错误端口或代理网关。".to_owned();
                }
            }
            Err(error) => {
                let detail = format!("{:#}", error);
                let lower = detail.to_ascii_lowercase();
                if lower.contains("撤销") || lower.contains("替换") {
                    result.message = detail;
                } else if self.base_url.scheme() == "https"
                    && (lower.contains("certificate")
                        || lower.contains("证书")
                        || lower.contains("ssl")
                        || lower.contains("tls"))
                {
                    result.certificate_inspection_available = true;
                    result.message = format!("HTTPS 证书验证失败。自签名证书需先独立核对完整 SHA-256 再授权；域名不匹配、过期或证书变化不能忽略。 {}", detail);
                } else if lower.contains("dns")
                    || lower.contains("resolve")
                    || lower.contains("getaddrinfo")
                {
                    result.message =
                        "无法解析 ComfyUI 域名，请检查地址和网络 DNS 设置。".to_owned();
                } else if lower.contains("timed out") || lower.contains("timeout") {
                    result.message =
                        "连接 ComfyUI 超时，请检查公网端口、隧道状态和服务器是否正在运行。"
                            .to_owned();
                } else {
                    result.message = format!(
                        "无法连接 ComfyUI，请检查地址、端口、网络与隧道。 {}",
                        detail
                    );
                }
            }
        }
        result
    }

    /// Build the ComfyUI API-format prompt for the z-image-turbo workflow.
    /// LoRA node (48) is skipped; UNETLoader connects directly to ModelSamplingAuraFlow.
    fn build_prompt(&self, positive: &str, negative: &str, width: u32, height: u32) -> Value {
        let seed: u64 = rand_seed();
        json!({
            // Step 1 – Load models
            "46": {
                "class_type": "UNETLoader",
                "inputs": {
                    "unet_name": "z_image_turbo_bf16.safetensors",
                    "weight_dtype": "default"
                }
            },
            "39": {
                "class_type": "CLIPLoader",
                "inputs": {
                    "clip_name": "qwen_3_4b.safetensors",
                    "type": "lumina2",
                    "device": "default"
                }
            },
            "40": {
                "class_type": "VAELoader",
                "inputs": {
                    "vae_name": "ae.safetensors"
                }
            },
            // Step 2 – Sampling config (shift for AuraFlow-style scheduling)
            "47": {
                "class_type": "ModelSamplingAuraFlow",
                "inputs": {
                    "model": ["46", 0],
                    "shift": 3.0
                }
            },
            // Step 3 – Prompts
            "45": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "clip": ["39", 0],
                    "text": positive
                }
            },
            "61": {
                "class_type": "CLIPTextEncode",
                "inputs": {
                    "clip": ["39", 0],
                    "text": negative
                }
            },
            // Step 4 – Latent canvas
            "41": {
                "class_type": "EmptySD3LatentImage",
                "inputs": {
                    "width": width,
                    "height": height,
                    "batch_size": 1
                }
            },
            // KSampler
            "44": {
                "class_type": "KSampler",
                "inputs": {
                    "model": ["47", 0],
                    "positive": ["45", 0],
                    "negative": ["61", 0],
                    "latent_image": ["41", 0],
                    "seed": seed,
                    "steps": 6,
                    "cfg": 1.0,
                    "sampler_name": "dpmpp_2m_sde_gpu",
                    "scheduler": "simple",
                    "denoise": 1.0
                }
            },
            // Decode + Save
            "43": {
                "class_type": "VAEDecode",
                "inputs": {
                    "samples": ["44", 0],
                    "vae": ["40", 0]
                }
            },
            "9": {
                "class_type": "SaveImage",
                "inputs": {
                    "images": ["43", 0],
                    "filename_prefix": "novelseek"
                }
            }
        })
    }

    /// Submit the prompt and return the prompt_id.
    async fn submit_prompt(
        &self,
        positive: &str,
        negative: &str,
        width: u32,
        height: u32,
    ) -> Result<String> {
        let prompt = self.build_prompt(positive, negative, width, height);
        let body = json!({ "prompt": prompt });

        let url = self.endpoint(&["prompt"])?;
        let resp = self
            .guarded(async {
                Ok(self
                    .client
                .post(url)
                    .header("Content-Type", "application/json")
                    .json(&body)
                    .send()
                    .await
                    .map_err(|e| anyhow!("ComfyUI /prompt request failed: {:#}", e))?)
            })
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = self.guarded(async { Ok(resp.text().await?) }).await?;
            // Try to extract a friendly error from ComfyUI's node validation JSON
            if let Ok(json_err) = serde_json::from_str::<Value>(&text) {
                let main_msg = json_err
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let node_detail = json_err
                    .get("node_errors")
                    .and_then(|ne| ne.as_object())
                    .and_then(|obj| obj.values().next())
                    .and_then(|node| node.get("errors"))
                    .and_then(|errs| errs.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|e| e.get("details"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if !main_msg.is_empty() {
                    let msg = if node_detail.is_empty() {
                        main_msg.to_string()
                    } else {
                        format!("{} ({})", main_msg, node_detail)
                    };
                    return Err(anyhow!("ComfyUI 节点验证失败: {}", msg));
                }
            }
            return Err(anyhow!("ComfyUI /prompt 错误 ({}): {}", status, text));
        }

        let data: PromptResponse = self
            .guarded(async {
                Ok(resp
                    .json()
                    .await
                    .map_err(|e| anyhow!("Failed to parse ComfyUI prompt response: {}", e))?)
            })
            .await?;

        if data.prompt_id.is_empty()
            || data.prompt_id.len() > 256
            || data.prompt_id.chars().any(char::is_control)
        {
            return Err(anyhow!("ComfyUI 返回无效任务标识"));
        }

        Ok(data.prompt_id)
    }

    /// Poll GET /history/{prompt_id} until the job finishes or times out.
    /// Returns the list of output images.
    async fn poll_until_done(&self, prompt_id: &str) -> Result<Vec<HistoryImage>> {
        let url = self.endpoint(&["history", prompt_id])?;
        let timeout = Duration::from_secs(300);
        let interval = Duration::from_millis(1500);
        let start = Instant::now();

        loop {
            if start.elapsed() > timeout {
                return Err(anyhow!("ComfyUI job timed out after 5 minutes"));
            }

            let resp = self
                .guarded(async {
                    Ok(self
                        .client
                        .get(url.clone())
                        .send()
                        .await
                        .map_err(|e| anyhow!("ComfyUI /history poll failed: {:#}", e))?)
                })
                .await?;

            if !resp.status().is_success() {
                return Err(anyhow!(
                    "ComfyUI /history 返回 HTTP {}",
                    resp.status().as_u16()
                ));
            }

            let history: Value = self
                .guarded(async {
                    Ok(resp
                        .json()
                        .await
                        .map_err(|e| anyhow!("Failed to parse history response: {}", e))?)
                })
                .await?;

            if let Some(entry) = history.get(prompt_id) {
                let status_node = entry.get("status");
                let status_complete = status_node
                    .and_then(|s| s.get("completed"))
                    .and_then(|c| c.as_bool())
                    .unwrap_or(false);

                if status_complete {
                    // Check whether ComfyUI reported an execution error
                    let status_str = status_node
                        .and_then(|s| s.get("status_str"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("success");

                    if status_str == "error" {
                        // Extract the execution_error message from messages array
                        let error_msg = status_node
                            .and_then(|s| s.get("messages"))
                            .and_then(|msgs| msgs.as_array())
                            .and_then(|msgs| {
                                msgs.iter().find_map(|msg| {
                                    let arr = msg.as_array()?;
                                    if arr.first()?.as_str()? == "execution_error" {
                                        let details = arr.get(1)?;
                                        let node_type = details
                                            .get("node_type")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("unknown");
                                        let exc = details
                                            .get("exception_message")
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("unknown error");
                                        Some(format!("节点 {} 执行失败: {}", node_type, exc))
                                    } else {
                                        None
                                    }
                                })
                            })
                            .unwrap_or_else(|| "ComfyUI 任务执行失败".to_string());
                        return Err(anyhow!("{}", error_msg));
                    }

                    // Extract SaveImage node (9) outputs
                    let images = entry
                        .pointer("/outputs/9/images")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|img| {
                                    let filename = img.get("filename")?.as_str()?.to_string();
                                    let subfolder = img.get("subfolder")?.as_str()?.to_string();
                                    let image_type = img.get("type")?.as_str()?.to_string();
                                    Some(HistoryImage {
                                        filename,
                                        subfolder,
                                        image_type,
                                    })
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();

                    if images.is_empty() {
                        return Err(anyhow!(
                            "ComfyUI 任务完成但无输出图片，请检查 SaveImage 节点（id=9）"
                        ));
                    }
                    return Ok(images);
                }
            }

            self.guarded(async {
                tokio::time::sleep(interval).await;
                Ok(())
            })
            .await?;
        }
    }

    /// Download image bytes from ComfyUI /view endpoint.
    /// Retries up to 3 times to handle stale keep-alive connections (Windows error 10053).
    async fn download_image(&self, img: &HistoryImage) -> Result<Vec<u8>> {
        let mut url = self.endpoint(&["view"])?;
        url.query_pairs_mut()
            .append_pair("filename", &img.filename)
            .append_pair("subfolder", &img.subfolder)
            .append_pair("type", &img.image_type);

        let max_retries: u32 = 3;
        let mut last_err = String::new();

        for attempt in 0..max_retries {
            if attempt > 0 {
                self.guarded(async {
                    tokio::time::sleep(Duration::from_millis(800 * u64::from(attempt))).await;
                    Ok(())
                })
                .await?;
            }

            let send_result = self
                .guarded(async { Ok(self.client.get(url.clone()).send().await?) })
                .await;
            let resp = match send_result {
                Err(e) => {
                    last_err = e.to_string();
                    continue;
                }
                Ok(r) => r,
            };

            if !resp.status().is_success() {
                return Err(anyhow!("ComfyUI /view error ({})", resp.status()));
            }

            match self.guarded(async { Ok(resp.bytes().await?) }).await {
                Err(e) => {
                    last_err = e.to_string();
                    continue;
                }
                Ok(bytes) => return Ok(bytes.to_vec()),
            }
        }

        Err(anyhow!(
            "ComfyUI /view request failed after {} retries: {}",
            max_retries,
            last_err
        ))
    }

    /// Generate an image and return it as a `data:image/png;base64,...` string.
    pub async fn generate_image_base64(
        &self,
        positive: &str,
        negative: &str,
        width: u32,
        height: u32,
    ) -> Result<String> {
        let prompt_id = self
            .submit_prompt(positive, negative, width, height)
            .await?;
        let images = self.poll_until_done(&prompt_id).await?;
        let first = images
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("No output image"))?;
        let bytes = self.download_image(&first).await?;
        let b64 = general_purpose::STANDARD.encode(&bytes);
        // Detect format from magic bytes
        let mime = if bytes.starts_with(b"\x89PNG") {
            "image/png"
        } else if bytes.starts_with(b"\xff\xd8") {
            "image/jpeg"
        } else {
            "image/png"
        };
        Ok(format!("data:{};base64,{}", mime, b64))
    }
}

/// Simple non-crypto random seed using current time.
fn rand_seed() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64 ^ d.as_secs().wrapping_mul(6364136223846793005))
        .unwrap_or(12345678)
}
