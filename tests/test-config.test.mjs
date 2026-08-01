import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  configDir,
  defaultAgentConfig,
} from '../config.mjs';

// ─── defaultAgentConfig ──────────────────────────────────────────────────────

describe('defaultAgentConfig', () => {
  it('returns agent defaults referencing the exported constants', () => {
    const cfg = defaultAgentConfig();
    assert.strictEqual(cfg.maxTurns, 100);
    assert.strictEqual(cfg.subagentTurns, 20);
    assert.strictEqual(cfg.goalTurns, 200);
    assert.ok(cfg.contextWindow > 0);
    assert.ok(cfg.compactThreshold > 0);
  });

  it('returns a fresh object each call', () => {
    const a = defaultAgentConfig();
    const b = defaultAgentConfig();
    a.maxTurns = 999;
    assert.strictEqual(b.maxTurns, 100);
  });
});

// ─── configDir ───────────────────────────────────────────────────────────────

describe('configDir', () => {
  it('is a non-empty string', () => {
    assert.ok(typeof configDir === 'string' && configDir.length > 0);
  });
});
