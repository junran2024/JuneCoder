import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import {
  createCheckpoint,
  listCheckpoints,
  rewind,
  isGitRepo,
} from '../checkpoint.mjs';

// ─── isGitRepo ───────────────────────────────────────────────────────────────

describe('isGitRepo', () => {
  it('returns true inside a git repo', () => {
    assert.strictEqual(isGitRepo(process.cwd()), true);
  });

  it('returns false outside a git repo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'junecoder-nogit-'));
    try {
      assert.strictEqual(isGitRepo(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── createCheckpoint ────────────────────────────────────────────────────────

describe('createCheckpoint', () => {
  let gitDir;

  before(() => {
    gitDir = mkdtempSync(join(tmpdir(), 'junecoder-cp-'));
    execSync('git init', { cwd: gitDir, stdio: 'ignore' });
    execSync('git config user.email "t@t.com"', { cwd: gitDir, stdio: 'ignore' });
    execSync('git config user.name "T"', { cwd: gitDir, stdio: 'ignore' });
  });

  after(() => {
    rmSync(gitDir, { recursive: true, force: true });
  });

  it('skips stash when working tree has uncommitted changes', async () => {
    // Write an uncommitted file — simulates user's unsaved work
    writeFileSync(join(gitDir, 'change.txt'), 'hello');
    execSync('git add change.txt', { cwd: gitDir, stdio: 'ignore' });

    const before = (await listCheckpoints(gitDir)).length;
    await createCheckpoint(gitDir);
    const after = (await listCheckpoints(gitDir)).length;
    // Must NOT stash — would hide user's work
    assert.strictEqual(after, before);
  });

  it('no-ops in non-git directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'junecoder-nogit2-'));
    try {
      // Should not throw
      await createCheckpoint(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── listCheckpoints ─────────────────────────────────────────────────────────

describe('listCheckpoints', () => {
  it('returns an array', async () => {
    const result = await listCheckpoints(process.cwd());
    assert.ok(Array.isArray(result));
  });

  it('returns an array for non-git directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'junecoder-nostash-'));
    try {
      const result = await listCheckpoints(dir);
      assert.deepStrictEqual(result, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── rewind ──────────────────────────────────────────────────────────────────

describe('rewind', () => {
  it('returns not-implemented message', async () => {
    const result = await rewind(process.cwd(), 0);
    assert.ok(result.includes('not implemented'));
  });
});
