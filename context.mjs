/**
 * Context compression module.
 *
 * Handles history truncation when the conversation grows too long.
 * Two strategies:
 *   1. compressIfNeeded — LLM-based summarization (stub for now)
 *   2. compressFallback — deterministic truncation when LLM summarization fails
 */
import { AUTO_REMINDER } from './agent.mjs';

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

// ─── LLM-based compression (stub) ─────────────────────────────────────────────

/**
 * Check if compression is needed and attempt LLM summarization.
 * Currently stubbed: returns false to let the caller track failure count.
 *
 * When the stub is removed:
 *   1. If estimated tokens < threshold, return false (no action needed).
 *   2. Call LLM to generate a summary of the conversation so far.
 *   3. Replace history with: system prompt + summary message + recent messages.
 *
 * @param {object} agent
 * @param {number} threshold - token threshold to trigger compression
 * @returns {Promise<boolean>} true if compression was performed, false if skipped/failed
 */
export async function compressIfNeeded(agent, threshold) {
  const tokens = estimateTokens(agent.history);
  if (tokens < threshold) return false;

  // Stub: not implementing LLM summarization yet.
  // Returns false so the caller increments _compressFailures and
  // eventually triggers compressFallback.
  return false;
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

  // Log a reminder about the compression
  agent._pendingReminders = agent._pendingReminders || [];
  agent._pendingReminders.push(AUTO_REMINDER);

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
 * @returns {Promise<boolean>} true if any compression action was taken
 */
export async function checkAndCompress(agent, threshold) {
  // Don't compress if threshold is 0 (disabled)
  if (!threshold || threshold <= 0) return false;

  // Under threshold: nothing to do. This is NOT a compression failure —
  // reset the counter so the fallback only fires after real over-threshold
  // failures, not every COMPRESS_FAILURE_LIMIT turns.
  if (estimateTokens(agent.history) < threshold) {
    agent._compressFailures = 0;
    return false;
  }

  // Try LLM-based compression
  const compressed = await compressIfNeeded(agent, threshold);
  if (compressed) return true;

  // LLM compression didn't happen — track failures
  agent._compressFailures = (agent._compressFailures || 0) + 1;

  // If we've failed too many times, fall back to deterministic truncation
  if (agent._compressFailures >= COMPRESS_FAILURE_LIMIT) {
    compressFallback(agent);
    return true;
  }

  return false;
}
