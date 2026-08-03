# JuneCoder

Zero-dependency AI coding agent for the terminal.

## Install

Node ≥ 21.7.

```bash
npm install -g junecoder
junecoder
```

## What's Inside

### 0 dependencies

No npm packages. TUI rendering, SSE parsing, JSON-RPC, YAML frontmatter — all hand-rolled in pure Node.js.

### Agent loop (`agent.mjs`)

A ReAct loop: each turn rebuilds the tool list, compresses history when the context window fills, calls the LLM, executes tool calls, then loops. Tools are rebuilt per-turn so dynamically registered tools from MCP connections are immediately visible — no restart required. 

Sub-agents spawn as isolated agent instances (explore, plan, coder roles). Goal mode runs autonomous multi-turn tasks with a turn budget and verifiable criteria. Plan mode locks out write tools for read-only exploration. A verify checklist auto-injects before completion when the agent has mutated files.

### Prompt (`prompt.mjs`)

The system prompt defines JuneCoder as a terse, precise engineer. It ships with a full worldview ("programming is collaborative labor"), ethos ("responsible engineer, not office equipment"), and value hierarchy ("correctness takes absolute priority"). At build time it injects available tools, skills, and MCP project listings. 

**You can define your own prompt** — drop a `prompt.md` in `~/.junecoder/`, or a `AGENTS.md` / `CLAUDE.md` in your project root. These are appended as overlays.

### Tools (`tools/`)

10 built-in tools: `read`, `write`, `edit`, `bash`, `glob`, `grep`, `ls`, `fetch`, `websearch`, `delete`. Each is a self-contained module exporting `{ name, description, parameters, execute }`. Converted to OpenAI function-calling schema on the fly.

Internal meta-tools (`metaTools.mjs`): `task`, `plan`, `verify`, `subagent`, `goal`, `skill`, `memory_search`, `memory_put`.

**You can define your own tools** — just drop `.mjs` files into `tools/` matching the export shape, or register them dynamically through MCP.

### MCP (`mcp.mjs`)

Model Context Protocol client. Supports stdio (child process) and HTTP transports. JSON-RPC is hand-rolled. Loads project configs from `~/.junecoder/mcp/*.json` — the agent sees available projects in its system prompt and connects on demand via the `mcp_connect` tool.

### Memory (`memory.mjs`)

Persistent long-term memory stored as JSON files. Keyword-searchable. The agent can write and recall project conventions, architecture decisions, and debugging patterns across sessions.

### Context compression (`context.mjs`)

Two strategies: LLM-based summarization (asks the model to compress old turns into a paragraph), with deterministic truncation as fallback when summarization fails. Triggered by a configurable token threshold.

### Executor (`executor.mjs`)

Two-phase tool execution: Phase 1 parses, validates, and checks permissions (serial). Phase 2 executes parallel-ready tools concurrently and serial-only tools one at a time. Large outputs auto-offload to disk.

### Provider (`provider.mjs`)

LLM provider abstraction. Currently ships with DeepSeek. Each provider declares its base URL, default model, and capabilities (thinking/reasoning). All OpenAI-compatible APIs work.

### Skills (`skills.mjs`)

Reusable prompt snippets stored as markdown files in `~/.junecoder/skills/`. Project-level skills override global ones. Supports flat layout (`skill-name.md`) and subdirectory layout (`skill-name/SKILL.md` with optional `references/`).

### Session (`session.mjs`)

Conversation persistence across restarts. Saves rendered display lines + raw agent history to `~/.junecoder/sessions/`. Multiple session slots with archive support.

### CLI / TUI (`cli.js`, `tui.mjs`)

CLI starts the TUI by default, or runs single-shot with a prompt argument. 

TUI is pure ANSI: no ncurses, no blessed. Layout has header, scrollable conversation, todo panel, input box, status bar. Hand-rolled CJK character width, mouse support, paste handling with truncation, and frame-dedup rendering.
