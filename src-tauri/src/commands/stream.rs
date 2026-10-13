use tauri::{AppHandle, Manager, Window};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;
use reqwest::Client;
use futures_util::StreamExt;
use crate::models::TextModelConfigInput;

// 全局取消标志
lazy_static::lazy_static! {
    static ref CANCEL_FLAG: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
    static ref GENERATION_LOCK: Arc<Mutex<()>> = Arc::new(Mutex::new(()));
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenerateOutlineStreamInput {
    pub title: String,
    pub genre: String,
    pub description: String,
    pub target_chapters: u32,
    pub text_config: TextModelConfigInput,
    pub requirements: Option<String>,
    pub output_language: Option<String>,
}

fn normalize_output_language(value: Option<&str>) -> &'static str {
    match value.map(|item| item.trim().to_ascii_lowercase()) {
        Some(lang) if lang == "en" => "en",
        _ => "zh",
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
    finish_reason: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct StreamDelta {
    content: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct StreamResponse {
    choices: Vec<StreamChoice>,
}

#[tauri::command]
pub async fn generate_outline_stream(
    window: Window,
    input: GenerateOutlineStreamInput,
) -> Result<String, String> {
    // 获取生成锁，确保同时只有一个生成任务
    let _lock = GENERATION_LOCK.lock().await;
    
    // 重置取消标志
    CANCEL_FLAG.store(false, Ordering::SeqCst);

    let client = Client::new();
    let target_chapters = input.target_chapters;
    let output_language = normalize_output_language(input.output_language.as_deref());
    
    let initial_prompt = build_outline_prompt(&input, output_language);
    let system_prompt = build_outline_system_prompt(target_chapters, output_language);

    // 第一次生成
    let mut full_content = stream_generate(
        &client, 
        &window, 
        &input.text_config,
        &system_prompt, 
        &initial_prompt,
        "outline-stream",
        8000,
        0.8,
    ).await?;

    // 检测是否需要续写（最多续写5次）
    let max_continuations = 5;
    for _ in 0..max_continuations {
        if CANCEL_FLAG.load(Ordering::SeqCst) {
            return Err("生成已被用户中断".to_string());
        }

        // 检查是否已生成所有章节
        let last_chapter_found = find_last_chapter_number(&full_content);
        
        if last_chapter_found >= target_chapters {
            // 已完成所有章节
            break;
        }

        let (continue_notice, continue_prompt, continue_system) = if output_language == "en" {
            (
                format!(
                    "\n\n[System: Outline incomplete (generated through Chapter {}, target Chapter {}). Continuing automatically...]\n\n",
                    last_chapter_found, target_chapters
                ),
                format!(
                    r#"Please continue the chapter outline section.

[Tail of generated content]
{}

[Continuation requirements]
1. Continue from Chapter {} through Chapter {}
2. Keep the same format as above
3. Chapter template:
### Chapter X: Chapter Title
- **Time**: timeline point of this chapter
- **Goal**: main plot objective of this chapter
- **Conflict**: core conflict/challenge
- **Hook**: ending hook to drive the next chapter

Continue directly from Chapter {}. Do not repeat existing content:"#,
                    get_last_n_chars(&full_content, 1500),
                    last_chapter_found + 1,
                    target_chapters,
                    last_chapter_found + 1
                ),
                format!(
                    r#"You are continuing an existing novel outline.
Existing chapters are Chapter 1 to Chapter {}. Continue Chapter {} to Chapter {} only.

Keep the same Markdown format and continue directly without extra introduction."#,
                    last_chapter_found,
                    last_chapter_found + 1,
                    target_chapters
                ),
            )
        } else {
            (
                format!(
                    "\n\n【系统：检测到大纲未完成（已生成到第{}章，目标{}章），正在自动续写...】\n\n",
                    last_chapter_found, target_chapters
                ),
                format!(
                    r#"请继续完成大纲的章节部分。

【已生成内容的结尾】
{}

【续写要求】
1. 从第{}章继续生成，直到第{}章
2. 保持与前面相同的格式
3. 每章格式：
### 第X章：章节标题
- **时间**：本章发生的时间点
- **目标**：本章要完成的剧情目标
- **冲突**：本章的核心冲突或挑战
- **结尾钩子**：吸引读者继续阅读的悬念

请直接从第{}章开始续写，不要重复已有内容："#,
                    get_last_n_chars(&full_content, 1500),
                    last_chapter_found + 1,
                    target_chapters,
                    last_chapter_found + 1
                ),
                format!(
                    r#"你正在续写一份小说大纲。前面的内容已经生成了第1章到第{}章，现在需要继续生成剩余的章节（第{}章到第{}章）。

请保持格式一致，直接续写章节内容，不要添加任何开头说明。"#,
                    last_chapter_found,
                    last_chapter_found + 1,
                    target_chapters
                ),
            )
        };

        let _ = window.emit("outline-stream", continue_notice);

        // 续写生成
        let continuation = stream_generate(
            &client,
            &window,
            &input.text_config,
            &continue_system,
            &continue_prompt,
            "outline-stream",
            6000,
            0.8,
        ).await?;

        full_content.push_str(&continuation);
    }

    Ok(full_content)
}

// 构建大纲生成的初始提示词
fn build_outline_prompt(input: &GenerateOutlineStreamInput, output_language: &str) -> String {
    if output_language == "en" {
        let mut prompt = format!(
            r#"Create a detailed novel outline for:

Title: {}
Genre: {}
Description: {}
Target chapters: {} (must be exactly this number)

"#,
            input.title, input.genre, input.description, input.target_chapters
        );

        if let Some(ref req) = input.requirements {
            prompt.push_str(&format!("Special requirements: {}\n\n", req));
        }

        prompt.push_str(&format!(
            r#"[Important] Use exactly this structure and generate exactly {} chapters:

## Story Overview
(~150-250 words)

## Core Conflict
(main contradiction and tension)

## World Building
(setting, rules, factions, social structure)

### Base Setting
- **Era**: time period
- **Geography**: key places
- **Society**: power/faction structure
- **Rules**: special rules (magic/tech/power systems)

### Major Factions
(3-5 important factions)

## Timeline Events
(chronological key events)

### Historical Events (before main story)
1. [Time] event and impact

### Story Timeline (during the story)
1. [Chapter/Time] key event

## Main Characters

### 1. Character Name
- **Role**: role identity
- **Personality**: personality traits
- **Background**: backstory
- **Motivation**: goal/motivation

## Three-Act Structure

### Act I: Setup (~20%)
### Act II: Rising Action & Climax (~60%)
### Act III: Resolution (~20%)

## Chapter Outline

[Must generate exactly {} chapters]

### Chapter 1: Chapter Title
- **Time**: timeline point of this chapter
- **Goal**: major objective of this chapter
- **Conflict**: core challenge
- **Hook**: ending hook

### Chapter 2: Chapter Title
...

(Continue to Chapter {})

Output in English only and keep strict Markdown format."#,
            input.target_chapters, input.target_chapters, input.target_chapters
        ));
        return prompt;
    }

    let mut prompt = format!(
        r#"请为以下小说创建详细大纲：

书名：{}
题材：{}
简介：{}
目标章节数：{}（必须严格按照这个数量生成章节大纲）

"#,
        input.title, input.genre, input.description, input.target_chapters
    );

    if let Some(ref req) = input.requirements {
        prompt.push_str(&format!("特殊要求：{}\n\n", req));
    }

    prompt.push_str(&format!(r#"【重要】请严格按照以下格式生成大纲，章节数必须恰好为{}章：

## 故事梗概
（200字左右的故事概述）

## 核心冲突
（主要矛盾和冲突描述）

## 世界观设定
（详细描述故事发生的世界背景、规则、势力分布、社会结构等，确保后续章节保持一致）

### 基础设定
- **时代背景**：故事发生的时代/纪元
- **地理环境**：主要地点、城市、国家等
- **社会结构**：权力体系、阶级划分、组织势力等
- **特殊规则**：如有魔法/科技/超能力等特殊元素的规则

### 重要势力
（列出3-5个重要势力/组织及其特点）

## 时间线事件
（按时间顺序列出影响剧情的重要历史事件和关键节点，便于各章节保持时间一致性）

### 历史事件（故事开始前）
1. 【时间点】事件描述及影响
2. ...

### 剧情时间线（故事进行中）
1. 【第X章时间点】关键事件
2. ...

## 主要角色

### 1. 角色名称
- **身份**：角色的身份定位
- **性格**：性格特点描述
- **背景**：背景故事简述
- **动机**：角色的目标和动机

### 2. 角色名称
（同上格式，3-5个主要角色）

## 三幕结构

### 第一幕：起始（约占全书20%）
（介绍主要人物、世界观，引出核心冲突）

### 第二幕：发展与高潮（约占全书60%）
（冲突升级、角色成长、多次转折）

### 第三幕：结局（约占全书20%）
（高潮对决、冲突解决、结局交代）

## 章节大纲

【必须生成恰好{}章，每章格式如下】

### 第1章：章节标题
- **时间**：本章发生的时间点
- **目标**：本章要完成的剧情目标
- **冲突**：本章的核心冲突或挑战
- **结尾钩子**：吸引读者继续阅读的悬念

### 第2章：章节标题
...

（以此类推，直到第{}章）

请确保：
1. 章节数量严格等于{}章
2. 每章都有明确的剧情推进
3. 章节之间逻辑连贯，时间线一致
4. 世界观设定详细完整，便于后续章节参考
5. 角色和势力格式便于系统解析
"#, input.target_chapters, input.target_chapters, input.target_chapters, input.target_chapters));

    prompt
}

// 构建大纲生成的系统提示词
fn build_outline_system_prompt(target_chapters: u32, output_language: &str) -> String {
    if output_language == "en" {
        return format!(
            r#"You are a professional novel planner and story architect.

Core constraints:
1. Output exactly {} chapters, no more and no less.
2. Use strict Markdown headings and list format.
3. Keep sections parse-friendly for programmatic extraction.
4. Write the entire output in English.

Quality requirements:
- coherent plot progression
- complete world building
- clear timeline
- consistent character design
- each chapter must include Time / Goal / Conflict / Hook"#,
            target_chapters
        );
    }

    format!(r#"你是一位专业的小说策划师和编剧。你的任务是根据用户提供的题材、风格和要求，创建详细的小说大纲。

【核心要求】
1. 章节数量必须严格等于用户指定的{}章，不能多也不能少
2. 使用标准Markdown格式输出
3. 角色、世界观、时间线信息必须按照指定格式，便于系统解析

【内容要求】
- 故事主线清晰，核心冲突明确
- 世界观设定完整详细（时代背景、地理环境、社会结构、特殊规则、重要势力）
- 时间线事件清晰（历史事件和剧情时间线），确保各章节时间一致
- 每个主要角色都有完整的设定（身份、性格、背景、动机）
- 三幕结构合理分配剧情节奏
- 每章都有明确的时间点、目标、冲突和悬念钩子
- 章节之间逻辑连贯，剧情层层递进

【格式要求】
- 使用 ## 作为一级标题（故事梗概、世界观设定、时间线事件、主要角色、章节大纲等）
- 使用 ### 作为二级标题（角色名、章节标题、势力名等）
- 使用 - **字段**：内容 格式列出详细信息
- 确保格式统一，便于程序解析"#, target_chapters)
}

// 查找已生成的最后一章编号
fn find_last_chapter_number(content: &str) -> u32 {
    use regex::Regex;
    
    let zh_re = Regex::new(r"第(\d+)章").unwrap();
    let en_re = Regex::new(r"(?i)chapter\s+(\d+)").unwrap();
    let mut max_chapter = 0u32;
    
    for cap in zh_re.captures_iter(content).chain(en_re.captures_iter(content)) {
        if let Some(num_str) = cap.get(1) {
            if let Ok(num) = num_str.as_str().parse::<u32>() {
                if num > max_chapter {
                    max_chapter = num;
                }
            }
        }
    }
    
    max_chapter
}

// 获取字符串最后N个字符
fn get_last_n_chars(s: &str, n: usize) -> &str {
    let len = s.len();
    if len <= n {
        s
    } else {
        // 找到合适的 UTF-8 边界
        let mut start = len - n;
        while start > 0 && !s.is_char_boundary(start) {
            start -= 1;
        }
        &s[start..]
    }
}

// 通用流式生成函数
async fn stream_generate(
    client: &Client,
    window: &Window,
    text_config: &TextModelConfigInput,
    system_prompt: &str,
    user_prompt: &str,
    event_name: &str,
    max_tokens: u32,
    default_temperature: f32,
) -> Result<String, String> {
    text_config.validate()?;
    let api_url = text_config.chat_completions_url();
    let temperature = text_config.normalized_temperature(default_temperature);

    let request_body = serde_json::json!({
        "model": text_config.model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": true
    });

    let response = client
        .post(&api_url)
        .header("Authorization", format!("Bearer {}", text_config.api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("API错误: {}", error_text));
    }

    let mut full_content = String::new();
    let mut stream = response.bytes_stream();
    // Buffer raw bytes and only process COMPLETE newline-terminated SSE lines. A `data:` line (or a
    // multi-byte UTF-8 char) can be split across network chunks; processing per-chunk would drop
    // that delta and corrupt the output (missing chars / mangled CJK). Buffering fixes that.
    let mut byte_buf: Vec<u8> = Vec::new();

    while let Some(chunk_result) = stream.next().await {
        if CANCEL_FLAG.load(Ordering::SeqCst) {
            return Err("生成已被用户中断".to_string());
        }

        let chunk = chunk_result.map_err(|e| format!("读取流失败: {}", e))?;
        byte_buf.extend_from_slice(&chunk);

        // Drain every complete line (up to and including each '\n'); keep the trailing partial line.
        while let Some(nl) = byte_buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = byte_buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            let line = line.trim_end_matches(['\r', '\n']);
            if let Some(data) = line.strip_prefix("data: ") {
                if data == "[DONE]" { continue; }
                if let Ok(stream_response) = serde_json::from_str::<StreamResponse>(data) {
                    if let Some(choice) = stream_response.choices.first() {
                        if let Some(content) = &choice.delta.content {
                            full_content.push_str(content);
                            let _ = window.emit(event_name, content.clone());
                        }
                    }
                }
            }
        }
    }

    Ok(full_content)
}

#[tauri::command]
pub async fn generate_long_novel_outline_stream(
    window: Window,
    title: String,
    genre: String,
    description: String,
    requirements: Option<String>,
    #[allow(non_snake_case)] existingContext: Option<String>,
    #[allow(non_snake_case)] outputLanguage: Option<String>,
    #[allow(non_snake_case)] textConfig: TextModelConfigInput,
) -> Result<String, String> {
    let _lock = GENERATION_LOCK.lock().await;
    CANCEL_FLAG.store(false, Ordering::SeqCst);

    let client = Client::new();
    let output_language = normalize_output_language(outputLanguage.as_deref());

    let existing_section = match existingContext.as_deref() {
        Some(ctx) if !ctx.trim().is_empty() => {
            if output_language == "en" {
                format!("\n\n## Existing Material to Build Upon\nThe author has already prepared the following. Please keep these consistent and expand/improve upon them:\n\n{}\n", ctx)
            } else {
                format!("\n\n## 已有创作素材（请在此基础上完善）\n作者已有以下内容，请保持一致性并在此基础上扩展完善：\n\n{}\n", ctx)
            }
        }
        _ => String::new(),
    };

    let (system_prompt, user_prompt) = if output_language == "en" {
        (
            "You are a professional long-form novel story planner. Your task is to create a detailed, structured story plan with world building, characters, plot arcs, and a story timeline. Do NOT produce a fixed chapter-by-chapter outline — instead focus on narrative arcs that can span variable lengths. If existing material is provided, build upon it and keep it consistent. CRITICAL: Output ONLY the structured content starting directly with the first markdown heading. Do NOT include any preamble, greetings, acknowledgements, meta-commentary, or introductory sentences before the first heading.".to_string(),
            format!(
                r#"Please create a detailed story plan for the following novel:

Title: {}
Genre: {}
Description: {}
{}{}

Generate the following sections:

## World Overview
Describe the world, era, social structure, and any special rules or systems.

## Core Characters (3-5 main characters)
For each character: name, role, personality, motivation, and arc.

## Main Story Throughline
Summarize the overall journey and central conflict of the novel.

## Story Timeline
List the major events and milestones in chronological order (not tied to specific chapters).

## Plot Arc Plan (4-7 arcs)
For each arc, use EXACTLY this heading format (replace N with the arc number):
### Arc N: [Arc Name]
- **Core Objective**: What does this arc accomplish?
- **Primary Conflict**: The central tension driving this arc
- **Key Turning Point**: The pivotal moment that changes things
- **Emotional Journey**: The emotional progression for the protagonist
- **Ending Beat**: How this arc concludes and what changes

## Themes & Depth
What deeper themes does this story explore?

IMPORTANT: Begin your response immediately with `## World Overview`. Do not write any greeting, acknowledgement, or introduction before the first heading. Use the EXACT section headings listed above (e.g. `## Story Timeline`, `## Plot Arc Plan`)."#,
                title, genre, description,
                requirements.as_deref().map(|r| format!("Additional requirements: {}\n", r)).unwrap_or_default(),
                existing_section
            )
        )
    } else {
        (
            "你是一位专业的长篇小说策划师。你的任务是为用户创作一份详尽的故事规划，包含世界观、人物设定、时间线和剧情弧线推进计划。不要生成固定章节数的大纲——聚焦于可弹性延伸的剧情弧线。如果提供了已有素材，请在其基础上保持一致并完善扩展。【重要】直接从第一个Markdown标题开始输出，不要在正文内容之前添加任何问候语、客套话、引导语或元评论。".to_string(),
            format!(
                r#"请为以下长篇小说创建详细的故事策划方案：

书名：{}
题材：{}
简介：{}
{}{}

请生成以下内容：

## 世界观概述
描述故事的世界、时代背景、社会结构和特殊规则体系。

## 核心人物设定（3-5个主要人物）
每个人物包含：姓名、身份定位、性格特点、核心动机、人物弧线。

## 故事主线
概述整部小说的核心旅程与中心冲突。

## 时间线
按时间顺序列出故事中的重大事件与转折节点（不与具体章节绑定）。

## 剧情弧线规划
每个弧线请严格使用以下标题格式（将N替换为实际序号，如1、2、3）：
### 弧线N：[弧线名称]
- **核心目标**：这段剧情要完成什么任务？
- **主要冲突**：驱动这段剧情的核心张力
- **关键转折**：改变一切的关键时刻
- **情感走向**：主角的情感历程演变
- **结尾收束**：这段弧线如何结束，带来什么变化

## 主题与深度
这部作品探讨哪些更深层的主题？

【重要】请直接从 `## 世界观概述` 开始输出，第一个字符即为标题，不要在此之前写任何问候、确认或引导性语句。严格使用上述标题格式，例如 `## 时间线`、`## 剧情弧线规划`。"#,
                title, genre, description,
                requirements.as_deref().map(|r| format!("额外要求：{}\n", r)).unwrap_or_default(),
                existing_section
            )
        )
    };

    let full_content = stream_generate(
        &client,
        &window,
        &textConfig,
        &system_prompt,
        &user_prompt,
        "long-novel-outline-stream",
        6000,
        0.8,
    ).await?;

    Ok(full_content)
}

#[tauri::command]
pub async fn continue_outline_stream(
    window: Window,
    #[allow(non_snake_case)] partialOutline: String,
    #[allow(non_snake_case)] outputLanguage: Option<String>,
    #[allow(non_snake_case)] textConfig: TextModelConfigInput,
) -> Result<String, String> {
    let _lock = GENERATION_LOCK.lock().await;
    CANCEL_FLAG.store(false, Ordering::SeqCst);

    let client = Client::new();
    let output_language = normalize_output_language(outputLanguage.as_deref());

    let (system_prompt, user_prompt) = if output_language == "en" {
        (
            "You are a professional long-form novel story planner. The story plan below was cut off mid-output due to token limits. Continue writing from the exact point of truncation following the same Markdown format and style. Do NOT repeat any already-written content. Start your output immediately from where the text was cut.".to_string(),
            format!(
                "The following story plan was truncated. Continue it from where it was cut off. If a section was partially written, complete it first, then proceed with any remaining sections. Maintain the exact same heading format (e.g. `## Story Timeline`, `### Arc N: Name`).\n\n---PARTIAL CONTENT START---\n{}\n---PARTIAL CONTENT END---\n\nContinue from here (output only the continuation, no repetition):",
                partialOutline
            )
        )
    } else {
        (
            "你是一位专业的长篇小说策划师。以下故事策划方案因Token限制而在输出过程中被截断。请从截断处直接接续，严格遵循相同的Markdown格式和标题体系。不要重复任何已有内容，直接从截断处输出续写部分。".to_string(),
            format!(
                "以下故事策划方案已被截断，请从截断处直接续写。如果某个章节被截断，先补全该章节再继续后续章节。严格保持相同的标题格式（如 `## 时间线`、`## 剧情弧线规划`、`### 弧线N：名称`）。\n\n---已有内容开始---\n{}\n---已有内容结束---\n\n请从此处续写（只输出续写内容，不要重复上面的内容）：",
                partialOutline
            )
        )
    };

    let full_content = stream_generate(
        &client,
        &window,
        &textConfig,
        &system_prompt,
        &user_prompt,
        "long-novel-outline-stream",
        4000,
        0.75,
    ).await?;

    Ok(full_content)
}

#[tauri::command]
pub async fn generate_character_relationships_stream(
    window: Window,
    outline: String,
    #[allow(non_snake_case)] characterNames: Vec<String>,
    #[allow(non_snake_case)] outputLanguage: Option<String>,
    #[allow(non_snake_case)] textConfig: TextModelConfigInput,
) -> Result<String, String> {
    let _lock = GENERATION_LOCK.lock().await;
    CANCEL_FLAG.store(false, Ordering::SeqCst);
    let client = Client::new();
    let output_language = normalize_output_language(outputLanguage.as_deref());
    let names_str = characterNames.join("、");

    let (system_prompt, user_prompt) = if output_language == "en" {
        (
            "You are a story analyst. Extract character relationships from the story outline and output them in strict pipe-delimited format. Output ONLY data lines, no headers or explanations.".to_string(),
            format!(
                "Based on the following novel outline, generate the relationship network for these characters: {}\n\n{}\n\nOutput format (one relationship per line):\nCharacter A | Relationship Type | Character B | Brief description\n\nRelationship types: Friends, Enemies, Master/Disciple, Lovers, Family, Rivals, Allies, etc.\nOnly use the exact character names listed above. Output ONLY data lines, nothing else.",
                names_str, outline
            ),
        )
    } else {
        (
            "你是一位故事分析师。从故事大纲中提取角色关系并以严格的竖线分隔格式输出。只输出数据行，不要标题或说明。".to_string(),
            format!(
                "根据以下长篇小说大纲，为这些角色生成关系网络：{}\n\n{}\n\n输出格式（每行一对关系）：\n角色A名字 | 关系类型 | 角色B名字 | 关系说明\n\n关系类型：朋友、敌人、师徒、恋人、家人、同伴、对立、主仆、盟友、竞争等。\n角色名字必须使用上述列表中的原名。只输出数据行，不要任何标题、序号或说明文字。",
                names_str, outline
            ),
        )
    };

    let full_content = stream_generate(
        &client, &window, &textConfig, &system_prompt, &user_prompt,
        "character-relations-stream", 2000, 0.7,
    ).await?;
    Ok(full_content)
}

#[tauri::command]
pub async fn generate_character_events_stream(
    window: Window,
    outline: String,
    #[allow(non_snake_case)] characterNames: Vec<String>,
    #[allow(non_snake_case)] arcTitles: Vec<String>,
    #[allow(non_snake_case)] outputLanguage: Option<String>,
    #[allow(non_snake_case)] textConfig: TextModelConfigInput,
) -> Result<String, String> {
    let _lock = GENERATION_LOCK.lock().await;
    CANCEL_FLAG.store(false, Ordering::SeqCst);
    let client = Client::new();
    let output_language = normalize_output_language(outputLanguage.as_deref());
    let names_str = characterNames.join("、");
    let arcs_str = if arcTitles.is_empty() {
        String::new()
    } else {
        format!("\n弧线列表：{}", arcTitles.join("、"))
    };

    let (system_prompt, user_prompt) = if output_language == "en" {
        let arcs_note = if arcTitles.is_empty() {
            String::new()
        } else {
            format!("\nArc list: {}", arcTitles.join(", "))
        };
        (
            "You are a story analyst. Extract key character events from the story outline in strict pipe-delimited format. Output ONLY data lines in chronological order.".to_string(),
            format!(
                "Based on the following novel outline, generate the event timeline for these characters: {}{}\n\n{}\n\nOutput format (one event per line, chronological):\nCharacter Name | Arc Name | Event Title | Brief description\n\nFor arc name: use the exact name from the arc list, or leave empty if not applicable.\nOnly use exact character names from the list. Output ONLY data lines.",
                names_str, arcs_note, outline
            ),
        )
    } else {
        (
            "你是一位故事分析师。从故事大纲中提取角色关键事件并以严格的竖线分隔格式输出。只输出数据行，不要标题或说明。按故事时序排列。".to_string(),
            format!(
                "根据以下长篇小说大纲，为这些角色生成事件时间线：{}{}\n\n{}\n\n输出格式（每行一个事件，按时序排列）：\n角色名字 | 所属弧线名 | 事件标题 | 事件简述\n\n所属弧线名：使用上述弧线列表中的原名，如不属于特定弧线则留空。\n角色名字必须使用上述列表中的原名。只输出数据行，不要任何标题、序号或说明。",
                names_str, arcs_str, outline
            ),
        )
    };

    let full_content = stream_generate(
        &client, &window, &textConfig, &system_prompt, &user_prompt,
        "character-events-stream", 3000, 0.7,
    ).await?;
    Ok(full_content)
}

#[tauri::command]
pub async fn generate_characters_from_outline_stream(
    window: Window,
    outline: String,
    #[allow(non_snake_case)] outputLanguage: Option<String>,
    #[allow(non_snake_case)] textConfig: TextModelConfigInput,
) -> Result<String, String> {
    let _lock = GENERATION_LOCK.lock().await;
    CANCEL_FLAG.store(false, Ordering::SeqCst);
    let client = Client::new();
    let output_language = normalize_output_language(outputLanguage.as_deref());

    // Rich, detailed JSON profiles (ported from the Android app's charsFromOutline prompts) — far
    // more thorough than the old terse pipe format. The frontend parses JSON first (pipe fallback).
    let (system_prompt, user_prompt) = if output_language == "en" {
        (
            "You are a professional novel character analyst. Extract ALL major and secondary characters from the provided outline. For each character, create a COMPREHENSIVE and DETAILED profile — do not summarize, be thorough. Output ONLY a valid JSON array with no markdown, no code fences, no explanation before or after:\n[\n  {\n    \"name\": \"Full character name\",\n    \"gender\": \"male / female / unknown\",\n    \"isProtagonist\": true or false,\n    \"role\": \"Role/title in the story (e.g. protagonist, main antagonist, mentor, rival...)\",\n    \"personality\": \"Detailed personality traits, behavioral tendencies, strengths and flaws\",\n    \"motivation\": \"Core desires, goals, driving forces, and what they fear or want to avoid\",\n    \"background\": \"Detailed backstory: origin, family, past events that shaped them\",\n    \"appearance\": \"Physical description: build, features, clothing style, distinguishing marks\"\n  }\n]".to_string(),
            format!(
                "Novel outline:\n\n{}\n\nNow output the complete JSON character array. Be thorough — each field must be detailed, not just a brief phrase. Only include actual named characters (people/beings), NOT places, arc titles, themes, or concepts.",
                outline
            ),
        )
    } else {
        (
            "你是专业的小说角色分析师。请从提供的大纲中提取所有主要角色与重要配角。对每个角色，请创建详尽完整的角色档案——不要简略概括，要详细展开。请只输出合法 JSON 数组，不要加任何 markdown、代码块标记、前置说明或结尾说明：\n[\n  {\n    \"name\": \"角色全名\",\n    \"gender\": \"男 / 女 / 未知\",\n    \"isProtagonist\": true 或 false,\n    \"role\": \"角色在故事中的身份定位（如主角、主要反派、导师、对手……）\",\n    \"personality\": \"详细的性格特点、行为倾向、优点与缺陷\",\n    \"motivation\": \"核心欲望、目标、驱动力，以及他们恐惧或想要避免的事\",\n    \"background\": \"详细背景故事：出身、家庭、塑造其性格的过去经历\",\n    \"appearance\": \"外貌描述：体型、五官特征、着装风格、显著标志\"\n  }\n]".to_string(),
            format!(
                "小说大纲：\n\n{}\n\n请现在输出完整的 JSON 角色数组。每个字段都要详尽，不能只写简短的词语或短语。只提取真实的命名角色（有名字的人物/生命体），不要地点、弧线名称、主题概念等。",
                outline
            ),
        )
    };

    let full_content = stream_generate(
        &client, &window, &textConfig, &system_prompt, &user_prompt,
        "characters-from-outline-stream", 8000, 0.6,
    ).await?;
    Ok(full_content)
}

#[tauri::command]
pub fn cancel_generation() -> Result<(), String> {
    CANCEL_FLAG.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn generate_chapter_outline_stream(
    window: Window,
    #[allow(non_snake_case)] previousSummary: String,
    #[allow(non_snake_case)] userRequirements: String,
    #[allow(non_snake_case)] arcContext: String,
    #[allow(non_snake_case)] chapterIndex: u32,
    #[allow(non_snake_case)] outputLanguage: Option<String>,
    #[allow(non_snake_case)] textConfig: TextModelConfigInput,
) -> Result<String, String> {
    let _lock = GENERATION_LOCK.lock().await;
    CANCEL_FLAG.store(false, Ordering::SeqCst);
    let client = Client::new();
    let output_language = normalize_output_language(outputLanguage.as_deref());

    let (system_prompt, user_prompt) = if output_language == "en" {
        (
            "You are a creative writing assistant helping an author plan the next chapter of their novel. Output ONLY the three requested fields in the exact format, nothing else.".to_string(),
            format!(
                "Plan Chapter {} for this novel.\n\n{}\n\nRecent chapter endings:\n{}\n\nAuthor's requirements for this chapter:\n{}\n\nOutput EXACTLY three lines, no extra text:\nTitle: [concise chapter title]\nGoal: [what happens this chapter, 1-2 sentences]\nConflict: [the key tension or conflict, 1 sentence]",
                chapterIndex,
                if arcContext.is_empty() { "No arc context yet.".to_string() } else { arcContext.clone() },
                if previousSummary.is_empty() { "(Opening chapter — no prior content)".to_string() } else { previousSummary.clone() },
                if userRequirements.is_empty() { "Write a transitional chapter that naturally advances the story and maintains tension.".to_string() } else { userRequirements.clone() }
            ),
        )
    } else {
        (
            "你是创作助手，协助小说作者规划下一章节。只输出要求格式的三个字段，不要任何额外文字或解释。".to_string(),
            format!(
                "为这部小说规划第{}章。\n\n{}\n\n前几章的结尾内容：\n{}\n\n作者对本章的需求/期望：\n{}\n\n请严格输出以下三行，不要任何额外文字：\n标题：[简洁的章节名称]\n目标：[本章发生什么，1-2句话]\n冲突：[关键张力或冲突，1句话]",
                chapterIndex,
                if arcContext.is_empty() { "暂无弧线上下文。".to_string() } else { arcContext.clone() },
                if previousSummary.is_empty() { "（开篇章节，暂无前文内容）".to_string() } else { previousSummary.clone() },
                if userRequirements.is_empty() { "安排一个过渡性章节，自然推进剧情，保持张力，为后续伏笔做铺垫。".to_string() } else { userRequirements.clone() }
            ),
        )
    };

    let full_content = stream_generate(
        &client, &window, &textConfig, &system_prompt, &user_prompt,
        "chapter-outline-stream", 400, 0.85,
    ).await?;
    Ok(full_content)
}

#[tauri::command]
pub async fn generate_arc_mini_outline_stream(
    window: Window,
    #[allow(non_snake_case)] projectTitle: String,
    #[allow(non_snake_case)] projectOutline: String,
    #[allow(non_snake_case)] arcTitle: String,
    #[allow(non_snake_case)] arcSummary: String,
    #[allow(non_snake_case)] chapterCount: u32,
    #[allow(non_snake_case)] startChapterNumber: u32,
    #[allow(non_snake_case)] prevChaptersContext: String,
    #[allow(non_snake_case)] outputLanguage: Option<String>,
    #[allow(non_snake_case)] textConfig: TextModelConfigInput,
) -> Result<String, String> {
    let _lock = GENERATION_LOCK.lock().await;
    CANCEL_FLAG.store(false, Ordering::SeqCst);
    let client = Client::new();
    let output_language = normalize_output_language(outputLanguage.as_deref());

    let (system_prompt, user_prompt) = if output_language == "en" {
        let end_num = startChapterNumber + chapterCount - 1;
        (
            "You are an expert novel editor. Break a story arc into a clear, chapter-by-chapter plan. Output ONLY the chapter list in exact format — no extra text.".to_string(),
            format!(
                "Novel: {title}\n\nOverall outline:\n{outline}\n\nCurrent story arc: \"{arc_title}\"\nArc description:\n{arc_summary}\n\nPrevious chapters context (the story so far):\n{prev_ctx}\n\nTask: Plan exactly {count} NEW chapters for the \"{arc_title}\" arc.\nThe existing story already has chapters up to Chapter {prev_end}. Your plan must number chapters starting from Chapter {start} through Chapter {end}.\n\nOutput format (one line per chapter, exactly {count} lines, starting at Chapter {start}):\nChapter {start}: [title] — [core event and goal, 1-2 sentences]\nChapter {next}: [title] — [core event and goal, 1-2 sentences]\n...\n\nRules:\n- Number chapters consecutively from {start} to {end}\n- Each chapter must causally follow the previous\n- The opening chapter should connect naturally from prior content\n- The final chapter should conclude this arc's main conflict and plant seeds for the next arc\n- Be specific and story-driven\n- Output ONLY the chapter list, no intro or explanation",
                title = projectTitle,
                outline = if projectOutline.is_empty() { "(No overall outline provided)".to_string() } else { projectOutline.clone() },
                arc_title = arcTitle,
                arc_summary = if arcSummary.is_empty() { "(No arc description)".to_string() } else { arcSummary.clone() },
                prev_ctx = if prevChaptersContext.is_empty() { "(Opening arc — no prior chapters)".to_string() } else { prevChaptersContext.clone() },
                count = chapterCount,
                start = startChapterNumber,
                next = startChapterNumber + 1,
                end = end_num,
                prev_end = if startChapterNumber > 1 { startChapterNumber - 1 } else { 0 },
            ),
        )
    } else {
        let end_num = startChapterNumber + chapterCount - 1;
        (
            "你是一位经验丰富的小说策划编辑，擅长将宏大的剧情弧线拆解为可操作的章节计划。请严格按要求格式输出，不要添加任何额外说明。".to_string(),
            format!(
                "小说信息：\n标题：{title}\n总纲概述：\n{outline}\n\n当前剧情弧线：《{arc_title}》\n弧线描述：\n{arc_summary}\n\n前置章节简况（已有内容）：\n{prev_ctx}\n\n任务：请为【{arc_title}】这一剧情弧线规划{count}章的详细章节安排。\n小说目前已有第1章至第{prev_end}章，本次规划应从第{start}章开始，到第{end}章结束，共{count}章。\n\n输出格式（严格按此格式，每章一行，共{count}行，从第{start}章开始编号）：\n第{start}章：[章节标题] — [本章核心事件与目标，1-2句话]\n第{next}章：[章节标题] — [本章核心事件与目标，1-2句话]\n...\n\n要求：\n- 章节编号从第{start}章连续递增至第{end}章，不得从第1章重新开始\n- 章节之间要有连贯的因果关系和剧情推进\n- 开篇要承接前置章节，结尾要为下一弧线或全书收束埋下伏笔\n- 每章目标明确，核心事件清晰\n- 只输出章节计划，不要任何其他文字",
                title = projectTitle,
                outline = if projectOutline.is_empty() { "（暂无总纲）".to_string() } else { projectOutline.clone() },
                arc_title = arcTitle,
                arc_summary = if arcSummary.is_empty() { "（暂无弧线描述）".to_string() } else { arcSummary.clone() },
                prev_ctx = if prevChaptersContext.is_empty() { "（首个弧线，暂无前置章节）".to_string() } else { prevChaptersContext.clone() },
                count = chapterCount,
                start = startChapterNumber,
                next = startChapterNumber + 1,
                end = end_num,
                prev_end = if startChapterNumber > 1 { startChapterNumber - 1 } else { 0 },
            ),
        )
    };

    let max_tokens = (chapterCount * 150).max(1500).min(6000);
    let full_content = stream_generate(
        &client, &window, &textConfig, &system_prompt, &user_prompt,
        "arc-mini-outline-stream", max_tokens, 0.75,
    ).await?;
    Ok(full_content)
}

#[tauri::command]
pub async fn generate_prologue_stream(
    window: Window,
    title: String,
    genre: String,
    outline: String,
    #[allow(non_snake_case)] outputLanguage: Option<String>,
    #[allow(non_snake_case)] textConfig: TextModelConfigInput,
) -> Result<String, String> {
    let _lock = GENERATION_LOCK.lock().await;
    CANCEL_FLAG.store(false, Ordering::SeqCst);

    let client = Client::new();
    let output_language = normalize_output_language(outputLanguage.as_deref());

    let (system_prompt, prompt) = if output_language == "en" {
        (
            r#"You are a senior fiction writer specialized in prologues/openings.
Write a prologue that builds atmosphere and world context quickly, plants foreshadowing, and avoids duplicating Chapter 1 events."#
                .to_string(),
            format!(
                r#"Write a prologue/opening based on the outline below.
Requirements:
1. Focus on atmosphere, world setup, suspense, and foreshadowing.
2. Do not retell or fully unfold Chapter 1 core events/conflict.
3. You may hint at key characters/factions without fully exposing the mainline.
4. Output plain English prose only, no Markdown.
5. Length about 800-1500 words.

Title: {}
Genre: {}

Outline:
{}"#,
                title, genre, outline
            ),
        )
    } else {
        (
            r#"你是一位资深小说作家与编剧，擅长创作序章/引子。
你的目标是写出能够快速建立世界观与氛围、埋下核心伏笔的序章，且避免与第一章内容重复。"#
                .to_string(),
            format!(
                r#"请根据以下小说大纲创作【序章/引子】，要求：
1. 重点营造世界观、氛围、悬念或伏笔。
2. 不要复述或展开第一章的具体事件，不要推进到第一章的核心冲突。
3. 可点出关键人物或势力，但不要完整揭示主线。
4. 输出中文小说正文，不使用任何 Markdown。
5. 字数约 800-1500 字。

书名：{}
题材：{}

小说大纲：
{}"#,
                title, genre, outline
            ),
        )
    };

    let content = stream_generate(
        &client,
        &window,
        &textConfig,
        &system_prompt,
        &prompt,
        "chapter-stream",
        2200,
        0.7,
    )
    .await?;

    Ok(content)
}

#[tauri::command]
pub async fn generate_chapter_stream(
    window: Window,
    #[allow(non_snake_case)] chapterTitle: String,
    #[allow(non_snake_case)] outlineGoal: String,
    conflict: String,
    #[allow(non_snake_case)] previousSummary: Option<String>,
    #[allow(non_snake_case)] currentContent: Option<String>,
    #[allow(non_snake_case)] chapterList: Option<String>,
    #[allow(non_snake_case)] charactersInfo: Option<String>,
    #[allow(non_snake_case)] worldSetting: Option<String>,
    #[allow(non_snake_case)] timeline: Option<String>,
    #[allow(non_snake_case)] targetWords: Option<u32>,
    #[allow(non_snake_case)] isContinuation: Option<bool>,
    #[allow(non_snake_case)] outputLanguage: Option<String>,
    #[allow(non_snake_case)] textConfig: TextModelConfigInput,
) -> Result<String, String> {
    let _lock = GENERATION_LOCK.lock().await;
    CANCEL_FLAG.store(false, Ordering::SeqCst);
    textConfig.validate()?;

    let client = Client::new();
    let is_continue = isContinuation.unwrap_or(false);
    let word_target = targetWords.unwrap_or(2500);
    let output_language = normalize_output_language(outputLanguage.as_deref());
    let api_url = textConfig.chat_completions_url();
    let temperature = textConfig.normalized_temperature(0.7);
    
    let mut prompt = String::new();

    // Chapter structure overview — gives AI positional awareness in the story
    if let Some(ref list) = chapterList {
        if output_language == "en" {
            prompt.push_str(&format!(
                "[Novel Chapter Structure]\n{}\n\n",
                list
            ));
        } else {
            prompt.push_str(&format!(
                "【小说章节结构】\n{}\n\n",
                list
            ));
        }
    }
    
    if let Some(ref world) = worldSetting {
        if output_language == "en" {
            prompt.push_str(&format!(
                r#"[Important: World Building - follow strictly]
Keep all generated content consistent with this world setting:

{}

"#,
                world
            ));
        } else {
            prompt.push_str(&format!(
                r#"【重要：世界观设定 - 必须严格遵守】
以下是本小说的世界观设定，生成内容时必须保持一致，不得与设定冲突：

{}

"#,
                world
            ));
        }
    }

    if let Some(ref tl) = timeline {
        if output_language == "en" {
            prompt.push_str(&format!(
                r#"[Important: Timeline - follow strictly]
Keep chronology consistent with these events:

{}

"#,
                tl
            ));
        } else {
            prompt.push_str(&format!(
                r#"【重要：时间线事件 - 必须严格遵守】
以下是本小说的时间线，生成内容时必须保持时间顺序一致，不得与已发生的事件冲突：

{}

"#,
                tl
            ));
        }
    }

    if let Some(ref chars) = charactersInfo {
        if output_language == "en" {
            prompt.push_str(&format!(
                r#"[Important: Character Bible - follow strictly]
Keep identity/personality/background/motivation consistent:

{}

"#,
                chars
            ));
        } else {
            prompt.push_str(&format!(
                r#"【重要：角色设定 - 必须严格遵守】
以下是本小说的角色设定，生成内容时必须保持角色身份、性格、背景完全一致，不得擅自更改：

{}

"#,
                chars
            ));
        }
    }

    if is_continue {
        // Previous chapters context for continuation (same as new-chapter mode)
        if let Some(ref summary) = previousSummary {
            if output_language == "en" {
                prompt.push_str(&format!(
                    "[Previous chapters — context only. NEVER mention \"Chapter N\", \"the last chapter\", or any structural labels in story prose.]\n{}\n\n",
                    summary
                ));
            } else {
                prompt.push_str(&format!(
                    "【前几章结尾内容（仅供衔接参考，正文中绝对不能出现\"第X章\"或任何章节标记）】\n{}\n\n",
                    summary
                ));
            }
        }
        if output_language == "en" {
            prompt.push_str(&format!(
                r#"Continue writing this chapter.

Chapter title: {}
Chapter goal: {}

[Current tail]
{}

Requirements:
1. Continue naturally without repeating existing text.
2. Keep advancing the plot.
3. Write around {} words for this continuation.
4. Keep style and pacing consistent.
5. Strictly follow world setting, timeline, and character bible.
6. Output plain English prose only (no Markdown).

Continue directly:"#,
                chapterTitle,
                outlineGoal,
                currentContent.as_deref().unwrap_or("(none)"),
                word_target
            ));
        } else {
            prompt.push_str(&format!(
                r#"请续写以下小说章节内容。

章节标题：{}
本章目标：{}

【已有内容结尾】
{}

请注意：
1. 自然衔接上文，不要重复已有内容
2. 继续推进剧情发展
3. 本次续写约{}字
4. 保持文风和节奏一致
5. 【重要】必须严格遵守上述世界观设定、时间线和角色设定，不得与之冲突
6. 不要使用markdown格式，直接输出小说正文

请直接续写内容，不要添加任何说明或标记："#,
                chapterTitle,
                outlineGoal,
                currentContent.as_deref().unwrap_or("（无）"),
                word_target
            ));
        }
    } else {
        if output_language == "en" {
            prompt.push_str(&format!(
                r#"Write this chapter:

Chapter title: {}
Chapter goal: {}
Core conflict: {}
"#,
                chapterTitle, outlineGoal, conflict
            ));
            if let Some(ref summary) = previousSummary {
                prompt.push_str(&format!(
                    r#"
[Previous chapter tail \u2014 context only. NEVER reference "Chapter N", "the last chapter", or structural labels in your prose.]
{}

"#,
                    summary
                ));
            }
            prompt.push_str(&format!(
                r#"
Requirements:
1. Write around {} words.
2. Strictly follow world setting, timeline, and character bible.
3. Strong scene immersion and visual details.
4. Natural dialogues consistent with character voices.
5. If previous chapter context exists, connect naturally.
6. Output plain English prose only (no Markdown).
7. NEVER include "Chapter N", "in the last chapter", or any structural meta-labels in your prose — those were context markers only.

Start writing the chapter content now:"#,
                word_target
            ));
        } else {
            prompt.push_str(&format!(
                r#"请撰写以下章节：

章节标题：{}
本章目标：{}
核心冲突：{}
"#,
                chapterTitle, outlineGoal, conflict
            ));

            if let Some(ref summary) = previousSummary {
                prompt.push_str(&format!(r#"
【上章结尾内容（仅供行文衔接，绝对不要在正文中提及"第X章"或任何章节标记）】（请自然衔接，不要重复）
{}

"#, summary));
            }

            prompt.push_str(&format!(r#"
写作要求：
1. 本次生成约{}字
2. 【重要】必须严格遵守世界观设定、时间线和角色设定，不得与之冲突
3. 场景描写要有画面感
4. 对话要自然生动，符合角色性格
5. 如果有前一章内容，请自然衔接，不要突兀
6. 不要使用markdown格式，直接输出小说正文
7. 【严禁】正文中绝对不能出现"第X章"、"上一章"、"章节"等元叙事信息，那些只是内部参考标记，不属于故事内容"#, word_target));
        }
    }

    // Consistency anchor — repeat character bible at the very end of the user message.
    // LLMs have highest attention to tokens at the end ("lost in the middle" effect).
    // This anchor overrides any gender/name/trait drift that accumulated in earlier context.
    if let Some(ref chars) = charactersInfo {
        if output_language == "en" {
            prompt.push_str(&format!(
                "\n\n[PRE-WRITE CHARACTER LOCK — immutable, takes priority if anything above contradicts]\n{}\n\nBegin writing the chapter now:",
                chars
            ));
        } else {
            prompt.push_str(&format!(
                "\n\n【动笔前强制核对 — 以下角色设定绝对不可更改，如与上文任何内容矛盾，以此处为准】\n{}\n\n立即开始写作，直接输出正文，不要添加任何说明：",
                chars
            ));
        }
    }

    let system_prompt = if output_language == "en" {
        r#"You are a skilled fiction writer.

Hard constraints:
1. Follow world building exactly.
2. Follow timeline consistency exactly.
3. Follow character bible exactly.
4. Keep continuity with previous content when provided.
5. Output plain English prose only (no Markdown).
6. Do NOT output the chapter title, chapter number, "Chapter N", or any heading/label line. Write ONLY the body prose, starting directly from the first sentence of the story.

Style:
- concrete details over vague abstraction
- show, don't tell
- natural dialogue
- controlled pacing and rhythm"#
    } else {
        r#"你是一位优秀的小说作者。你的任务是根据大纲和章节目标，撰写引人入胜的章节内容。

【最重要的规则 - 必须严格遵守】
1. 世界观一致性：如果用户提供了世界观设定（时代背景、地理环境、社会结构、特殊规则、势力分布），你必须严格遵守，不得创造与设定矛盾的内容。
2. 时间线一致性：如果用户提供了时间线事件，你必须保持时间顺序一致，不得与已发生的历史事件冲突。
3. 角色一致性：如果用户提供了角色设定，你必须严格遵守每个角色的身份、性格、背景和动机，不得擅自更改。

核心原则：
1. 严格按照提供的世界观、时间线、角色设定创作，保持全书一致
2. 叙事连贯性 - 如果提供了前一章内容，必须自然衔接
3. 注重场景描写和画面感
4. 对话要符合人物口吻和性格设定
5. 保持叙述节奏，张弛有度
6. 绝不输出章节标题、序号、"第X章""标题："等任何标题或标签行，直接从正文第一句开始写，只输出正文本身

写作风格：
- 避免AI痕迹（减少"然而"、"不禁"、"心中暗想"等词汇）
- 使用具体细节而非笼统描述
- 展示而非告知（Show, don't tell）
- 保持语言简洁有力
- 不要使用任何markdown格式，输出纯小说正文"#
    };

    let request_body = serde_json::json!({
        "model": textConfig.model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt}
        ],
        "temperature": temperature,
        "max_tokens": 4000,  // 控制在4000 tokens以内，避免中断
        "stream": true
    });

    let response = client
        .post(&api_url)
        .header("Authorization", format!("Bearer {}", textConfig.api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("API错误: {}", error_text));
    }

    let mut full_content = String::new();
    let mut stream = response.bytes_stream();
    // Buffer raw bytes; only process complete newline-terminated SSE lines (see stream_generate).
    let mut byte_buf: Vec<u8> = Vec::new();

    while let Some(chunk_result) = stream.next().await {
        if CANCEL_FLAG.load(Ordering::SeqCst) {
            return Err("生成已被用户中断".to_string());
        }

        let chunk = chunk_result.map_err(|e| format!("读取流失败: {}", e))?;
        byte_buf.extend_from_slice(&chunk);

        while let Some(nl) = byte_buf.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = byte_buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            let line = line.trim_end_matches(['\r', '\n']);
            if let Some(data) = line.strip_prefix("data: ") {
                if data == "[DONE]" { continue; }
                if let Ok(stream_response) = serde_json::from_str::<StreamResponse>(data) {
                    if let Some(choice) = stream_response.choices.first() {
                        if let Some(content) = &choice.delta.content {
                            full_content.push_str(content);
                            let _ = window.emit("chapter-stream", content.clone());
                        }
                    }
                }
            }
        }
    }

    Ok(full_content)
}

/// 生成章节推文（封面图片提示词 + 摘要）
#[derive(Debug, Serialize, Deserialize)]
pub struct ChapterPromoResult {
    pub image_prompt: String,
    pub summary: String,
    pub image_base64: Option<String>,
}

/// 将选中的段落内容转换为专业英文插图提示词
#[tauri::command]
pub async fn generate_illustration_prompt(
    #[allow(non_snake_case)] text: String,
    #[allow(non_snake_case)] style: Option<String>,
    #[allow(non_snake_case)] textConfig: TextModelConfigInput,
) -> Result<String, String> {
    textConfig.validate()?;
    let client = Client::new();
    let api_url = textConfig.chat_completions_url();
    let temperature = textConfig.normalized_temperature(0.6);
    let clipped_text = if text.chars().count() > 3000 {
        text.chars().take(3000).collect::<String>() + "..."
    } else {
        text
    };
    let style_text = style.unwrap_or_default();
    let style_section = if style_text.trim().is_empty() {
        String::new()
    } else {
        format!(
            r#"
用户指定的图片风格（可能包含中文，请先翻译为英文再使用）：
{}"#,
            style_text
        )
    };

    let prompt = format!(
        r#"你是专业的AI绘图提示词工程师。请根据下面的小说段落，生成**一条高质量、专业、英文**的插图提示词（image prompt），用于书籍插图或章节配图。

要求：
- 必须是英文
- 包含场景、人物、氛围、构图、光线、风格等关键信息
- 语言精炼、专业，适合图像模型
- 不要输出任何解释

{}

段落内容：
{}

请严格按JSON格式输出：
{{"image_prompt": "your English prompt here"}}"#,
        style_section,
        clipped_text
    );

    let request_body = serde_json::json!({
        "model": textConfig.model,
        "messages": [
            {
                "role": "system",
                "content": "You are a professional image prompt engineer. Return only JSON with an English image_prompt."
            },
            {
                "role": "user",
                "content": prompt
            }
        ],
        "max_tokens": 400,
        "temperature": temperature
    });

    let response = client
        .post(&api_url)
        .header("Authorization", format!("Bearer {}", textConfig.api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("API错误: {}", error_text));
    }

    let response_json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    let content = response_json["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("无法获取AI响应内容")?;

    // 清理可能的markdown包裹
    let cleaned_content = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    let result: serde_json::Value = serde_json::from_str(cleaned_content)
        .map_err(|e| format!("解析AI返回的JSON失败: {}。原始内容: {}", e, cleaned_content))?;

    let image_prompt = result["image_prompt"]
        .as_str()
        .unwrap_or("A cinematic book illustration, dramatic lighting, highly detailed")
        .to_string();

    Ok(image_prompt)
}

/// 生成章节摘要和图片提示词（使用DeepSeek）
#[tauri::command]
pub async fn generate_chapter_promo(
    #[allow(non_snake_case)] chapterTitle: String,
    #[allow(non_snake_case)] chapterContent: String,
    #[allow(non_snake_case)] style: Option<String>,
    #[allow(non_snake_case)] outputLanguage: Option<String>,
    #[allow(non_snake_case)] textConfig: TextModelConfigInput,
) -> Result<ChapterPromoResult, String> {
    textConfig.validate()?;
    let client = Client::new();
    let api_url = textConfig.chat_completions_url();
    let temperature = textConfig.normalized_temperature(0.7);
    let output_language = normalize_output_language(outputLanguage.as_deref());
    let style_text = style.unwrap_or_default();
    let style_section = if style_text.trim().is_empty() {
        if output_language == "en" {
            "No style provided. Select the most suitable style based on chapter tone.".to_string()
        } else {
            "用户未指定画风，请根据章节氛围选择最合适的英文画风。".to_string()
        }
    } else {
        if output_language == "en" {
            format!(
                "User style input (might be non-English). Translate to English and merge into image_prompt: {}",
                style_text
            )
        } else {
            format!(
                "用户指定画风（可能包含中文，请先翻译为英文再融合到 image_prompt）：{}",
                style_text
            )
        }
    };
    
    // 构建提示词：让AI生成摘要和英文图片提示词
    let prompt = if output_language == "en" {
        format!(
            r#"You are a professional fiction marketing editor. Complete two tasks from this chapter:

## Chapter Title
{}

## Chapter Content
{}

---

## Style Requirement
{}

Tasks:

### Task 1: Summary
Write a concise English summary for social promotion:
- up to 70 words
- highlight strongest hook
- vivid and suspenseful

### Task 2: Image Prompt
Generate an English image prompt for AI art:
- must be English
- incorporate style requirement (translate non-English style words first)
- describe the most representative scene/mood of this chapter
- include style cues (e.g. cinematic, dramatic lighting, anime style)
- suitable for a chapter cover image

Return strict JSON only:
{{"summary": "English summary", "image_prompt": "English image prompt here"}}"#,
            chapterTitle,
            if chapterContent.chars().count() > 3000 {
                chapterContent.chars().take(3000).collect::<String>() + "..."
            } else {
                chapterContent.clone()
            },
            style_section
        )
    } else {
        format!(
            r#"你是一位专业的小说营销专家。请根据以下章节内容，完成两项任务：

## 章节标题
{}

## 章节内容
{}

---

## 画风要求
{}

请完成以下任务：

### 任务1：生成摘要
为这一章生成一段精炼的中文摘要，用于社交媒体推广。要求：
- 字数不超过100字
- 抓住本章最吸引人的看点
- 语言生动有悬念感

### 任务2：生成图片提示词
根据章节内容，生成一段英文图片提示词(image prompt)，用于AI生图。要求：
- 必须是英文
- 必须融入“画风要求”中的风格信息（若是中文需先翻译为英文）
- 描述本章最具代表性的场景或氛围
- 包含画面风格描述（如 cinematic, dramatic lighting, anime style 等）
- 适合作为章节封面使用

请严格按照以下JSON格式返回，不要添加任何其他内容：
{{"summary": "中文摘要内容", "image_prompt": "English image prompt here"}}"#,
            chapterTitle,
            if chapterContent.chars().count() > 3000 {
                chapterContent.chars().take(3000).collect::<String>() + "..."
            } else {
                chapterContent.clone()
            },
            style_section
        )
    };

    let request_body = serde_json::json!({
        "model": textConfig.model,
        "messages": [
            {
                "role": "system",
                "content": if output_language == "en" {
                    "You are a professional fiction marketing editor and image prompt engineer. Return strict JSON. image_prompt must be English."
                } else {
                    "你是一位专业的小说营销专家与图像提示词工程师。请严格按JSON格式返回结果，且image_prompt必须是英文。"
                }
            },
            {
                "role": "user",
                "content": prompt
            }
        ],
        "max_tokens": 500,
        "temperature": temperature
    });

    let response = client
        .post(&api_url)
        .header("Authorization", format!("Bearer {}", textConfig.api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    if !response.status().is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("API错误: {}", error_text));
    }

    let response_json: serde_json::Value = response.json().await
        .map_err(|e| format!("解析响应失败: {}", e))?;

    let content = response_json["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("无法获取AI响应内容")?;

    // 清理AI返回的内容：去除可能的markdown代码块标记
    let cleaned_content = content
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();

    // 解析JSON响应
    let result: serde_json::Value = serde_json::from_str(cleaned_content)
        .map_err(|e| format!("解析AI返回的JSON失败: {}。原始内容: {}", e, cleaned_content))?;

    let summary = result["summary"]
        .as_str()
        .unwrap_or("摘要生成失败")
        .to_string();
    
    let image_prompt = result["image_prompt"]
        .as_str()
        .unwrap_or("A dramatic scene from a novel, cinematic lighting, high quality illustration")
        .to_string();

    Ok(ChapterPromoResult {
        image_prompt,
        summary,
        image_base64: None,
    })
}

/// 图片生成：支持 Pollinations 和 ComfyUI 两种引擎
#[tauri::command]
pub async fn generate_promo_image(
    trust: tauri::State<'_, std::sync::Arc<crate::api::comfy_tls::ComfyTrustService>>,
    prompt: String,
    width: Option<u32>,
    height: Option<u32>,
    model: Option<String>,
    #[allow(non_snake_case)] pollinationsKey: Option<String>,
    engine: Option<String>,
    #[allow(non_snake_case)] comfyuiUrl: Option<String>,
    #[allow(non_snake_case)] negativePrompt: Option<String>,
) -> Result<String, String> {
    let engine = engine.as_deref().unwrap_or("pollinations");

    if engine == "comfyui" {
        let client = super::comfy::native_client(std::sync::Arc::clone(trust.inner()), comfyuiUrl).await?;
        let w = width.unwrap_or(1024);
        let h = height.unwrap_or(1024);
        let negative = negativePrompt.unwrap_or_else(|| {
            "low quality, worst quality, deformed, mutated hands, mutated fingers, extra limbs, missing arms, signature, watermark, username, logo".to_string()
        });

        client
            .generate_image_base64(&prompt, &negative, w, h)
            .await
            .map_err(|e| format!("ComfyUI 图片生成失败: {}", e))
    } else {
        use crate::api::pollinations::{PollinationsClient, ImageGenerationParams};

        let client = PollinationsClient::new(pollinationsKey, None);
        let params = ImageGenerationParams {
            prompt,
            width: Some(width.unwrap_or(1200)),
            height: Some(height.unwrap_or(400)),
            seed: Some(-1),
            model: Some(model.unwrap_or_else(|| "zimage".to_string())),
            nologo: Some(true),
            enhance: Some(false),
        };

        client
            .generate_image_base64(&params)
            .await
            .map_err(|e| format!("Pollinations 图片生成失败: {}", e))
    }
}
