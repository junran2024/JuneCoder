# JuneCoder

**Zero-dependency AI coding agent for the terminal.** A ReAct-loop agent with tool calling, a full-featured TUI, MCP support, session persistence, long-term memory, and context compression — all in pure Node.js with **zero npm dependencies**. Everything (TUI rendering, SSE parsing, JSON-RPC, token estimation, YAML-like frontmatter) is hand-rolled.

Requires Node.js ≥ 21.7.

```bash
npm install -g junecoder
junecoder
```

You need a DeepSeek API key. On first run the TUI prompts you to paste one, and you can change it anytime with `/key` or switch models with `/model`.

---

## Features

### Terminal UI
A full-featured terminal interface built from scratch with raw ANSI sequences — no ncurses, no readline dependency. Scrollable conversation, streaming tokens and reasoning, a task panel, permission prompts, token statistics, and full CJK character support.

**Keyboard shortcuts:**
- `Enter` — send message / confirm prompt
- `Option+Enter` / `Shift+Enter` / paste — newline in input
- `Ctrl+C` — abort current run (quit when idle)
- `Ctrl+D` — quit (when input is empty)
- `Ctrl+L` — redraw screen
- `PageUp` / `PageDown` — scroll conversation
- `↑` / `↓` — input history / select options
- `y` / `a` / `n` — allow / allow+auto-approve / deny a permission prompt

**Slash commands:**
`/help` `/goal` `/plan` `/auto` `/key` `/model` `/sessions` `/clear` `/tasks` `/stats` `/new` `/quit`

### Tools
The agent has access to 10 base tools for file and system operations:

| Tool | Description |
|------|-------------|
| `read` | Read a text file with line numbers and paging |
| `write` | Write content to a file, creating parent directories |
| `edit` | Exact string replacement in files |
| `bash` | Execute shell commands |
| `delete` | Delete files with a git-tracked safety guard |
| `glob` | Find files by glob pattern (incl. `**`, `?`, `[...]`, `{a,b}`) |
| `grep` | Search file contents with regex (streaming, unicode-aware) |
| `ls` | List directory contents |
| `fetch` | Fetch URL content as text |
| `websearch` | Search the web via Bing |

### Meta Tools
Built-in agent introspection and control:

| Tool | Description |
|------|-------------|
| `task` | Plan and track multi-step tasks |
| `plan` | Enter/exit read-only plan mode |
| `goal` | Manage long-running autonomous goals (set/complete/blocked) |
| `verify` | Pre-completion self-check (diff, tests, checklist) |
| `subagent` | Spawn isolated sub-agents for parallel work |
| `skill` | Load project-specific skill workflows |
| `memory_search` | Search long-term memory |
| `memory_put` | Save knowledge to long-term memory |
| `mcp_connect` | Connect to an MCP server or project |
| `mcp_disconnect` | Disconnect an MCP server |
| `mcp_list` | List connected MCP servers |

### Agent Loop Safeguards
- **Permission system** — every non-readonly tool call requires interactive approval (`y`/`a`/`n`), unless auto-approve is on (`/auto`).
- **Plan mode** — read-only tools only; toggle with `/plan`.
- **Verify injection** — after code changes, a self-review checklist is injected before the agent may finish.
- **Stagnation detection** — the loop detects repeated identical tool calls and nudges the agent to change strategy.
- **Goal mode** — autonomous long-running goals with a turn budget, progress reminders, and explicit completion criteria (`/goal`).
- **Sub-agents** — nested isolated agents (`explore` / `plan` / `coder`) with their own depth-limited turn budget.

### MCP (Model Context Protocol)
Connect to MCP servers via JSON-RPC over **stdio** (spawn) or **HTTP** (Streamable transport). External tools are registered with an `mcp_<server>_` prefix and available immediately. Pre-configured server groups live in `~/.junecoder/mcp/*.json` and are advertised in the system prompt (name + description only, no auth), ready for one-shot `mcp_connect(project="...")`.

### Session Persistence
Conversations survive restarts. Sessions are saved automatically to `~/.junecoder/sessions/` (every 5 turns and on exit), keyed by project directory. Use `/sessions` to list archived slots and switch between them; `/clear` and `/new` archive the current session before resetting. Persisted lines store semantic roles, never raw ANSI codes, so restored sessions render identically.

### Long-Term Memory
File-based JSON memory store at `~/.junecoder/memory/` with keyword search (Chinese and English tokenization). The agent remembers conventions, decisions, and patterns across sessions via `memory_search` / `memory_put`, and files it writes are re-indexed automatically.

