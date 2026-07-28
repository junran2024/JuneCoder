/**
 * Configuration module — provides configDir path and default config factory.
 *
 * The config object is passed into createAgent() externally; this module
 * provides the directory for config files and default values.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';

// Load .env files before any code reads process.env.
// Must happen here (not cli.mjs) because ESM static imports are hoisted —
// this module's body runs before cli.mjs's body.
for (const envPath of ['.env', join(homedir(), '.junecoder', '.env')]) {
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
      goalTurns: 30,
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

/**
 * Load user config from configDir/config.json.
 * Returns merged config: defaults overridden by user settings.
 */
export function loadConfig(dir = configDir) {
  const defaults = defaultConfig();
  const configPath = join(dir, 'config.json');

  if (!existsSync(configPath)) return defaults;

  try {
    const raw = readFileSync(configPath, 'utf-8');
    const user = JSON.parse(raw);
    return deepMerge(defaults, user);
  } catch {
    return defaults;
  }
}

/** Shallow-ish deep merge: only merges top-level objects. */
function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      typeof base[key] === 'object' &&
      base[key] !== null &&
      !Array.isArray(base[key]) &&
      typeof override[key] === 'object' &&
      override[key] !== null
    ) {
      result[key] = { ...base[key], ...override[key] };
    } else {
      result[key] = override[key];
    }
  }
  return result;
}
