/**
 * Provider config loader — reads/writes ~/.junecoder/config.json.
 *
 * Key resolution order:
 *   1. ~/.junecoder/config.json  (interactive setup or /key command)
 *   2. ~/.junecoder/.env         (auto-migrated to config.json on first read)
 *   3. DEEPSEEK_API_KEY env var
 *
 * Config format:
 *   { providers: [{ name, baseURL, model, thinking, apiKey }], activeProvider }
 *
 * Per-provider defaults (model, baseURL, thinking) live in provider.mjs.
 * This module only persists and reads user config — no provider-specific knowledge.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { getProviderDefaults } from './provider.mjs';

const CONFIG_PATH = join(homedir(), '.junecoder', 'config.json');
const ENV_PATH = join(homedir(), '.junecoder', '.env');

/** Boot defaults — only used when no config.json exists yet. */
const DEFAULT_PROVIDERS = [
  { name: 'deepseek', ...getProviderDefaults('deepseek'), apiKey: '' },
];

function readConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    }
  } catch { /* corrupt or unreadable config — fall back to defaults so the agent can still start */ }
  return { providers: structuredClone(DEFAULT_PROVIDERS), activeProvider: 'deepseek' };
}

function writeConfig(config) {
  const dir = join(homedir(), '.junecoder');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/** Read DEEPSEEK_API_KEY from ~/.junecoder/.env, if present. */
function readEnvKey() {
  try {
    if (!existsSync(ENV_PATH)) return '';
    const content = readFileSync(ENV_PATH, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (key === 'DEEPSEEK_API_KEY') {
        return trimmed.slice(eq + 1).trim();
      }
    }
  } catch { /* .env is an optional legacy source — failure falls through to '' and the key is resolved elsewhere */ }
  return '';
}

/** Resolve the active provider from config, filling missing fields from the registry. */
export function getActiveProvider() {
  const config = readConfig();
  const p = config.providers.find(p => p.name === config.activeProvider)
    || config.providers[0]
    || DEFAULT_PROVIDERS[0];

  // Fill missing fields from provider defaults
  const defaults = getProviderDefaults(p.name) || {};
  const merged = { ...defaults, ...p, type: p.name };

  let apiKey = merged.apiKey || '';

  // Fallback: migrate from ~/.junecoder/.env
  if (!apiKey) {
    const envKey = readEnvKey();
    if (envKey) {
      apiKey = envKey;
      // Auto-migrate to config.json so next time we skip the .env read
      p.apiKey = envKey;
      writeConfig(config);
    }
  }

  // Last resort: OS env var
  if (!apiKey) {
    apiKey = process.env.DEEPSEEK_API_KEY || '';
  }

  return { ...merged, apiKey };
}

/** Persist API key. Called by /key in TUI. */
export function saveApiKey(providerName, apiKey) {
  const config = readConfig();
  const p = config.providers.find(p => p.name === providerName);
  if (p) p.apiKey = apiKey;
  writeConfig(config);
}

/** Persist model selection. Called by /model in TUI. */
export function saveModel(providerName, model) {
  const config = readConfig();
  const p = config.providers.find(p => p.name === providerName);
  if (p) p.model = model;
  writeConfig(config);
}
