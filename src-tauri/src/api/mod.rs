pub mod comfyui;
pub mod comfy_tls;
pub mod deepseek;
pub mod embedding;
pub mod pollinations;

pub use comfyui::ComfyUIClient;
pub use deepseek::DeepSeekClient;
pub use embedding::EmbeddingClient;
pub use pollinations::PollinationsClient;

#[cfg(test)]
mod comfy_contract_tests;
