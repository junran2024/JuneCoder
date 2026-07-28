import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { loadSkills, formatSkillListing } from './skills.mjs';

// ─── Constants ───────────────────────────────────────────────────────────────

export const DEFAULT_MAX_TURNS = 50;
export const DEFAULT_SUBAGENT_TURNS = 20;
export const DEFAULT_GOAL_TURNS = 30;
export const MIN_REPORT_CHARS = 50;
export const REPORT_CONTINUATION = '... [content truncated]';
export const TOOL_RESULT_OFFLOAD_LIMIT = 8000;
export const TOOL_RESULT_PREVIEW = 500;
export const AUTO_REMINDER =
  '[System reminder: working directory snapshot is provided at session start and after tool executions that may change it.]';
export const MAX_INSTRUCTION_CHARS = 32_000;

// ─── Pure Helpers ────────────────────────────────────────────────────────────

/** Escape XML special characters. */
export function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Canonicalize a tool call signature for duplication detection.
 * Returns "name:normalized-args" or null on parse failure.
 */
export function tryCanonicalize(name, args) {
  if (args === undefined || args === null) return `${name}:`;
  try {
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    return `${name}:${JSON.stringify(parsed, Object.keys(parsed).sort())}`;
  } catch {
    return null;
  }
}

/**
 * Repair history: strip transient messages, ensure system prompt is first,
 * validate message structure.
 */
export function repairHistory(history) {
  if (!Array.isArray(history)) return [];

  const cleaned = [];
  let systemIdx = -1;

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    // Skip null/undefined or messages without a valid role
    if (!msg || typeof msg.role !== 'string') continue;
    // Skip transient messages
    if (msg.transient || msg._transient) continue;

    // Clone to avoid mutating original
    const copy = { role: msg.role, content: msg.content };
    if (msg.tool_calls) copy.tool_calls = msg.tool_calls;
    if (msg.tool_call_id) copy.tool_call_id = msg.tool_call_id;
    if (msg.name) copy.name = msg.name;
    if (msg.reasoning_content) copy.reasoning_content = msg.reasoning_content;

    if (copy.role === 'system') {
      systemIdx = cleaned.length;
    }
    cleaned.push(copy);
  }

  // Move first system message to index 0 if it's not already there
  if (systemIdx > 0) {
    const sysMsg = cleaned.splice(systemIdx, 1)[0];
    cleaned.unshift(sysMsg);
  }

  // Drop orphaned tool messages: a "tool" message is only valid as a response
  // to a preceding assistant message carrying the matching tool_calls id.
  // Truncation can cut the parent away, and providers reject the request (400).
  const knownCallIds = new Set();
  const repaired = [];
  for (const msg of cleaned) {
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc && tc.id) knownCallIds.add(tc.id);
      }
    }
    if (msg.role === 'tool' && !knownCallIds.has(msg.tool_call_id)) continue;
    repaired.push(msg);
  }

  return repaired;
}

// ─── File System Helpers ─────────────────────────────────────────────────────

/**
 * Generate a tree-style listing of a working directory.
 * @param {string} cwd - directory to list
 * @param {{ maxDepth?: number, maxEntries?: number }} [opts]
 * @returns {string} tree text
 */
export function listWorkDir(cwd, opts = {}) {
  const { maxDepth = 3, maxEntries = 200 } = opts;
  let count = 0;

  function walk(dir, prefix, depth) {
    if (depth > maxDepth || count >= maxEntries) return '';

    let result = '';
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return '';
    }

    // Sort: directories first, then files, alphabetically
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < entries.length; i++) {
      if (count >= maxEntries) {
        result += `${prefix}... (max entries reached)\n`;
        break;
      }
      const entry = entries[i];
      // Skip hidden and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const relPath = relative(cwd, join(dir, entry.name));

      count++;
      if (entry.isDirectory()) {
        result += `${prefix}${connector}${entry.name}/\n`;
        result += walk(
          join(dir, entry.name),
          prefix + (isLast ? '    ' : '│   '),
          depth + 1,
        );
      } else {
        try {
          const st = statSync(join(dir, entry.name));
          result += `${prefix}${connector}${entry.name} (${st.size} bytes)\n`;
        } catch {
          result += `${prefix}${connector}${entry.name}\n`;
        }
      }
    }
    return result;
  }

  const header = `Working directory: ${cwd}\n`;
  const tree = walk(cwd, '', 1);
  return header + (tree || '(empty or inaccessible)\n');
}