### Context Compression
When the conversation approaches the context window, the agent compresses history: an **LLM-based summarization** pass condenses older turns while preserving recent context and system prompts, falling back to deterministic truncation if summarization fails repeatedly.

### Skills
Reusable workflows stored as markdown with optional YAML-like frontmatter (`name`, `description`). Loaded from `~/.junecoder/skills/` (global) and `.junecoder/skills/` in your project (project overrides global). Two layouts are supported: flat `skills/<name>.md` or `skills/<name>/SKILL.md` with optional `references/`.

### Provider Registry
Provider-specific defaults (base URL, model, thinking mode) are declared in one registry. Currently ships with DeepSeek (`deepseek-v4-pro` default, `deepseek-v4-flash`), SSE streaming, and thinking/reasoning support. Switch models at runtime with `/model`.

### Project Instructions
Any of these files are picked up and injected into the system prompt (global first, then project — combined and truncated at 32k chars):
- `~/.junecoder/AGENTS.md` (global)
- `AGENTS.md`, `PROJECT_RULES.md`, `.cursorrules`, `.windsurfrules` (project)

---

## Usage

### TUI Mode (default)

```bash
junecoder                  # Start in current directory
junecoder ./my-project     # Start in a specific directory
junecoder open ./my-project
```

### Single-Shot Mode

```bash
junecoder "fix the lint errors in src/"
junecoder -p "add unit tests for utils.js"
junecoder -d ./my-project "explain this codebase"
```

Single-shot mode streams tokens to stdout and exits when done.

### CLI Options

```
junecoder [directory]               Start TUI
junecoder open [directory]          Start TUI in directory
junecoder "your prompt"             Single-shot (non-TUI)
junecoder -d, --dir <path> [prompt] Set working directory
junecoder -p, --prompt <text>       Single-shot mode
junecoder -t, --tui                 Force TUI mode
junecoder -h, --help                Show help
junecoder -v, --version             Show version
```

### Configuration & API Key

The API key lives in `~/.junecoder/config.json`, managed by the TUI. Resolution order:

1. `~/.junecoder/config.json` — providers array, set up on first run or via `/key`
2. `~/.junecoder/.env` — legacy `DEEPSEEK_API_KEY`, auto-migrated into config.json on first read
3. `DEEPSEEK_API_KEY` environment variable

```json
{
  "providers": [{ "name": "deepseek", "apiKey": "sk-..." }],
  "activeProvider": "deepseek"
}
```

---

## Skills

Create a skills directory with markdown files:

```markdown
# ~/.junecoder/skills/ or .junecoder/skills/ in your project

---
name: my-skill
description: Does something useful
---

# My Skill

Skill content here — prompts, workflows, conventions...
```

The agent lists available skills in its system prompt and activates them on demand with the `skill` meta-tool.

---

## Architecture

```
cli.js              — CLI entry point: arg parsing, TUI vs single-shot dispatch
agent.mjs           — ReAct loop: turns, compression, verify injection, stagnation detection
executor.mjs        — Two-phase tool execution (permission → parallel/serial)
provider.mjs        — LLM provider: DeepSeek registry, SSE streaming, thinking mode
config.mjs          — Agent constants and defaults (turn budgets, thresholds)
config-provider.mjs — Provider config persistence (~/.junecoder/config.json)
context.mjs         — Token estimation + LLM summarization + fallback truncation
memory.mjs          — File-based long-term memory store (keyword search)
session.mjs         — Conversation persistence, session slots, archiving
mcp.mjs             — MCP client (JSON-RPC over stdio + HTTP Streamable)
skills.mjs          — Skill loading (global + project, flat + subdirectory)
prompt.mjs          — System prompt, project instructions, goal preamble
tools.mjs           — Tool barrel: schema conversion + base tool list
metaTools.mjs       — Meta tools (task, plan, goal, verify, memory, MCP, subagent)
tui.mjs             — Terminal UI (raw ANSI, CJK-aware, streaming)
tools/
  read.mjs          — File reading
  write.mjs         — File writing
  edit.mjs          — String replacement editing
  bash.mjs          — Shell command execution
  delete.mjs        — File deletion
  glob.mjs          — File globbing
  grep.mjs          — Content search
  ls.mjs            — Directory listing
  fetch.mjs         — URL fetching
  websearch.mjs     — Web search (Bing)
tests/              — node --test suite (run with `npm test`)
```

Zero npm dependencies — everything from the TUI renderer to the SSE parser and MCP client is hand-rolled in plain Node.js.

---

## Development

```bash
npm test            # run the test suite (node --test)
node cli.js -h      # run locally without installing
```
