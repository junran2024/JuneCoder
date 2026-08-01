/**
 * Configuration module — constants, configDir path, and default config factory.
 * No config.json support — API keys go in .env files (loaded by env.mjs).
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
  '- Did I run the project\'s tests and do they pass?\n' +
  '- Did I read every file I changed to catch leftover debug code or stale comments?\n' +
  '- Do comments and docstrings match what the code actually does?\n' +
  '- Did I remove placeholder code, TODO stubs, or commented-out experiment blocks?\n' +
  '- If I used a subagent, did I verify its report against the actual files it touched?\n' +
  '- Are all task items genuinely done (not just marked done to finish early)?';

/** Default config directory: ~/.junecoder */
export const configDir = join(homedir(), '.junecoder');

/** Default configuration object. Callers can spread/override with user settings. */
export function defaultConfig() {
  return {
    agent: {
      maxTurns: 100,
      subagentTurns: 20,
      goalTurns: 200,
      contextWindow: 1_000_000, // assumed model context window (estimated tokens)
      compactThreshold: 750_000, // compress at 75% of contextWindow
    },
    provider: {
      type: 'deepseek',
      apiKey: '',  // injected by cli.js / TUI from env after load
      model: 'deepseek-v4-pro',
      baseURL: 'https://api.deepseek.com',
      thinking: { type: 'enabled' },
    },
  };
}