/**
 * Collect git context from a working directory.
 * @param {string} cwd
 * @returns {string} git status, branch, and recent log
 */
export function collectGitContext(cwd) {
  const parts = [];
  const run = (cmd) => {
    try {
      return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };

  const branch = run('git rev-parse --abbrev-ref HEAD');
  if (branch) parts.push(`Branch: ${branch}`);

  const status = run('git status --short');
  if (status !== null) {
    parts.push(status ? `Status:\n${status}` : 'Status: clean');
  }

  const log = run('git --no-pager log --oneline -5');
  if (log) parts.push(`Recent commits:\n${log}`);

  const diff = run('git diff --stat');
  if (diff) parts.push(`Unstaged changes:\n${diff}`);

  return parts.length > 0 ? parts.join('\n\n') : '(not a git repository or git unavailable)';
}

// ─── Project Instructions ─────────────────────────────────────────────────────

/**
 * Load project instructions from AGENTS.md, PROJECT_RULES.md etc.
 * Reads from both ~/.junecoder/ and the local project directory.
 * @param {string} cwd
 * @returns {string} combined instructions
 */
export function loadProjectInstructions(cwd) {
  const sources = [
    join(homedir(), '.junecoder', 'AGENTS.md'),
    join(cwd, 'AGENTS.md'),
    join(cwd, 'PROJECT_RULES.md'),
    join(cwd, '.cursorrules'),
    join(cwd, '.windsurfrules'),
  ];

  const contents = [];
  for (const src of sources) {
    if (!existsSync(src)) continue;
    try {
      const text = readFileSync(src, 'utf-8').trim();
      if (text) {
        const label = basename(src);
        contents.push(`--- ${label} ---\n${text}`);
      }
    } catch {
      // skip unreadable files
    }
  }

  if (contents.length === 0) return '';

  let combined = contents.join('\n\n');
  if (combined.length > MAX_INSTRUCTION_CHARS) {
    combined =
      combined.slice(0, MAX_INSTRUCTION_CHARS) +
      `\n\n[WARNING: Instructions exceeded ${MAX_INSTRUCTION_CHARS} chars and were truncated.]`;
  }
  return combined;
}

// ─── System Prompt ────────────────────────────────────────────────────────────

export const DEFAULT_SYSTEM_PROMPT = `You are JuneCoder, a coding agent. You are a terse, precise engineer who cuts straight to the point—no fluff, no showing off, no filler. You write the most minimal, elegant code that solves the problem, and you say things in as few words as the truth allows.

Rules:
- Prefer tool calls over guessing. Read files before modifying them.
- When you need multiple independent pieces of information, make all independent tool calls in the SAME response so they can run in parallel.
- Be concise in your final answers. Report what you did, not what you plan to do.
- When the user asks a question, answer it. When they describe a task, do it. When unsure which they meant, ask before acting—once. Never guess at ambiguous intent.
- Never fabricate file contents or command outputs; only trust tool results.
- Run shell commands non-interactively: git commit -m, git --no-pager, -y/--yes flags where applicable.
- Make MINIMAL changes: fix the bug, don't refactor the file; ship the feature, don't add configurability nobody asked for.
- Never run git commit/push unless the user explicitly asks.
- After changing behavior, sweep comments and docstrings that now describe the old behavior.
- Before your final reply, re-read the user's latest request and confirm you are answering that one.
- Before declaring a coding task complete, use the verify tool. If tests exist, run them and confirm they pass.`;

// ─── Default Callbacks ────────────────────────────────────────────────────────

function defaultCallbacks(overrides = {}) {
  return {
    onToken: () => {},
    onReasoning: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onToolOutput: () => {},
    onPermissionRequest: async () => ({ allowed: true }),
    onCompress: () => {},
    onUsage: () => {},
    onTurnEnd: () => {},
    onTaskUpdate: () => {},
    onQuestion: async () => '',
    ...overrides,
  };
}

// ─── ContinueError ────────────────────────────────────────────────────────────

export class ContinueError extends Error {
  constructor(message, turn) {
    super(message);
    this.name = 'ContinueError';
    this.turn = turn;
  }
}

// ─── Agent Factory ────────────────────────────────────────────────────────────

export function createAgent(opts) {
  return {
    provider: opts.provider || {},
    tools: opts.tools || [],
    config: opts.config || {},
    cwd: opts.cwd || process.cwd(),
    memory: opts.memory || null,
    overlay: opts.overlay || null,
    history: [],
    tasks: [],
    planMode: false,
    goal: null,
    _permQueue: Promise.resolve(),
    _sessionStart: null,
    _turnsSinceTaskUpdate: 0,
    _turnsInPlanMode: 0,
    _mutatedThisRun: false,
    _verifiedThisRun: false,
    _pendingReminders: [],
    _recentCallSigs: [],
    _blockTally: {},
    _mcpProcesses: [],
    _compressFailures: 0,
    _depth: opts.depth || 0,
  };
}

// ─── runAgent Main Loop ───────────────────────────────────────────────────────

/**
 * Execute the ReAct agent loop.
 *
 * @param {object} agent - agent instance from createAgent()
 * @param {string} input - user input / task description
 * @param {object} [callbacks] - optional callback overrides
 * @param {object} [options] - runtime options
 * @param {number} [options.depth=0] - nesting depth (0 = top-level)
 * @param {AbortSignal} [options.signal] - abort signal
 * @returns {Promise<string>} final response content
 */
export async function runAgent(agent, input, callbacks = {}, options = {}) {
  const { depth = 0, signal } = options;
  agent._depth = depth;

  const cb = defaultCallbacks(callbacks);

  // ── Initialization ──────────────────────────────────────────────────────

  const maxTurns = depth > 0
    ? (agent.config.agent?.subagentTurns || DEFAULT_SUBAGENT_TURNS)
    : (agent.config.agent?.maxTurns || DEFAULT_MAX_TURNS);

  const compactThreshold = agent.config.agent?.compactThreshold || 750_000;

  // Repair history on first run
  if (agent.history.length > 0) {
    agent.history = repairHistory(agent.history);
  }

  // Set session start timestamp once
  if (!agent._sessionStart) {
    agent._sessionStart = Date.now();
  }

  // Build system prompt
  const sysPrompt = buildSystemPrompt(agent, depth);

  // Inject initial messages if history is empty
  if (agent.history.length === 0) {
    agent.history.push({ role: 'system', content: sysPrompt });
  }

  // Inject environment snapshot + memories + user input
  const envSnapshot = [
    listWorkDir(agent.cwd),
    collectGitContext(agent.cwd),
  ].filter(Boolean).join('\n\n');

  const projInstr = loadProjectInstructions(agent.cwd);

  const transientBlocks = [];
  transientBlocks.push(`Working directory: ${agent.cwd}\n${envSnapshot}`);
  if (projInstr) transientBlocks.push(`Project instructions:\n${projInstr}`);

  // Search memory if available
  if (agent.memory) {
    try {
      const { search } = await import('./memory.mjs');
      const memResult = await search(agent.memory, input, { limit: 5 });
      if (memResult) transientBlocks.push(`Relevant memories:\n${memResult}`);
    } catch { /* memory is optional */ }
  }

  // Inject all transient context as user messages
  if (transientBlocks.length > 0) {
    agent.history.push({
      role: 'user',
      content: `[System context]\n\n${transientBlocks.join('\n\n')}`,
      transient: true,
    });
  }

  // Push AUTO_REMINDER
  agent.history.push({ role: 'user', content: AUTO_REMINDER, transient: true });

  // Push the actual user input
  agent.history.push({ role: 'user', content: input });

  // Assemble tools (base + meta — rebuilt each turn for dynamic tools like MCP)
  const toolsModule = await import('./tools.mjs');
  const { metaTools } = await import('./metaTools.mjs');

  // ── Main Loop ───────────────────────────────────────────────────────────

  for (let turn = 0; turn < maxTurns; turn++) {
    // Rebuild tools each turn so dynamically registered tools (e.g. MCP) are visible
    let allTools = [...agent.tools, ...toolsModule.baseTools];
    const filteredMeta = depth >= 2
      ? metaTools.filter((t) => t.name !== 'subagent')
      : metaTools;
    allTools = [...allTools, ...filteredMeta];

    const toolByName = new Map();
    for (const t of allTools) {
      toolByName.set(t.name, t);
    }

    // Build OpenAI-format tool schemas for the provider
    const toolSchemas = allTools.map((t) => toolsModule.toOpenAISchema(t));
    // Step 1: Increment counters
    agent._turnsSinceTaskUpdate++;
    if (agent.planMode) {
      agent._turnsInPlanMode++;
    }

    // Step 2: Compress check
    try {
      const { checkAndCompress } = await import('./context.mjs');
      const didCompress = await checkAndCompress(agent, compactThreshold);
      if (didCompress) {
        // Re-inject AUTO_REMINDER after compression
        agent.history.push({ role: 'user', content: AUTO_REMINDER, transient: true });
      }
    } catch { /* compression is non-fatal */ }

    // Step 3: Build messages (clean transient for LLM)
    const messages = repairHistory(agent.history);

    // Call LLM
    const { chat } = await import('./provider.mjs');
    const provider = agent.provider;

    const response = await chat(provider, {
      messages,
      tools: toolSchemas.length > 0 ? toolSchemas : undefined,
      onToken: cb.onToken,
      onReasoning: cb.onReasoning,
      signal,
    });

    // Report usage
    if (response.usage) {
      try { cb.onUsage(response.usage); } catch { /* ignore */ }
    }

    // Step 4: No tool_calls — completion guard
    if (!response.toolCalls || response.toolCalls.length === 0) {
      // Guard: if files were mutated but not verified, inject reminder
      if (agent._mutatedThisRun && !agent._verifiedThisRun && !agent.planMode) {
        agent._pendingReminders.push(
          '[System reminder: you modified files but have not verified the changes. Call verify before finishing.]',
        );
        agent._mutatedThisRun = false;
        // Push a reminder for the next turn
        if (agent._pendingReminders.length > 0) {
          for (const reminder of agent._pendingReminders) {
            agent.history.push({ role: 'user', content: reminder, transient: true });
          }
          agent._pendingReminders = [];
        }
        continue; // Loop again to let the model respond to the reminder
      }

      // Push assistant response to history and return
      const assistantMsg = { role: 'assistant', content: response.content };
      if (response.reasoning) assistantMsg.reasoning_content = response.reasoning;
      agent.history.push(assistantMsg);

      return response.content || '';
    }

    // Step 5: Tool calls — push assistant message
    const assistantMsg = {
      role: 'assistant',
      content: response.content || null,
      tool_calls: response.toolCalls,
    };
    if (response.reasoning) assistantMsg.reasoning_content = response.reasoning;
    agent.history.push(assistantMsg);

    // Step 6: Execute tool calls
    const { executeToolCalls } = await import('./executor.mjs');
    const results = await executeToolCalls(agent, toolByName, response.toolCalls, cb, depth, signal);

    // Step 7: Process results
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const tc = response.toolCalls[i];

      const toolMsg = {
        role: 'tool',
        tool_call_id: r.id,
        name: r.name,
        content: r.error ? `Error: ${r.error}` : (r.output || ''),
      };
      agent.history.push(toolMsg);

      // Track mutations
      if (!r.error && !r.denied) {
        const tool = toolByName.get(r.name);
        if (tool && !tool.readonly) {
          agent._mutatedThisRun = true;
          // Reset verified flag when new mutations happen
          agent._verifiedThisRun = false;

          // Reindex file in memory if applicable
          if (agent.memory && r.name === 'write' && tc?.function?.arguments) {
            try {
              const args = JSON.parse(tc.function.arguments);
              if (args.path) {
                const absPath = args.path.startsWith('/')
                  ? args.path
                  : join(agent.cwd, args.path);
                const { reindexFile } = await import('./memory.mjs');
                await reindexFile(agent.memory, agent.cwd, absPath);
              }
            } catch { /* non-fatal */ }
          }
        }

        // Track verify
        if (r.name === 'verify') {
          agent._verifiedThisRun = true;
        }
      }

      // Report result
      try { cb.onToolResult(r.name, r.output, r.error); } catch { /* ignore */ }

      // Sync task list to TUI after task tool
      if (r.name === 'task' && !r.error && !r.denied) {
        try { cb.onTaskUpdate(agent.tasks); } catch { /* ignore */ }
      }
    }

    // Step 8: Inject pending reminders
    if (agent._pendingReminders.length > 0) {
      for (const reminder of agent._pendingReminders) {
        agent.history.push({ role: 'user', content: reminder, transient: true });
      }
      agent._pendingReminders = [];
    }

    // Step 9: Stagnation detection
    if (results.length > 0) {
      const sigs = [];
      for (let i = 0; i < results.length; i++) {
        const tc = response.toolCalls[i];
        if (tc) {
          const sig = tryCanonicalize(tc.function?.name, tc.function?.arguments);
          if (sig) sigs.push(sig);
        }
      }
      const sigKey = sigs.join(';');
      agent._recentCallSigs.push(sigKey);
      if (agent._recentCallSigs.length > 4) {
        agent._recentCallSigs.shift();
      }
      // Check last 3
      if (
        agent._recentCallSigs.length >= 3 &&
        agent._recentCallSigs[agent._recentCallSigs.length - 1] === sigKey &&
        agent._recentCallSigs[agent._recentCallSigs.length - 2] === sigKey &&
        agent._recentCallSigs[agent._recentCallSigs.length - 3] === sigKey
      ) {
        agent.history.push({
          role: 'user',
          content: '[System reminder: you appear to be stuck in a loop — the same tool calls have been made 3 times in a row. Try a different approach or ask for clarification.]',
          transient: true,
        });
      }
    }

    // Step 10: Goal progress tracking
    if (agent.goal) {
      const goalTurns = agent.config.agent?.goalTurns || DEFAULT_GOAL_TURNS;
      const progress = Math.floor((turn / goalTurns) * 100);
      if (turn > 0 && turn % 10 === 0) {
        agent.history.push({
          role: 'user',
          content: `[Goal progress: turn ${turn}/${goalTurns} (${Math.min(progress, 100)}%). Objective: "${agent.goal.objective}". Criteria: ${agent.goal.criteria || 'none'}]`,
          transient: true,
        });
      }
    }

    // Step 11: Task list reminder (every 10 turns, top-level only)
    if (depth === 0 && agent._turnsSinceTaskUpdate >= 10 && agent.tasks.length > 0) {
      const incomplete = agent.tasks.filter((t) => t.status !== 'done').length;
      if (incomplete > 0) {
        agent.history.push({
          role: 'user',
          content: `[Task reminder: ${incomplete} tasks still pending. Use task tool to update status.]`,
          transient: true,
        });
      }
    }

    // Step 12: Plan mode guidance (every 8 turns)
    if (agent.planMode && agent._turnsInPlanMode >= 8) {
      agent.history.push({
        role: 'user',
        content: `[You have been in plan mode for ${agent._turnsInPlanMode} turns. If you have enough information, consider exiting plan mode to implement.]`,
        transient: true,
      });
    }

    // Step 13: Turn end callback
    try { cb.onTurnEnd(turn, maxTurns); } catch { /* ignore */ }
  }

  // Loop exhausted without returning
  throw new ContinueError(`Agent exceeded max turns (${maxTurns}) without completing the task.`, maxTurns);
}

// ─── System Prompt Builder ────────────────────────────────────────────────────

function buildSystemPrompt(agent, depth) {
  let prompt = DEFAULT_SYSTEM_PROMPT;

  // Apply overlay if present (e.g., sub-agent role instructions)
  if (agent.overlay) {
    const overlayText = Array.isArray(agent.overlay)
      ? agent.overlay.join('\n')
      : String(agent.overlay);
    prompt += `\n\n${overlayText}`;
  }

  // Sub-agent specific note
  if (depth > 0) {
    prompt += `\n\nYou are a sub-agent at depth ${depth}. Work independently on your assigned task and return a concise report. Do not ask follow-up questions — complete the task yourself.`;
  }

  // Append project instructions
  const projInstr = loadProjectInstructions(agent.cwd);
  if (projInstr) {
    prompt += `\n\n--- Project Instructions ---\n${projInstr}`;
  }

  // Append skills listing
  try {
    const skills = loadSkills(agent.cwd);
    const skillListing = formatSkillListing(skills);
    prompt += `\n\n--- Available Skills ---\n${skillListing}`;
  } catch { /* skills module may not be available */ }

  return prompt;
}
