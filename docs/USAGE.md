# Usage Guide

This guide covers how to use Simmetric Chat as an end user or administrator.

---

## Getting Started

First login: sign in with the bootstrap admin account seeded on first startup (default `admin` / `admin123` / `admin@example.com`, configurable via `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD` / `SEED_ADMIN_EMAIL`); the seeded password is single-use and must be changed at first login (or sign in if registration is gated). After login, create a workspace from the sidebar, then upload your first document in the Documents section. Once a workspace is active, open the Chat panel to start conversing with the AI assistant.

The system is initialized automatically on first startup: a bootstrap admin account is seeded (see above) and default roles are created, so no manual setup step is required.

Workspaces are the primary unit of knowledge isolation. Each workspace has its own documents, chat history, and agent configuration. Projects group related workspaces together for organizational purposes. You can switch workspaces at any time from the sidebar selector, and the chat panel will load the corresponding context and history.

---

## Chat

Simmetric Chat provides a streaming chat experience with real-time token delivery via Server-Sent Events (SSE). Messages appear word-by-word with an abort button to stop generation at any time.

**Model Selection:** Use the `ChatModelBadge` in the chat input area to switch models mid-conversation (opens the Cmd+K quick-switch palette). The palette groups models by provider and shows capability badges. Press **Cmd+K** (Mac) or **Ctrl+K** (Windows) to open the model palette directly for faster navigation.

**Capability Badges:** Models display badges such as `local-only` (runs on-premise), `fastest` (lowest latency), `smartest` (highest quality), and `reasoning` (chain-of-thought capable). These are derived automatically from model metadata and provider configuration.

**`/model` Command:** Type `/model <name>` in the input box to instantly switch to a matching model. If no exact match is found, a filtered palette opens. The command text is stripped before sending to prevent it from appearing in the chat history.

**Model Comparison:** Press **Cmd+Shift+M** (Mac) or **Ctrl+Shift+M** (Windows) to open side-by-side model comparison. Two panes stream responses from different models simultaneously for the same prompt. You can select which response to keep, send to a single pane, or close the comparison and continue with one model.

**Graceful Fallback:** If the selected model becomes unavailable, the system automatically falls back to the workspace default, then the global default, then any available model. A toast notifies you of the switch with an Undo option. This graceful fallback triggers on both periodic polling (every 30 seconds) and SSE errors during streaming.

**Citations:** When RAG search retrieves relevant documents, citation badges appear inline in the response with source links. Click a citation to view the source document and chunk.

**Message History:** Previous conversations are listed in the chat sidebar. Click any chat to resume. You can rename or delete chats from the sidebar menu.

---

## Documents

Upload documents in PDF, DOCX, XLSX, PPTX, TXT, MD, or CSV format. You can also submit YouTube URLs for transcript extraction. After upload, each document moves through status tracking: **pending** → **processing** → **completed** or **failed**. The collector parses, chunks, embeds, and stores documents automatically.

Supported formats include:

| Format | Extensions | Notes |
|--------|-----------|-------|
| PDF | `.pdf` | Text extraction + OCR fallback for scanned pages |
| Word | `.docx` | Full text and structure preservation |
| Excel | `.xlsx` | Tabular parsing |
| PowerPoint | `.pptx` | Slide text extraction |
| Markdown | `.md` | Direct parsing |
| Plain Text | `.txt` | Direct parsing |
| CSV | `.csv` | Tabular parsing |
| YouTube | URL | Transcript extraction |

RAG queries use hybrid search: vector similarity (LanceDB/Qdrant/pgvector/Chroma) combined with PostgreSQL full-text search (tsvector/tsquery), merged via Reciprocal Rank Fusion. Relevant sources appear as citation badges in chat responses.

---

## Admin Dashboard

**Widgets:** Navigate to Settings → Widgets to create and manage embeddable chat widgets. Configure branding (primary color, bot name, logo, avatar), workspace whitelist, and allowed CORS origins. Widget creation is license-gated. See [WIDGET.md](WIDGET.md) for integration details.

**MCP Connections:** Settings → MCP Connections lets you create, edit, test, and enable/disable external MCP servers that act as agent skills. Each connection specifies a transport type (`sse` or `streamable-http`), a URL, and optional headers.

**Analytics:** View token usage dashboards including daily usage, usage by model, and top users. Analytics help administrators monitor consumption and identify patterns.

**Event Logs:** Browse the audit trail of significant platform actions. Event logs capture authentication, document operations, settings changes, and administrative actions.

**System Settings:** Adjust runtime configuration via the UI. Infrastructure keys (JWT_SECRET, DATABASE_URL, ports) are read-only and require environment variable changes; all other keys are editable and take effect immediately.

---

## Settings

**LLM Provider:** Choose between Ollama (local), OpenAI, Anthropic, OpenRouter, Gemini, or any of the 15+ OpenAI-compatible providers (DeepSeek, Mistral, Kimi, NVIDIA NIM, Qwen, xAI, Z.AI/GLM, MiniMax, LM Studio, and more). Set model, temperature, and max tokens. The platform supports multi-provider configurations with a global default provider.

**Embedding Provider:** Use local Xenova/Transformers (air-gap compatible) or OpenAI embeddings. Local embeddings run entirely offline.

**Vector Database:** LanceDB (default, local), Qdrant (remote), pgvector (reuses PostgreSQL), or Chroma (embedded). LanceDB requires no external server and works fully air-gapped. pgvector stores vectors in the same PostgreSQL instance used for structured data.

**API Keys:** Create and revoke `sk-` prefixed API keys for programmatic access. API keys are verified via a deterministic HMAC-SHA256 digest and a single indexed lookup on the key hash, with the Postgres unique index providing constant-time comparison.

**User Management:** Admins can list users, create accounts, and assign roles. Open registration is controlled by the `ALLOW_REGISTRATION` environment variable.

**Roles & Permissions:** Create custom roles, assign from 31 permissions, and map menu sections to control sidebar visibility. Menu sections include dashboard, chat, documents, knowledgeBase, workspaces, projects, marketplace, mcpConnections, eventLog, analytics, widget, settings, and uploads.

---

## Widget Embedding

Admins create widgets in Settings → Widgets, then copy the embed code (script tag or iframe). External websites include the script tag to load a floating chat widget powered by the platform's RAG knowledge. Each widget can be scoped to specific workspaces and customized with branding fields such as primary color, bot name, and avatar.

Widgets use a two-step embedding pattern: a loader JavaScript file creates an iframe pointing to the widget panel HTML. This isolates the widget from the host page and prevents XSS risks. For full integration details, see [WIDGET.md](WIDGET.md).

---

## Multi-Language Support

The UI is available in English, Italian, Russian, German, French, Spanish, Chinese, and Portuguese. Switch languages via the language selector in the UI. Translation parity across all eight languages is validated via `pnpm i18n:check`.

Language preference is persisted to localStorage and applies immediately without a page reload. All chat UI labels, settings descriptions, and error messages are translated. New features must include translations for all supported languages before merge.
