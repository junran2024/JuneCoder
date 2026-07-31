/**
 * Configuration module — provides configDir path, default config factory, and
 * .env file loading. No config.json support — API keys go in .env files only.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';

// Load ~/.junecoder/.env before any code reads process.env.
// This is the single .env file — managed by /key command in TUI.
// Must happen here (not cli.mjs) because ESM static imports are hoisted —
// this module's body runs before cli.mjs's body.
{
  const envPath = join(homedir(), '.junecoder', '.env');
  try {
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
    }
  } catch { /* ignore missing/unreadable .env */ }
}

/** Default config directory: ~/.junecoder */
export const configDir = join(homedir(), '.junecoder');

/** Default configuration object. Callers can spread/override with user settings. */
export function defaultConfig() {
  return {
    agent: {
      maxTurns: 50,
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


