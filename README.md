# JuneCoder

**Zero-dependency AI coding agent for the terminal.** A ReAct-loop agent with tool-calling, TUI, MCP support, session persistence, long-term memory, and knowledge distillation — all in pure Node.js with no npm dependencies.

```bash
npm install -g junecoder
junecoder
```

---

## Features

### Terminal UI
A full-featured terminal interface built from scratch with raw ANSI sequences. Scrollable conversation, task panel, permission prompts, streaming token output, and CJK character support.

### Tools
The agent has access to 10 base tools for file and system operations:

| Tool | Description |
|------|-------------|
| `read` | Read a text file with line numbers and paging |
| `write` | Write content to a file, creating parent directories |
| `edit` | Exact string replacement in files |
| `bash` | Execute shell commands |
| `delete` | Delete files with git-tracked safety guard |
| `glob` | Find files by glob pattern |
| `grep` | Search file contents with regex |
| `ls` | List directory contents |
| `fetch` | Fetch URL content as text |
| `websearch` | Search the web via Bing |

### Meta Tools
Built-in agent introspection and control:

| Tool | Description |
|------|-------------|
| `task` | Plan and track multi-step tasks |
| `plan` | Enter/exit read-only plan mode |
| `goal` | Manage long-running autonomous goals |
| `verify` | Pre-completion self-check (diff, tests, checklist) |
| `subagent` | Spawn isolated sub-agents for parallel work |
| `skill` | Load project-specific skill workflows |
| `memory_search` | Search long-term memory |
| `memory_put` | Save knowledge to long-term memory |

### MCP (Model Context Protocol)
Connect to MCP servers via JSON-RPC over stdio. External tools are registered with an `mcp_<server>_` prefix and available immediately.

### Session Persistence
Conversations survive restarts. Sessions are automatically saved to `~/.junecoder/sessions/`. Switch between session slots, archive old ones.

### Long-Term Memory
File-based JSON memory store with keyword search. The agent remembers conventions, decisions, and patterns across sessions. Memory entries can be manually saved or auto-distilled from conversations.

### Context Compression
When the context window fills up, the agent compresses history. An LLM-based summarization layer is planned; currently a deterministic fallback truncates old messages while preserving system prompts and recent context.

### Skills
Project-specific skill files in `.junecoder/skills/*.md` with YAML-like frontmatter. The agent can load and activate skills on demand.

---

## Installation

Requires **Node.js >= 21.7**.

```bash
npm install -g junecoder
```

You need a DeepSeek API key. Provide it one of these ways:

1. **Interactive setup** — the TUI prompts for it on first run
2. `.env` file in your project — `DEEPSEEK_API_KEY=sk-...`
3. `~/.junecoder/.env` — global config
4. `DEEPSEEK_API_KEY` environment variable
5. `~/.junecoder/config.json` — provider config

---

## Usage

### TUI Mode (default)

```bash
junecoder                  # Start in current directory
junecoder ./my-project     # Start in a specific directory
junecoder open ./my-project
```

**Keyboard shortcuts:**
- `Enter` — send message
- `Option+Enter` — newline in input
- `Ctrl+C` — abort / quit
- `/` — slash commands (help, clear, session, etc.)
- `↑` / `↓` — navigate history

### Single-Shot Mode

```bash
junecoder "fix the lint errors in src/"
junecoder -p "add unit tests for utils.js"
junecoder --dir ./my-project "explain this codebase"
```

### CLI Options

```
junecoder [directory]               Start TUI
junecoder "your prompt"             Single-shot (non-TUI)
junecoder -d <path> [prompt]        Set working directory
junecoder -p <prompt>               Single-shot mode
junecoder -h, --help                Show help
junecoder -v, --version             Show version
```

---

## Configuration

### `~/.junecoder/config.json`

```json
{
  "agent": {
    "maxTurns": 50,
    "subagentTurns": 20,
    "contextWindow": 1000000,
    "compactThreshold": 750000
  },
  "provider": {
    "type": "deepseek",
    "model": "deepseek-v4-pro",
    "baseURL": "https://api.deepseek.com",
    "thinking": { "type": "enabled" }
  }
}
```

### `.env` Files

Loaded from (in order): `./.env`, `~/.junecoder/.env`. Existing environment variables take precedence.

### Project Instructions

Place any of these files in your project root for custom agent instructions:
- `AGENTS.md`
- `PROJECT_RULES.md`
- `.cursorrules`
- `.windsurfrules`

Also read from `~/.junecoder/AGENTS.md` for global instructions.

---

## Skills

Create `.junecoder/skills/` in your project with markdown files:

```markdown
---
name: my-skill
description: Does something useful
---

# My Skill

Skill content here — prompts, workflows, conventions...
```

The agent loads skills automatically and can activate them with the `skill` meta-tool.

---

## Architecture

```
agent.mjs         — ReAct loop, history, system prompt, workdir listing
executor.mjs      — Two-phase tool execution (permission → parallel/serial)
provider.mjs      — DeepSeek LLM provider with SSE streaming
context.mjs       — Token estimation + context compression
memory.mjs        — File-based long-term memory store
session.mjs       — Conversation persistence
mcp.mjs           — MCP client (JSON-RPC over stdio)
distill.mjs       — Knowledge extraction from conversations
checkpoint.mjs    — Git stash-based state checkpointing
skills.mjs        — Project skill loading
config.mjs        — Configuration + .env loading
metaTools.mjs     — Built-in meta tools (task, plan, goal, etc.)
tui.mjs           — Terminal UI (raw ANSI)
cli.js            — CLI entry point
tools/
  index.mjs       — Tool schema conversion + base tool list
  read.mjs        — File reading
  write.mjs       — File writing
  edit.mjs        — String replacement editing
  bash.mjs        — Shell command execution
  delete.mjs      — File deletion
  glob.mjs        — File globbing
  grep.mjs        — Content search
  ls.mjs          — Directory listing
  fetch.mjs       — URL fetching
  websearch.mjs   — Web search (Bing)
```

Zero npm dependencies. Everything — TUI rendering, SSE parsing, YAML-like frontmatter, token estimation — is hand-rolled.

---

## Changelog

### 1.1.2

- **Security:** Replaced `cat > file` shell execution with `writeFileSync` in `write` and `edit` tools. Removes shell injection risk and `/bin/cat` dependency. The `cat > file` pattern was a workaround for a bug that was actually in checkpoint/git stash (fixed earlier). ([#e16d458](https://github.com/junranli/JuneCoder-github/commit/e16d458))

### 1.1.1

- **Prompt improvements:** Added safety rule (no destructive commands without confirmation), cross-reference between "minimal changes" and "entire project is my code" values, "Human Has the Final Say" principle for when the agent's advice is overruled. Added version marker to prompt.md. ([#c803f7b](https://github.com/junranli/JuneCoder-github/commit/c803f7b))

### 1.1.0

- **System prompt extracted** from agent.mjs into standalone `prompt.md`. Easier to iterate on agent behavior without touching code.
- First public release with full tool set, TUI, MCP support, session persistence, and memory.
