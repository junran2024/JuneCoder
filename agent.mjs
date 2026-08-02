import { join } from 'node:path';
import { DEFAULT_SYSTEM_PROMPT, GOAL_MODE_PREAMBLE, buildSystemPrompt, loadProjectInstructions } from './prompt.mjs';
import {
  DEFAULT_MAX_TURNS,
  DEFAULT_SUBAGENT_TURNS,
  DEFAULT_GOAL_TURNS,
  VERIFY_CHECKLIST,
} from './config.mjs';

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
    _recentCallSigs: [],
    _mcpProcesses: [],
    _mcpProjectNames: [],
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
    : (agent.goal?.status === 'active'
        ? (agent.config.agent?.goalTurns || DEFAULT_GOAL_TURNS)
        : (agent.config.agent?.maxTurns || DEFAULT_MAX_TURNS));

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

  // Goal mode: inject preamble + goal context so the LLM knows it's working on a goal from turn 1
  if (agent.goal?.status === 'active') {
    const budget = agent.config.agent?.goalTurns || DEFAULT_GOAL_TURNS;
    agent.history.push({
      role: 'user',
      content:
        GOAL_MODE_PREAMBLE + '\n\n' +
        `Objective: "${agent.goal.objective}"\n` +
        `Criteria: ${agent.goal.criteria || '(none)'}\n` +
        `Turn budget: ${budget}`,
      transient: true,
    });
  }

  // Push the actual user input
  agent.history.push({ role: 'user', content: input });

  // Assemble tools (base + meta — rebuilt each turn for dynamic tools like MCP)
  const toolsModule = await import('./tools.mjs');
  const { metaTools } = await import('./metaTools.mjs');

  // Preload modules used inside the loop (Node caches them, but pulling
  // the import() out of the hot path makes the intent clearer).
  const { checkAndCompress } = await import('./context.mjs');
  const { chat } = await import('./provider.mjs');
  const { executeToolCalls } = await import('./executor.mjs');
  const { reindexFile } = await import('./memory.mjs');

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

    // Build OpenAI-format tool schemas for the provider (deduped by name)
    const toolSchemas = [...toolByName.values()].map((t) => toolsModule.toOpenAISchema(t));
    
    // Step 1: Increment counters
    agent._turnsSinceTaskUpdate++;
    if (agent.planMode) {
      agent._turnsInPlanMode++;
    }

    // Step 2: Compress check
    try {
      await checkAndCompress(agent, compactThreshold, cb);
    } catch { /* compression is non-fatal */ }

    // Step 3: Build messages (clean transient for LLM)
    const messages = repairHistory(agent.history);

    // Call LLM
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
      // Guard: if non-readonly tools were used but not verified, inject checklist
      if (agent._mutatedThisRun && !agent._verifiedThisRun && !agent.planMode) {
        // Save what the model said so it knows it already responded
        const assistantMsg = { role: 'assistant', content: response.content || '' };
        if (response.reasoning) assistantMsg.reasoning_content = response.reasoning;
        agent.history.push(assistantMsg);
        // Inject checklist for model to review
        agent.history.push({ role: 'user', content: VERIFY_CHECKLIST });
        try { cb.onSystem('verify', 'Checklist injected:\n' + VERIFY_CHECKLIST); } catch { /* ignore */ }
        agent._mutatedThisRun = false;
        continue; // Loop again to let the model respond to the checklist
      }

      // Push assistant response to history and return
      const assistantMsg = { role: 'assistant', content: response.content || '' };
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
        if (tool && ['write', 'edit', 'delete'].includes(r.name)) {
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

      // Report result (skip for denied tools — askPermission already showed denial)
      if (!r.denied) {
        try { cb.onToolResult(r.name, r.output, r.error); } catch { /* ignore */ }
      }

      // Sync task list to TUI after task tool
      if (r.name === 'task' && !r.error && !r.denied) {
        try { cb.onTaskUpdate(agent.tasks); } catch { /* ignore */ }
      }
    }

    // Step 8: Stagnation detection
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
        try { cb.onSystem('loop', 'Repetitive calls detected, switching strategy'); } catch { /* ignore */ }
        agent.history.push({
          role: 'user',
          content: '[System reminder: you appear to be stuck in a loop — the same tool calls have been made 3 times in a row. Try a different approach or ask for clarification.]',
          transient: true,
        });
      }
    }

    // Step 9: Goal progress tracking (every turn when goal active)
    if (agent.goal?.status === 'active') {
      agent.goal.turnsUsed = (agent.goal.turnsUsed || 0) + 1;
      const budget = agent.config.agent?.goalTurns || DEFAULT_GOAL_TURNS;
      const used = agent.goal.turnsUsed;
      const pct = Math.floor((used / budget) * 100);
      try { cb.onGoalProgress?.(agent.goal.objective, used, budget); } catch { /* ignore */ }
      agent.history.push({
        role: 'user',
        content:
          `[Goal: turn ${used}/${budget} (${Math.min(pct, 100)}%). Objective: "${agent.goal.objective}". Criteria: ${agent.goal.criteria || 'none'}.\n` +
          (pct >= 90 ? 'WARNING: near turn budget — finish current task and report status.\n' : '') +
          `Mark complete only when criteria are met. Mark blocked only after 3 genuine attempts against the same condition.]`,
        transient: true,
      });
    }

    // Step 10: Task list reminder (every 10 turns, top-level only)
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

    // Step 11: Plan mode guidance (every 8 turns)
    if (agent.planMode && agent._turnsInPlanMode >= 8) {
      try { cb.onSystem('plan', `${agent._turnsInPlanMode} turns in plan mode, consider exiting`); } catch { /* ignore */ }
      agent.history.push({
        role: 'user',
        content: `[You have been in plan mode for ${agent._turnsInPlanMode} turns. If you have enough information, consider exiting plan mode to implement.]`,
        transient: true,
      });
    }

    // Step 12: Turn end callback
    try { cb.onTurnEnd(turn, maxTurns); } catch { /* ignore */ }
  }

  // Loop exhausted without returning
  throw new ContinueError(`Agent exceeded max turns (${maxTurns}) without completing the task.`, maxTurns);
}

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
    // Guard: DeepSeek rejects assistant messages with neither content nor tool_calls
    if (copy.role === 'assistant' && (copy.content == null) && !msg.tool_calls) {
      copy.content = '';
    }
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
    onSystem: () => {},
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
