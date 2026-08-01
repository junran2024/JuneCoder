import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  configDir,
  defaultConfig,
} from '../config.mjs';

// ─── defaultConfig ───────────────────────────────────────────────────────────

describe('defaultConfig', () => {
  it('returns agent section with expected defaults', () => {
    const cfg = defaultConfig();
    assert.strictEqual(cfg.agent.maxTurns, 100);
    assert.strictEqual(cfg.agent.subagentTurns, 20);
    assert.strictEqual(cfg.agent.goalTurns, 200);
    assert.ok(cfg.agent.contextWindow > 0);
    assert.ok(cfg.agent.compactThreshold > 0);
  });

  it('returns provider section with defaults', () => {
    const cfg = defaultConfig();
    assert.strictEqual(cfg.provider.type, 'deepseek');
    assert.strictEqual(cfg.provider.model, 'deepseek-v4-pro');
    assert.strictEqual(cfg.provider.baseURL, 'https://api.deepseek.com');
    assert.strictEqual(cfg.provider.apiKey, '');
    assert.deepStrictEqual(cfg.provider.thinking, { type: 'enabled' });
  });

  it('returns a fresh object each call', () => {
    const a = defaultConfig();
    const b = defaultConfig();
    a.agent.maxTurns = 999;
    assert.strictEqual(b.agent.maxTurns, 100);
  });
});

// ─── configDir ───────────────────────────────────────────────────────────────

describe('configDir', () => {
  it('is a non-empty string', () => {
    assert.ok(typeof configDir === 'string' && configDir.length > 0);
  });
});
