import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  sessionPath,
  saveSession,
  loadSession,
  clearSession,
  archiveCurrent,
  listSlots,
  switchToSlot,
} from '../session.mjs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tmpdirCtx() {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'junecoder-sess-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });
  return () => dir;
}

function freshAgent(cwd) {
  return {
    cwd,
    history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hey' }],
    planMode: false,
    tasks: [],
    goal: null,
  };
}

// ─── sessionPath ─────────────────────────────────────────────────────────────

describe('sessionPath', () => {
  it('returns a .json path', () => {
    const p = sessionPath('/home/user/my project');
    assert.ok(p.endsWith('.json'));
    assert.ok(p.includes('sessions'));
  });

  it('encodes special chars in path', () => {
    const p = sessionPath('/a/b/c');
    assert.ok(!p.includes('/a/b/c'));
  });
});

// ─── saveSession / loadSession ───────────────────────────────────────────────

describe('saveSession + loadSession', () => {
  const getDir = tmpdirCtx();

  it('saves and loads a session', () => {
    const dir = getDir();
    const agent = freshAgent(dir);
    agent.goal = { objective: 'finish', criteria: 'tests pass' };
    const displayLines = [
      { text: '❯ You:', role: 'labelUser' },
      { text: 'hello', role: 'text' },
      { text: '', role: 'dim' },
    ];

    saveSession(agent, displayLines);
    const restored = loadSession(dir);

    assert.ok(restored);
    assert.strictEqual(restored.cwd, dir);
    assert.strictEqual(restored.history.length, 2);
    assert.strictEqual(restored.goal.objective, 'finish');
    assert.deepStrictEqual(restored.displayLines, displayLines);
    assert.strictEqual(restored.planMode, false);
    assert.ok(restored.savedAt > 0);
  });

  it('survives saving agent with null goal', () => {
    const dir = getDir();
    const agent = freshAgent(dir);
    agent.goal = null;
    saveSession(agent, []);
    const restored = loadSession(dir);
    assert.ok(restored);
    assert.strictEqual(restored.goal, null);
  });

  it('persists roles but never ANSI color codes', () => {
    const dir = getDir();
    const agent = freshAgent(dir);
    const displayLines = [
      { text: '❯ JuneCoder:', role: 'labelAssistant' },
      { text: 'hello', role: 'text' },
      { text: '', role: 'dim' },
      { text: '  [tool] bash ls', role: 'tool' },
    ];

    saveSession(agent, displayLines);
    const restored = loadSession(dir);

    // Roles survive the roundtrip untouched
    assert.deepStrictEqual(restored.displayLines, displayLines);
    // The file itself must not contain any escape sequences
    const raw = JSON.stringify(restored);
    assert.ok(!raw.includes('\x1b'), 'session file must not contain ANSI escapes');
  });

  it('strips ANSI from text; un-role\'d legacy lines fall back to the text role', () => {
    const dir = getDir();
    const agent = freshAgent(dir);
    const displayLines = [
      'plain \x1b[31mred\x1b[0m text',
      '',
      '❯ JuneCoder: hello',
      '  [tool] bash pwd',
    ];

    saveSession(agent, displayLines);
    const restored = loadSession(dir);

    assert.deepStrictEqual(restored.displayLines, [
      { text: 'plain red text', role: 'text' },
      { text: '', role: 'text' },
      { text: '❯ JuneCoder: hello', role: 'text' },
      { text: '  [tool] bash pwd', role: 'text' },
    ]);
  });

  it('cleans legacy { text, color } files on load without keeping color', () => {
    const dir = getDir();
    const agent = freshAgent(dir);
    // Simulate a file saved by an older version: { text, color } objects with escapes
    const legacy = {
      cwd: dir,
      history: [],
      displayLines: [{ text: 'legacy', color: '\x1b[33m' }],
      planMode: false,
      goal: null,
      tasks: [],
      savedAt: 0,
    };
    writeFileSync(sessionPath(dir), JSON.stringify(legacy), 'utf-8');

    const restored = loadSession(dir);
    assert.deepStrictEqual(restored.displayLines, [{ text: 'legacy', role: 'text' }]);
  });
});

// ─── loadSession (null) ─────────────────────────────────────────────────────

describe('loadSession - null', () => {
  const getDir = tmpdirCtx();

  it('returns null when no session exists', () => {
    const dir = getDir();
    const result = loadSession(dir);
    assert.strictEqual(result, null);
  });
});

// ─── clearSession ────────────────────────────────────────────────────────────

describe('clearSession', () => {
  const getDir = tmpdirCtx();

  it('clears saved session', () => {
    const dir = getDir();
    const agent = freshAgent(dir);
    saveSession(agent, []);
    assert.ok(existsSync(sessionPath(dir)));
    clearSession(dir);
    assert.ok(!existsSync(sessionPath(dir)));
  });

  it('no-ops when no session exists', () => {
    const dir = getDir();
    // Should not throw
    clearSession(dir);
  });
});

// ─── archiveCurrent ──────────────────────────────────────────────────────────

describe('archiveCurrent', () => {
  const getDir = tmpdirCtx();

  it('archives current session with timestamp', () => {
    const dir = getDir();
    const agent = freshAgent(dir);
    saveSession(agent, []);

    const beforePath = sessionPath(dir);
    assert.ok(existsSync(beforePath));

    archiveCurrent(dir);

    // Original should be gone
    assert.ok(!existsSync(beforePath));

    // At least one slot should exist
    const slots = listSlots(dir);
    assert.ok(slots.length >= 1);
  });

  it('no-ops when no session exists', () => {
    const dir = getDir();
    // Should not throw
    archiveCurrent(dir);
  });
});

// ─── listSlots ───────────────────────────────────────────────────────────────

describe('listSlots', () => {
  const getDir = tmpdirCtx();

  it('returns empty array when no sessions', () => {
    const dir = getDir();
    const slots = listSlots(dir);
    assert.deepStrictEqual(slots, []);
  });

  it('lists archived sessions', () => {
    const dir = getDir();
    const agent = freshAgent(dir);
    saveSession(agent, []);
    archiveCurrent(dir);

    const slots = listSlots(dir);
    assert.ok(slots.length > 0);
    assert.ok(slots[0].file.endsWith('.json'));
    assert.ok(typeof slots[0].timestamp === 'number');
    assert.ok(typeof slots[0].label === 'string');
  });
});

// ─── switchToSlot ────────────────────────────────────────────────────────────

describe('switchToSlot', () => {
  const getDir = tmpdirCtx();

  it('switches to an archived slot', () => {
    const dir = getDir();
    const agent = freshAgent(dir);
    saveSession(agent, []);
    archiveCurrent(dir);

    // Now save a new session
    const agent2 = freshAgent(dir);
    saveSession(agent2, []);

    // Switch back to the archived one
    const slots = listSlots(dir);
    const restored = switchToSlot(dir, slots[0].file);
    assert.ok(restored);
  });

  it('returns null for non-existent slot', () => {
    const dir = getDir();
    const result = switchToSlot(dir, 'nonexistent.json');
    assert.strictEqual(result, null);
  });
});
