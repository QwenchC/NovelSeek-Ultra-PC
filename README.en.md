# NovelSeek Ultra PC

[![Built with Pollinations](https://img.shields.io/badge/Built%20with-Pollinations-8a2be2?style=for-the-badge&logo=data:image/svg+xml,%3Csvg%20xmlns%3D%22http://www.w3.org/2000/svg%22%20viewBox%3D%220%200%20124%20124%22%3E%3Ccircle%20cx%3D%2262%22%20cy%3D%2262%22%20r%3D%2262%22%20fill%3D%22%23ffffff%22/%3E%3C/svg%3E&logoColor=white&labelColor=6a0dad)](https://pollinations.ai)

[中文文档](README.md)

NovelSeek Ultra PC is a desktop tool for long-form novel creation, covering the full workflow from outline planning and chapter generation to illustration/cover generation and ebook export.  
Built with `Tauri + React + TypeScript + Rust + SQLite`, it runs fully local with on-device data persistence.

## Pollinations Attribution

- Official website: <https://pollinations.ai>

[![pollinations.ai Logo Text White](docs/assets/pollinations-logo-text-on-dark.svg)](https://pollinations.ai)

## Version

- Current version: `v2.1.0`
- Primary platform: Windows

Version 2.1.0 adds the Android 1.6.0 scene-writing workbench, story notes, source-bound candidate review, planner/executor mode, manuscript import, EPUB/DOCX export and checksummed ZIP interchange. See [release notes](docs/RELEASE_NOTES_2.1.0.md) and [data interchange](docs/DATA_INTERCHANGE.md). Interchange is a manual backup workflow, not real-time cloud synchronization. Foreign tasks and candidate approvals are never automatically replayed.

## Feature Overview

### 1. Writing Workflow
- Create, edit, and delete short and long novel projects
- Project cards on the home page display cover thumbnails
- Chapter list and prologue management
- Streaming chapter generation, continuation, and polishing
- Quick chapter switching directly inside the chapter editor
- AI outline generation with structured editing
- Long novel: plot arc management (create, advance, ending, complete) with multi-arc serial progression

### 2. AI Capabilities
- Text model platforms: `DeepSeek / OpenAI / OpenRouter / Gemini (OpenAI-compatible) / Custom`
- Text model config: `API Key / API URL / Model / Temperature`
- Per-platform independent configuration with custom platform profiles
- Text generation for outlines, chapters, prologues, polishing, and image prompts
- Pollinations / ComfyUI: chapter promo images, paragraph illustrations, full book covers, character portraits
- Illustration anchor positioning, preview, move, and delete
- Chapter cover generation supports preset and custom style selection

### 3. Character Management
- Core fields: name, role, personality, background, motivation
- Generate appearance text from character data and sync it to the outline characters section
- Generate one-inch character portraits; portrait-only regeneration without affecting appearance text

### 4. Ebook Export
- Export entry from the chapter list page
- Both short and long novel projects support export
- Supported formats:
  - `PDF` (A4, supports novel cover / chapter cover / paragraph illustrations)
  - `TXT` (plain text)
  - `EPUB` (plain text)
  - `MOBI` (plain text)
- Export preview supports removing individual paragraph illustrations
- Export settings and progress are persisted

### 5. UI and Interaction
- Enhanced sidebar: navigation, project shortcuts, and theme toggle
- One-click dark / light mode toggle
- API key show/hide in settings
- Key-acquisition links for major text model platforms and Pollinations
- UI language switch (Chinese / English)

## Quick Start

### Requirements

- Node.js `>=18`
- Rust `>=1.75`
- npm

### Install Dependencies

```bash
npm install
```

### Development Mode

```bash
npm run tauri:dev
```

### Production Build

```bash
npm run tauri:build
```

Default installer output directories:

- `src-tauri/target/release/bundle/msi/`
- `src-tauri/target/release/bundle/nsis/`

## API Configuration

Configure in the app `Settings` page:

- Text model platform profile (multiple profiles supported):
  - `API Key`
  - `API URL`
  - `Model`
  - `Temperature`
- `Pollinations API Key` (optional, for image generation)

## Project Structure

```text
NovelSeek-Ultra-PC/
├─ src/
│  ├─ components/      # Shared UI components
│  ├─ pages/           # Pages: home/project/outline/editor/export/settings
│  ├─ services/        # Frontend API wrappers
│  ├─ store/           # Zustand global state
│  ├─ types/           # TypeScript type definitions
│  └─ utils/           # Utility helpers
├─ src-tauri/
│  ├─ src/
│  │  ├─ api/          # DeepSeek / Pollinations integrations
│  │  ├─ commands/     # Tauri command handlers
│  │  ├─ db/           # SQLite init and migrations
│  │  ├─ services/     # Backend business services
│  │  └─ models.rs     # Rust models
│  └─ tauri.conf.json
├─ package.json
├─ README.md
└─ README.en.md
```

## Notes

- Non-PDF formats are plain-text exports and do not include image assets.
- PDF CJK font rendering uses system fonts; if rendering fails, switch to a different font and retry.

## License

MIT
