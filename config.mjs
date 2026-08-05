/**
 * Configuration module — agent constants and defaults.
 * Provider config is loaded separately by config-provider.mjs.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Constants ───────────────────────────────────────────────────────────────

export const DEFAULT_MAX_TURNS = 100;
export const DEFAULT_SUBAGENT_TURNS = 20;
export const DEFAULT_GOAL_TURNS = 200;
export const MIN_REPORT_CHARS = 50;
export const REPORT_CONTINUATION = '... [content truncated]';
export const TOOL_RESULT_OFFLOAD_LIMIT = 8000;
export const TOOL_RESULT_PREVIEW = 500;
export const MAX_INSTRUCTION_CHARS = 32_000;

export const VERIFY_CHECKLIST =
  'Self-review before finishing:\n' +
  '- Did I run the tests and did they pass?\n' +
  '- Did I reread changed files for stray debug output or stale comments?\n' +
  '- Do comments and docstrings match what the code does?\n' +
  '- Did I remove placeholder code, TODO stubs, and commented-out blocks?\n' +
  '- If I used a subagent, did I cross-check its report against the actual files?\n' +
  '- Are all task items genuinely done — not just marked done to get off the list?\n' +
  '- Did I trace through the fix end-to-end to confirm it actually solves the problem?';

/** Default config directory: ~/.junecoder */
export const configDir = join(homedir(), '.junecoder');

// ─── Defaults ─────────────────────────────────────────────────────────────────

/** Default agent configuration. Constants above are the single source of truth. */
export function defaultAgentConfig() {
  return {
    maxTurns: DEFAULT_MAX_TURNS,
    subagentTurns: DEFAULT_SUBAGENT_TURNS,
    goalTurns: DEFAULT_GOAL_TURNS,
    contextWindow: 1_000_000, // assumed model context window (estimated tokens)
    compactThreshold: 750_000, // compress at 75% of contextWindow
  };
}
