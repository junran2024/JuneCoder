/**
 * Provider config loader — reads/writes ~/.junecoder/config.json.
 *
 * Config format:
 *   { providers: [{ name, baseURL, model, thinking, apiKey }], activeProvider }
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const CONFIG_PATH = join(homedir(), '.junecoder', 'config.json');

const DEFAULT_PROVIDERS = [
  {
    name: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    model: 'deepseek-v4-pro',
    thinking: { type: 'enabled' },
    apiKey: '',
  },
];

function readConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch { /* corrupt — use defaults */ }
  return { providers: structuredClone(DEFAULT_PROVIDERS), activeProvider: 'deepseek' };
}

function writeConfig(config) {
  const dir = join(homedir(), '.junecoder');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/** Falls back to DEEPSEEK_API_KEY env var. */
export function getActiveProvider() {
  const config = readConfig();
  const p = config.providers.find(p => p.name === config.activeProvider)
    || config.providers[0]
    || DEFAULT_PROVIDERS[0];
  return { ...p, type: p.name, apiKey: p.apiKey || process.env.DEEPSEEK_API_KEY || '' };
}

/** Persist API key. Called by /key in TUI. */
export function saveApiKey(providerName, apiKey) {
  const config = readConfig();
  const p = config.providers.find(p => p.name === providerName);
  if (p) p.apiKey = apiKey;
  writeConfig(config);
}
