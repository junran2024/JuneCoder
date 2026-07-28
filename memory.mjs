/**
 * Memory module — search and reindex for the agent's long-term memory.
 *
 * Memory is a simple keyword-search store backed by JSON files on disk.
 * The `memory` object shape: { dir: string, entries?: MemoryEntry[] }.
 *
 * Each memory entry: { id, content, source, tags, timestamp }.
 */

import { join, basename } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Default memory directory */
export function memoryDir() {
  return join(homedir(), '.junecoder', 'memory');
}

/** Load all memory entries from disk. */
function loadEntries(dir) {
  if (!existsSync(dir)) return [];
  let files;
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const entries = [];
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const raw = readFileSync(join(dir, f), 'utf-8');
      entries.push(JSON.parse(raw));
    } catch {
      // skip corrupt files
    }
  }
  return entries;
}

/** Save a single entry to disk. */
function saveEntry(dir, entry) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch { /* dir exists */ }
  writeFileSync(join(dir, entry.id + '.json'), JSON.stringify(entry, null, 2), 'utf-8');
}

/** Generate a content-based ID. */
function hashId(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/** Simple tokenizer: lowercase, split on non-word chars, filter short tokens. */
function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .filter((t) => t.length > 1);
}

/** Score a memory entry against query tokens. */
function scoreEntry(entry, queryTokens) {
  const contentTokens = tokenize(entry.content);
  const tagTokens = tokenize((entry.tags || '').join(' '));
  const allTokens = [...contentTokens, ...tagTokens];

  let score = 0;
  const seen = new Set();
  for (const qt of queryTokens) {
    if (seen.has(qt)) continue;
    seen.add(qt);
    for (const t of allTokens) {
      if (t === qt) {
        score += 1;
      } else if (t.includes(qt) || qt.includes(t)) {
        score += 0.5;
      }
    }
  }
  return score;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Search the agent's memory.
 * @param {object} memory - memory instance with { dir, entries? }
 * @param {string} input - query string
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<string>} formatted search results
 */
export async function search(memory, input, opts = {}) {
  if (!memory) return '';

  const dir = memory.dir || memoryDir();
  const limit = opts.limit || 5;
  const queryTokens = tokenize(input);
  if (queryTokens.length === 0) return '';

  // Load entries (from cache or disk)
  let entries = memory.entries;
  if (!entries) {
    entries = loadEntries(dir);
    memory.entries = entries;
  }

  if (entries.length === 0) return '';

  // Score and rank
  const scored = entries
    .map((e) => ({ entry: e, score: scoreEntry(e, queryTokens) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (scored.length === 0) return '';

  return scored
    .map((s) => {
      const e = s.entry;
      const preview = e.content.length > 200
        ? e.content.slice(0, 200) + '...'
        : e.content;
      const tags = e.tags?.length ? ` [${e.tags.join(', ')}]` : '';
      return `- ${preview}${tags} (source: ${e.source || 'unknown'})`;
    })
    .join('\n');
}

/**
 * Re-index a file in the agent's memory.
 * Reads the file content and stores it as a memory entry.
 * @param {object} memory - memory instance
 * @param {string} cwd - working directory
 * @param {string} absPath - absolute path of the file that changed
 */
export async function reindexFile(memory, cwd, absPath) {
  if (!memory) return;

  const dir = memory.dir || memoryDir();

  // Read the file
  let content;
  try {
    content = readFileSync(absPath, 'utf-8');
  } catch {
    return; // can't read — skip
  }

  // Skip overly large files (avoid blowing up memory)
  if (content.length > 50000) return;

  const id = hashId(absPath + content.slice(0, 1000));
  const fileName = basename(absPath);

  const entry = {
    id,
    content: `File ${fileName}: ${content.slice(0, 2000)}`,
    source: absPath,
    tags: ['file', fileName],
    timestamp: Date.now(),
  };

  // Update in-memory cache
  let entries = memory.entries;
  if (!entries) {
    entries = loadEntries(dir);
    memory.entries = entries;
  }

  // Replace existing entry with same source
  const idx = entries.findIndex((e) => e.source === absPath);
  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }

  // Persist to disk
  saveEntry(dir, entry);
}

/**
 * Save a memory entry manually (called by memory_put tool).
 * @param {object} memory - memory instance
 * @param {object} entry - { type, title, content, tags, scope }
 * @returns {Promise<string>} status message
 */
export async function put(memory, entry) {
  if (!memory) return 'no memory store';

  const dir = memory.dir || memoryDir();
  const id = hashId(entry.content || entry.title || String(Date.now()));

  const record = {
    id,
    content: `[${entry.type || 'knowledge'}] ${entry.title || ''}: ${entry.content}`,
    source: entry.scope || 'manual',
    tags: [...(entry.tags || []), entry.type || 'knowledge'],
    timestamp: Date.now(),
  };

  // Update in-memory cache
  let entries = memory.entries;
  if (!entries) {
    entries = loadEntries(dir);
    memory.entries = entries;
  }
  entries.push(record);

  saveEntry(dir, record);
  return `saved: ${entry.title || id}`;
}

