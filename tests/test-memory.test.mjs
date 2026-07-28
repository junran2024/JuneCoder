import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { memoryDir, search, reindexFile, put } from '../memory.mjs';

// ─── memoryDir ───────────────────────────────────────────────────────────────

describe('memoryDir', () => {
  it('returns a path ending in memory', () => {
    const dir = memoryDir();
    assert.ok(dir.endsWith('memory'));
    assert.ok(dir.includes('.junecoder'));
  });
});

// ─── search ──────────────────────────────────────────────────────────────────

describe('search', () => {
  let memDir;

  before(() => {
    memDir = mkdtempSync(join(tmpdir(), 'junecoder-mem-'));
  });

  after(() => {
    rmSync(memDir, { recursive: true, force: true });
  });

  it('returns empty string for null memory', async () => {
    const result = await search(null, 'test');
    assert.strictEqual(result, '');
  });

  it('returns empty string when no entries loaded', async () => {
    const result = await search({ dir: memDir }, 'keyword');
    assert.strictEqual(result, '');
  });

  it('returns empty string for empty query', async () => {
    const result = await search({ dir: memDir }, '');
    assert.strictEqual(result, '');
  });

  it('finds entries by content match', async () => {
    // Pre-populate a memory entry
    await put({ dir: memDir }, {
      type: 'knowledge',
      title: 'Test Entry',
      content: 'The answer is 42',
      tags: ['testing'],
    });
    const result = await search({ dir: memDir }, 'answer');
    assert.ok(result.includes('42'));
  });

  it('finds entries by tag match', async () => {
    await put({ dir: memDir }, {
      type: 'rule',
      title: 'Coding Rule',
      content: 'Use tabs not spaces',
      tags: ['coding', 'style'],
    });
    const result = await search({ dir: memDir }, 'coding');
    assert.ok(result.includes('tabs'));
  });

  it('returns empty string for no matches', async () => {
    const result = await search({ dir: memDir }, 'zzzznomatch9999');
    assert.strictEqual(result, '');
  });

  it('respects limit option', async () => {
    await put({ dir: memDir }, { type: 'k', title: 'A', content: 'common phrase here' });
    await put({ dir: memDir }, { type: 'k', title: 'B', content: 'also has phrase' });
    await put({ dir: memDir }, { type: 'k', title: 'C', content: 'phrase again' });
    const result = await search({ dir: memDir }, 'phrase', { limit: 2 });
    const lines = result.split('\n').filter(Boolean);
    assert.ok(lines.length <= 2);
  });
});

// ─── put ─────────────────────────────────────────────────────────────────────

describe('put', () => {
  let memDir;

  before(() => {
    memDir = mkdtempSync(join(tmpdir(), 'junecoder-put-'));
  });

  after(() => {
    rmSync(memDir, { recursive: true, force: true });
  });

  it('saves an entry and returns status', async () => {
    const result = await put({ dir: memDir }, {
      type: 'knowledge',
      title: 'My Note',
      content: 'Important info here',
      tags: ['note'],
    });
    assert.ok(result.startsWith('saved'));
  });

  it('returns message for null memory', async () => {
    const result = await put(null, { title: 'x', content: 'y' });
    assert.strictEqual(result, 'no memory store');
  });
});

// ─── reindexFile ─────────────────────────────────────────────────────────────

describe('reindexFile', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'junecoder-reidx-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no-ops when memory is null', async () => {
    // Should not throw
    await reindexFile(null, tmpDir, join(tmpDir, 'x.txt'));
  });

  it('indexes a file', async () => {
    const filePath = join(tmpDir, 'code.js');
    writeFileSync(filePath, 'export const x = 1;');
    const memDir = mkdtempSync(join(tmpdir(), 'junecoder-reidxmem-'));
    try {
      await reindexFile({ dir: memDir }, tmpDir, filePath);
      // Search should find it
      const result = await search({ dir: memDir }, 'code.js');
      assert.ok(result.length > 0);
    } finally {
      rmSync(memDir, { recursive: true, force: true });
    }
  });

  it('skips missing files gracefully', async () => {
    const memDir = mkdtempSync(join(tmpdir(), 'junecoder-reidxmiss-'));
    try {
      await reindexFile({ dir: memDir }, tmpDir, join(tmpDir, 'no-such-file.txt'));
      // Should not throw
    } finally {
      rmSync(memDir, { recursive: true, force: true });
    }
  });
});
