/**
 * Context compression module.
 *
 * Handles history truncation when the conversation grows too long.
 * Two strategies:
 *   1. compressIfNeeded — LLM-based summarization
 *   2. compressFallback — deterministic truncation when LLM summarization fails
 */

/** How many consecutive compression failures before triggering fallback. */
export const COMPRESS_FAILURE_LIMIT = 3;

/** Rough token estimate: ~4 characters per token for English text. */
const CHARS_PER_TOKEN = 4;

// ─── Token estimation ─────────────────────────────────────────────────────────

/**
 * Estimate token count from a message array.
 * Uses char/4 heuristic — fast, deterministic, good enough for threshold checks.
 */
export function estimateTokens(messages) {
  if (!messages || messages.length === 0) return 0;
  let chars = 0;
  for (const msg of messages) {
    if (!msg) continue;
    chars += String(msg.content || '').length;
    if (msg.tool_calls) chars += JSON.stringify(msg.tool_calls).length;
    if (msg.tool_call_id) chars += String(msg.tool_call_id).length;
    if (msg.name) chars += String(msg.name).length;
    if (msg.reasoning_content) chars += String(msg.reasoning_content).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

// ─── LLM-based compression ────────────────────────────────────────────────────

/**
 * Summarize a slice of conversation messages into a concise English paragraph.
 * Formats messages as a transcript and asks the LLM to capture intent, decisions,
 * modified files, and current progress.
 */
function buildSummaryPrompt(messages) {
  const transcript = messages.map((m) => {
    const role = m.role;
    let text = String(m.content || '');
    if (m.tool_calls) {
      const names = m.tool_calls.map((tc) => tc.function?.name || '?').join(', ');
      text = `[tool_calls: ${names}]` + (text ? ' ' + text : '');
    }
    if (m.name) text = `[tool: ${m.name}] ${text}`;
    if (text.length > 2000) text = text.slice(0, 2000) + '…';
    return `${role}: ${text}`;
  }).join('\n\n');

  return `Summarize this conversation segment concisely in English. Include:
- What the user wants to accomplish (goal / task).
- Files that were read, created, or modified.
- Key decisions or architectural choices made.
- Current progress and what remains to be done.

Conversation:
${transcript}

Summary:`; 
}

/** Maximum number of non-system messages to keep after LLM compression. */
const KEEP_RECENT = 10;

/**
 * Attempt LLM-based summarization of the conversation history.
 *
 *   1. Separate system messages from the rest.
 *   2. Slice non-system messages into "old" (summarize) and "recent" (keep).
 *   3. Call the provider LLM with a summarization prompt.
 *   4. Replace history with: system + summary note + recent messages.
 *
 * @param {object} agent
 * @param {number} threshold - token threshold to trigger compression
 * @param {object} [cb] - callbacks (cb.onCompress for TUI notification)
 * @returns {Promise<boolean>} true if compression was performed, false if skipped/failed
 */
export async function compressIfNeeded(agent, threshold, cb) {
  const tokens = agent._lastTotalTokens ?? estimateTokens(agent.history);
  if (tokens < threshold) return false;

  const history = agent.history;
  if (!history || history.length === 0) return false;

  // Separate system messages from the rest
  const systemMsgs = [];
  const otherMsgs = [];
  for (const msg of history) {
    if (msg && msg.role === 'system') systemMsgs.push(msg);
    else otherMsgs.push(msg);
  }

  // Nothing to compress if already short enough
  if (otherMsgs.length <= KEEP_RECENT) return false;

  const toSummarize = otherMsgs.slice(0, -KEEP_RECENT);
  const toKeep = otherMsgs.slice(-KEEP_RECENT);

  // Build prompt and call LLM
  try {
    const { chat } = await import('./provider.mjs');
    const response = await chat(agent.provider, {
      messages: [{ role: 'user', content: buildSummaryPrompt(toSummarize) }],
    });

    const summary = (response.content || '[Summary unavailable]').trim();

    // Rebuild history: system + summary + recent
    agent.history = [
      ...systemMsgs,
      { role: 'user', content: `[Conversation summary]\n\n${summary}`, _transient: true },
      ...toKeep,
    ];

    if (cb && cb.onCompress) cb.onCompress('llm');
    return true;
  } catch {
    // LLM call failed — return false so caller tracks failure → fallback
    return false;
  }
}

// ─── Deterministic fallback truncation ────────────────────────────────────────

/**
 * Deterministic fallback: truncate old messages, keep system + recent context.
 *
 * Strategy:
 *   1. System messages stay at the top, unmodified.
 *   2. Keep the last `keepRecent` messages from history.
 *   3. Drop everything else.
 *   4. Insert a truncation note between system messages and kept messages.
 *   5. Reset failure counter on success.
 *
 * @param {object} agent
 * @param {number} [keepRecent=10] - number of recent non-system messages to keep
 */
export function compressFallback(agent, keepRecent = 10) {
  const history = agent.history;
  if (!history || history.length === 0) return;

  // Separate system messages from the rest
  const systemMsgs = [];
  const otherMsgs = [];
  for (const msg of history) {
    if (msg && msg.role === 'system') {
      systemMsgs.push(msg);
    } else {
      otherMsgs.push(msg);
    }
  }

  // If the rest is already short enough, nothing to do
  if (otherMsgs.length <= keepRecent) {
    agent._compressFailures = 0;
    return;
  }

  // Keep only the last keepRecent non-system messages
  let kept = otherMsgs.slice(-keepRecent);
  // Never start mid-tool-batch: leading "tool" messages whose assistant
  // (tool_calls) parent was cut away are rejected by providers (400).
  while (kept.length > 0 && kept[0].role === 'tool') kept = kept.slice(1);
  const dropped = otherMsgs.length - kept.length;

  // Build truncation note
  const summaryLine = `[Context compressed: ${dropped} earlier messages were truncated. ` +
    `The conversation continues from here. Please continue based on recent context.]`;

  // Rebuild history: system + truncation note + kept recent messages
  agent.history = [
    ...systemMsgs,
    { role: 'user', content: summaryLine, _transient: true },
    ...kept,
  ];

  // Reset failure counter
  agent._compressFailures = 0;
}

// ─── Convenience: check + fallback ────────────────────────────────────────────

/**
 * Full compression check: try LLM summarization, fall back to truncation.
 * Called once per turn from the main loop.
 *
 * @param {object} agent
 * @param {number} threshold - token threshold
 * @param {object} [cb] - callbacks (cb.onCompress for TUI notification)
 * @returns {Promise<boolean>} true if any compression action was taken
 */
export async function checkAndCompress(agent, threshold, cb) {
  // Don't compress if threshold is 0 (disabled)
  if (!threshold || threshold <= 0) return false;

  // Under threshold: nothing to do. This is NOT a compression failure —
  // reset the counter so the fallback only fires after real over-threshold
  // failures, not every COMPRESS_FAILURE_LIMIT turns.
  const tokens = agent._lastTotalTokens ?? estimateTokens(agent.history);
  if (tokens < threshold) {
    agent._compressFailures = 0;
    return false;
  }

  // Try LLM-based compression
  const compressed = await compressIfNeeded(agent, threshold, cb);
  if (compressed) return true;

  // LLM compression didn't happen — track failures
  agent._compressFailures = (agent._compressFailures || 0) + 1;

  // If we've failed too many times, fall back to deterministic truncation
  if (agent._compressFailures >= COMPRESS_FAILURE_LIMIT) {
    compressFallback(agent);
    if (cb && cb.onCompress) cb.onCompress('fallback');
    return true;
  }

  return false;
}
