use crate::api::comfy_tls::{ComfyCertificateApproval, ComfyCertificateInfo, ComfyTrustService};
use crate::api::comfyui::{ComfyConnectionResult, ComfyUIClient};
use std::sync::Arc;
use tauri::State;

// All generating entry points obtain their grant and revision from native state, never from
// portable settings or an agent-supplied certificate argument.
pub(crate) async fn native_client(
    trust: Arc<ComfyTrustService>,
    base_url: Option<String>,
) -> Result<ComfyUIClient, String> {
    tauri::async_runtime::spawn_blocking(move || trust.client_for(base_url))
        .await
        .map_err(|_| "无法加载本机 ComfyUI 证书授权，未降低安全校验。".to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn comfy_get_certificate_approval(
    trust: State<'_, Arc<ComfyTrustService>>,
    base_url: String,
) -> Result<Option<ComfyCertificateApproval>, String> {
    let trust = Arc::clone(trust.inner());
    tauri::async_runtime::spawn_blocking(move || trust.get_approval(&base_url))
        .await
        .map_err(|_| "无法读取本机证书授权。".to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn comfy_inspect_certificate(
    trust: State<'_, Arc<ComfyTrustService>>,
    base_url: String,
) -> Result<ComfyCertificateInfo, String> {
    let trust = Arc::clone(trust.inner());
    trust.inspect_certificate(&base_url).await.map_err(|error| error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn comfy_approve_certificate(
    trust: State<'_, Arc<ComfyTrustService>>,
    base_url: String,
    certificate: ComfyCertificateInfo,
    fingerprint_verified: bool,
) -> Result<ComfyCertificateApproval, String> {
    if !fingerprint_verified {
        return Err("请先与电脑端公共证书独立核对完整 SHA-256，明确确认后才能授权。".into());
    }
    let trust = Arc::clone(trust.inner());
    tauri::async_runtime::spawn_blocking(move || trust.approve(&base_url, &certificate))
        .await
        .map_err(|_| "证书授权未能保存，请重新核对后重试。".to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn comfy_revoke_certificate(
    trust: State<'_, Arc<ComfyTrustService>>,
    base_url: String,
) -> Result<(), String> {
    let trust = Arc::clone(trust.inner());
    tauri::async_runtime::spawn_blocking(move || trust.revoke(&base_url))
        .await
        .map_err(|_| "证书撤销未完成，请重试。".to_string())?
        .map_err(|error| error.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn diagnose_comfyui_connection(
    trust: State<'_, Arc<ComfyTrustService>>,
    comfyui_url: Option<String>,
) -> Result<ComfyConnectionResult, String> {
    let client = native_client(Arc::clone(trust.inner()), comfyui_url).await?;
    Ok(client.diagnose_connection().await)
}
