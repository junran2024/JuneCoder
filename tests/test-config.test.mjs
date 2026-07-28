import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  configDir,
  defaultConfig,
  loadConfig,
} from '../config.mjs';

// ─── defaultConfig ───────────────────────────────────────────────────────────

describe('defaultConfig', () => {
  it('returns agent section with expected defaults', () => {
    const cfg = defaultConfig();
    assert.strictEqual(cfg.agent.maxTurns, 50);
    assert.strictEqual(cfg.agent.subagentTurns, 20);
    assert.strictEqual(cfg.agent.goalTurns, 30);
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
    assert.strictEqual(b.agent.maxTurns, 50);
  });
});

// ─── loadConfig ──────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'junecoder-cfg-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns defaults when no config file exists', () => {
    const cfg = loadConfig(tmpDir);
    assert.strictEqual(cfg.agent.maxTurns, 50);
  });

  it('merges user overrides', () => {
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({
      agent: { maxTurns: 100 },
      provider: { model: 'custom-model' },
    }));
    const cfg = loadConfig(tmpDir);
    assert.strictEqual(cfg.agent.maxTurns, 100);
    assert.strictEqual(cfg.agent.subagentTurns, 20); // default preserved
    assert.strictEqual(cfg.provider.model, 'custom-model');
    assert.strictEqual(cfg.provider.type, 'deepseek'); // default preserved
  });

  it('returns defaults on invalid JSON', () => {
    writeFileSync(join(tmpDir, 'config.json'), 'not valid json {{{');
    const cfg = loadConfig(tmpDir);
    assert.strictEqual(cfg.agent.maxTurns, 50);
  });

  it('deep merges nested provider object', () => {
    writeFileSync(join(tmpDir, 'config.json'), JSON.stringify({
      provider: { thinking: { type: 'disabled' } },
    }));
    const cfg = loadConfig(tmpDir);
    assert.strictEqual(cfg.provider.thinking.type, 'disabled');
    assert.strictEqual(cfg.provider.model, 'deepseek-v4-pro'); // preserved
  });
});

// ─── configDir ───────────────────────────────────────────────────────────────

describe('configDir', () => {
  it('is a non-empty string', () => {
    assert.ok(typeof configDir === 'string' && configDir.length > 0);
  });
});
