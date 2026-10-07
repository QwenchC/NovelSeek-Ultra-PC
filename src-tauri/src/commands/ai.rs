use crate::api::pollinations::ImageGenerationParams;
use crate::models::TextModelConfigInput;
use crate::services::GenerationService;
use reqwest::Client;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct GenerateOutlineInput {
    pub title: String,
    pub genre: String,
    pub description: String,
    pub target_chapters: u32,
    pub text_config: TextModelConfigInput,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenerateChapterInput {
    pub chapter_title: String,
    pub outline_goal: String,
    pub conflict: String,
    pub previous_summary: Option<String>,
    pub character_info: Option<String>,
    pub world_info: Option<String>,
    pub text_config: TextModelConfigInput,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenerateImageInput {
    pub params: ImageGenerationParams,
    pub save_path: String,
    pub pollinations_key: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GeneratePrologueInput {
    pub title: String,
    pub genre: String,
    pub outline: String,
    pub text_config: TextModelConfigInput,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenerateRevisionInput {
    pub text: String,
    pub goals: Option<String>,
    pub text_config: TextModelConfigInput,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenerateCharacterAppearanceInput {
    pub name: String,
    pub role: Option<String>,
    pub personality: Option<String>,
    pub background: Option<String>,
    pub motivation: Option<String>,
    pub style: Option<String>,
    pub text_config: TextModelConfigInput,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CharacterAppearanceResult {
    pub appearance: String,
    pub image_prompt: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenerateCharacterPortraitPromptInput {
    pub name: String,
    pub appearance: Option<String>,
    pub role: Option<String>,
    pub personality: Option<String>,
    pub background: Option<String>,
    pub motivation: Option<String>,
    pub style: Option<String>,
    pub text_config: TextModelConfigInput,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CharacterPortraitPromptResult {
    pub image_prompt: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AiChatInput {
    #[serde(default)]
    pub system: Option<String>,
    pub user: String,
    pub text_config: TextModelConfigInput,
}

fn build_text_service(config: &TextModelConfigInput) -> Result<GenerationService, String> {
    config.validate()?;

    Ok(GenerationService::new_with_text_config(
        Some(config.api_key.clone()),
        Some(config.normalized_api_base_url()),
        Some(config.model.clone()),
        Some(config.normalized_temperature(0.7)),
        None,
    ))
}

#[tauri::command]
pub async fn generate_outline(input: GenerateOutlineInput) -> Result<String, String> {
    let service = build_text_service(&input.text_config)?;

    service
        .generate_outline(
            &input.title,
            &input.genre,
            &input.description,
            input.target_chapters,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn generate_chapter(input: GenerateChapterInput) -> Result<String, String> {
    let service = build_text_service(&input.text_config)?;

    service
        .generate_chapter(
            &input.chapter_title,
            &input.outline_goal,
            &input.conflict,
            input.previous_summary.as_deref(),
            input.character_info.as_deref(),
            input.world_info.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn generate_image(input: GenerateImageInput) -> Result<String, String> {
    let service = GenerationService::new(None, input.pollinations_key);

    service
        .generate_image(input.params, &input.save_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn generate_prologue(input: GeneratePrologueInput) -> Result<String, String> {
    let service = build_text_service(&input.text_config)?;

    service
        .generate_prologue(&input.title, &input.genre, &input.outline)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn generate_revision(input: GenerateRevisionInput) -> Result<String, String> {
    let service = build_text_service(&input.text_config)?;
    let goals = input
        .goals
        .unwrap_or_else(|| "润色并保持原意，使表达更自然流畅".to_string());

    service
        .generate_revision(&input.text, &goals)
        .await
        .map_err(|e| e.to_string())
}

/// Generic single-shot chat completion (system + user) — the primitive behind the ported
/// Android features: container/growth per-chapter AI updates and novel-chat answering.
#[tauri::command]
pub async fn ai_chat(input: AiChatInput) -> Result<String, String> {
    let service = build_text_service(&input.text_config)?;

    service
        .chat(input.system.as_deref().unwrap_or(""), &input.user)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn generate_character_appearance(
    input: GenerateCharacterAppearanceInput,
) -> Result<CharacterAppearanceResult, String> {
    input.text_config.validate()?;
    let client = Client::new();
    let api_url = input.text_config.chat_completions_url();
    let temperature = input.text_config.normalized_temperature(0.7);
    let style = input.style.unwrap_or_default();

    let prompt = format!(
        r#"你是一位专业的小说人物设定师和 AI 生图提示词工程师。

请基于以下角色信息完成两项任务：
1) 生成中文“形象”描述（40~120字，具体，可用于小说人设）
2) 生成英文“一寸证件照风格”图像提示词（image_prompt）

角色名称：{}
身份：{}
性格：{}
背景：{}
动机：{}
用户偏好风格（可能是中文，请先理解再转成英文风格词）：{}

输出要求：
- 严格输出 JSON
- 不要输出任何额外解释
- JSON 结构如下：
{{"appearance":"中文形象文本","image_prompt":"English prompt"}}
"#,
        input.name.trim(),
        input.role.unwrap_or_default().trim(),
        input.personality.unwrap_or_default().trim(),
        input.background.unwrap_or_default().trim(),
        input.motivation.unwrap_or_default().trim(),
        style.trim()
    );

    let request_body = serde_json::json!({
        "model": input.text_config.model,
        "messages": [
            {
                "role": "system",
                "content": "You are a character designer and image prompt engineer. Return JSON only."
            },
            {
                "role": "user",
                "content": prompt
            }
        ],
        "temperature": temperature,
        "max_tokens": 500
    });

    let response = client
        .post(&api_url)
        .header("Authorization", format!("Bearer {}", input.text_config.api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("API 错误: {}", error_text));
    }

    let response_json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    let content = response_json["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("无法获取 AI 响应内容")?;

    let cleaned_content = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let result: serde_json::Value = serde_json::from_str(cleaned_content)
        .map_err(|e| format!("解析 AI 返回 JSON 失败: {}。原始内容: {}", e, cleaned_content))?;

    let appearance = result["appearance"].as_str().unwrap_or("").trim().to_string();
    let image_prompt = result["image_prompt"]
        .as_str()
        .unwrap_or("studio portrait, one-inch ID photo, clean background, realistic, high detail")
        .trim()
        .to_string();

    if appearance.is_empty() {
        return Err("AI 未返回有效的人物形象文本".to_string());
    }

    Ok(CharacterAppearanceResult {
        appearance,
        image_prompt,
    })
}

/// Tolerantly extract the `image_prompt` field from a model reply: strict JSON first, then any
/// embedded `{...}` object. Returns `None` for an empty / unparseable reply so callers fall back
/// gracefully instead of failing the whole image generation.
fn extract_image_prompt_field(content: &str) -> Option<String> {
    let cleaned = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    if cleaned.is_empty() {
        return None;
    }
    let pick = |v: &serde_json::Value| {
        v["image_prompt"]
            .as_str()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(cleaned) {
        if let Some(s) = pick(&v) {
            return Some(s);
        }
    }
    if let (Some(a), Some(b)) = (cleaned.find('{'), cleaned.rfind('}')) {
        if b > a {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&cleaned[a..=b]) {
                if let Some(s) = pick(&v) {
                    return Some(s);
                }
            }
        }
    }
    None
}

#[tauri::command]
pub async fn generate_character_portrait_prompt(
    input: GenerateCharacterPortraitPromptInput,
) -> Result<CharacterPortraitPromptResult, String> {
    input.text_config.validate()?;
    let client = Client::new();
    let api_url = input.text_config.chat_completions_url();
    let temperature = input.text_config.normalized_temperature(0.6);
    let style = input.style.unwrap_or_default();
    // Kept for a graceful fallback if the text model returns an empty / non-JSON reply (see below).
    let appearance_for_fallback = input.appearance.clone().unwrap_or_default();

    let prompt = format!(
        r#"你是专业的 AI 人像提示词工程师。请基于以下信息，生成一条用于人物“一寸证件照”风格的英文提示词。

角色名称：{}
形象描述：{}
身份：{}
性格：{}
背景：{}
动机：{}
用户偏好风格（可能是中文，请先转换为英文风格词后再融合）：{}

要求：
- 输出必须是英文提示词（image_prompt）
- 适合人像特写、一寸照构图、清晰面部细节
- 不要输出解释
- 严格输出 JSON：{{"image_prompt":"English prompt"}}
"#,
        input.name.trim(),
        input.appearance.unwrap_or_default().trim(),
        input.role.unwrap_or_default().trim(),
        input.personality.unwrap_or_default().trim(),
        input.background.unwrap_or_default().trim(),
        input.motivation.unwrap_or_default().trim(),
        style.trim()
    );

    let request_body = serde_json::json!({
        "model": input.text_config.model,
        "messages": [
            {
                "role": "system",
                "content": "You are a professional portrait prompt engineer. Return JSON only."
            },
            {
                "role": "user",
                "content": prompt
            }
        ],
        "temperature": temperature,
        "max_tokens": 300
    });

    let response = client
        .post(&api_url)
        .header("Authorization", format!("Bearer {}", input.text_config.api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("API 错误: {}", error_text));
    }

    let response_json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    let content = response_json["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .trim()
        .to_string();

    // Be resilient: some text models (reasoning models especially, or under a tight max_tokens) return
    // an EMPTY or non-JSON `content` — which previously failed with "EOF while parsing a value at line 1
    // column 0" and blocked portrait generation entirely. Instead, fall back to a sensible prompt built
    // from the character's own appearance + the chosen style so the image engine still runs.
    let image_prompt = extract_image_prompt_field(&content).unwrap_or_else(|| {
        let mut parts = vec![
            "studio portrait, one-inch ID photo headshot, clean background, soft lighting, realistic, high detail".to_string(),
        ];
        let ap = appearance_for_fallback.trim();
        if !ap.is_empty() {
            parts.push(ap.to_string());
        }
        let st = style.trim();
        if !st.is_empty() {
            parts.push(st.to_string());
        }
        parts.join(", ")
    });

    Ok(CharacterPortraitPromptResult { image_prompt })
}

#[tauri::command]
pub async fn test_deepseek_connection(api_key: String) -> Result<bool, String> {
    let service = GenerationService::new(Some(api_key), None);
    service.test_deepseek().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn test_text_connection(text_config: TextModelConfigInput) -> Result<bool, String> {
    let service = build_text_service(&text_config)?;
    service.test_deepseek().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn test_pollinations_connection(api_key: Option<String>) -> Result<bool, String> {
    let service = GenerationService::new(None, api_key);
    service.test_pollinations().await.map_err(|e| e.to_string())
}

// ── AI-driven plot arc generation ──────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct GeneratePlotArcInput {
    pub user_idea: String,
    pub book_title: String,
    #[serde(default)]
    pub book_description: String,
    #[serde(default)]
    pub book_outline: String,
    #[serde(default)]
    pub existing_arcs_summary: String,
    #[serde(default)]
    pub realm_system_context: String,
    #[serde(default)]
    pub characters_summary: String,
    #[serde(default)]
    pub target_chapter_count: Option<u32>,
    #[serde(default = "default_output_lang")]
    pub output_language: String,
    pub text_config: TextModelConfigInput,
}

fn default_output_lang() -> String {
    "zh".to_string()
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PlotArcResult {
    pub title: String,
    pub summary: String,
    pub chapter_count: u32,
    pub mini_outline: String,
}

#[tauri::command]
pub async fn generate_plot_arc(input: GeneratePlotArcInput) -> Result<PlotArcResult, String> {
    input.text_config.validate()?;
    let client = Client::new();
    let api_url = input.text_config.chat_completions_url();
    let temperature = input.text_config.normalized_temperature(0.7);

    let chapter_target = input.target_chapter_count.unwrap_or(8).clamp(3, 30);
    let is_zh = input.output_language.as_str() != "en";

    let prompt = if is_zh {
        format!(
            r#"你是一位资深玄幻小说编辑。请基于以下材料，为本书生成一段新的"剧情弧线"。

【书名】{book_title}
【立意 / 简介】{book_desc}

【小说大纲（已写部分）】
{book_outline}

【已有的剧情弧线】
{existing_arcs}

【修炼境界系统 / 已知角色当前状态】
{realm_ctx}

【已知主要角色】
{chars}

【用户期望】
{user_idea}

请生成一段新弧线（约 {n} 章），严格按以下 JSON 结构输出，**不要包裹在 ```json``` 里、不要任何前后文字**：
{{
  "title": "弧线标题（10-20 字内，吸引人）",
  "summary": "弧线整体梗概（150-300 字，说明本弧线的核心矛盾、关键转折、与已有大纲的呼应、与境界系统的关联）",
  "chapter_count": {n},
  "mini_outline": "逐章细纲。**严格使用此格式，每章一行**：\n第1章：章节标题 — 本章目标 / 关键事件\n第2章：章节标题 — 本章目标 / 关键事件\n……（共 {n} 章）"
}}

要求：
- 严格契合已有的大纲与境界系统（角色境界提升要符合境界阶梯的进阶节奏）
- 不要重复已有弧线的核心冲突
- mini_outline 的格式不能改，必须用"第X章：标题 — 目标"，否则无法解析"#,
            book_title = input.book_title.trim(),
            book_desc = if input.book_description.trim().is_empty() {
                "（暂无）"
            } else {
                input.book_description.trim()
            },
            book_outline = if input.book_outline.trim().is_empty() {
                "（暂无大纲）"
            } else {
                input.book_outline.trim()
            },
            existing_arcs = if input.existing_arcs_summary.trim().is_empty() {
                "（暂无）"
            } else {
                input.existing_arcs_summary.trim()
            },
            realm_ctx = if input.realm_system_context.trim().is_empty() {
                "（未定义境界系统）"
            } else {
                input.realm_system_context.trim()
            },
            chars = if input.characters_summary.trim().is_empty() {
                "（暂无）"
            } else {
                input.characters_summary.trim()
            },
            user_idea = input.user_idea.trim(),
            n = chapter_target,
        )
    } else {
        format!(
            r#"You are a senior xianxia/xuanhuan editor. Generate a new plot arc for this novel based on the material below.

[Book title] {book_title}
[Premise] {book_desc}

[Existing outline] {book_outline}

[Existing arcs] {existing_arcs}

[Realm system / character current state] {realm_ctx}

[Main characters] {chars}

[User intent] {user_idea}

Produce one new arc (~{n} chapters). Output STRICT JSON only, no code fences, no surrounding prose:
{{
  "title": "Arc title (concise)",
  "summary": "Arc overview (150-300 chars covering core conflict, key turns, ties to existing outline, ties to realm system)",
  "chapter_count": {n},
  "mini_outline": "Per-chapter beats, ONE LINE PER CHAPTER, strict format: 'Chapter 1: Title — Goal / Key event' ... ({n} chapters total)"
}}

Rules:
- Stay consistent with existing outline & realm progression pacing
- Do not repeat existing arcs' core conflicts
- mini_outline format MUST be 'Chapter N: Title — Goal' or it will not parse"#,
            book_title = input.book_title.trim(),
            book_desc = if input.book_description.trim().is_empty() { "(none)" } else { input.book_description.trim() },
            book_outline = if input.book_outline.trim().is_empty() { "(none)" } else { input.book_outline.trim() },
            existing_arcs = if input.existing_arcs_summary.trim().is_empty() { "(none)" } else { input.existing_arcs_summary.trim() },
            realm_ctx = if input.realm_system_context.trim().is_empty() { "(none)" } else { input.realm_system_context.trim() },
            chars = if input.characters_summary.trim().is_empty() { "(none)" } else { input.characters_summary.trim() },
            user_idea = input.user_idea.trim(),
            n = chapter_target,
        )
    };

    let request_body = serde_json::json!({
        "model": input.text_config.model,
        "messages": [
            { "role": "system", "content": "You are a senior xianxia editor. Return JSON only — no markdown fences, no commentary." },
            { "role": "user", "content": prompt }
        ],
        "temperature": temperature,
        "max_tokens": 3000
    });

    let response = client
        .post(&api_url)
        .header("Authorization", format!("Bearer {}", input.text_config.api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("API 错误: {}", error_text));
    }

    let response_json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    let content = response_json["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("无法获取 AI 响应内容")?;

    let cleaned = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let parsed: serde_json::Value = serde_json::from_str(cleaned)
        .map_err(|e| format!("解析 AI 返回 JSON 失败: {}。原始内容: {}", e, cleaned))?;

    let title = parsed["title"].as_str().unwrap_or("").trim().to_string();
    let summary = parsed["summary"].as_str().unwrap_or("").trim().to_string();
    let mini_outline = parsed["mini_outline"].as_str().unwrap_or("").trim().to_string();
    let chapter_count = parsed["chapter_count"]
        .as_u64()
        .map(|v| v as u32)
        .unwrap_or(chapter_target);

    if title.is_empty() || summary.is_empty() {
        return Err(format!(
            "AI 返回缺少必填字段。原始 JSON: {}",
            cleaned
        ));
    }

    Ok(PlotArcResult {
        title,
        summary,
        chapter_count,
        mini_outline,
    })
}

#[tauri::command]
pub async fn test_comfyui_connection(
    #[allow(non_snake_case)] comfyuiUrl: Option<String>,
) -> Result<bool, String> {
    use crate::api::ComfyUIClient;
    let client = ComfyUIClient::new(comfyuiUrl);
    client.test_connection().await.map_err(|e| e.to_string())
}
