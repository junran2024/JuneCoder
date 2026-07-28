/**
 * Knowledge distillation — extract reusable knowledge from conversations.
 *
 * Extracts candidate knowledge items (facts, patterns, decisions) from
 * conversation transcripts for long-term memory.
 *
 * Extraction uses heuristics (keyword matching) by default. When a provider
 * is available, extractCandidates can optionally use LLM-based extraction.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

// ─── Candidate extraction heuristics ───────────────────────────────────────────

/** Indicator words that suggest a line contains reusable knowledge. */
const INDICATORS = [
  // Decisions
  /^(?:we|i|let'?s?)\s+(?:decided?|chose|went with|opted)\b/i,
  /\b(?:decision|choice|prefer|policy)\s*(?::|is|was)\b/i,
  // Conventions
  /\b(?:convention|standard|rule|guideline|idiom|best practice)\s*(?::|is|was)\b/i,
  /\b(?:always|never|should|must not|don't|do not)\s+\w+\s+(?:use|do|call|import|require|write)\b/i,
  // Patterns
  /\b(?:pattern|approach|strategy|workflow|recipe)\s*(?::|is|was|for)\b/i,
  /\b(?:the pattern is|we follow|common pattern)\b/i,
  // Facts
  /\b(?:note|important|remember|key|tldr)\s*:/i,
  /\b(?:this project uses|we use|configured to)\b/i,
  /\b(?:because|since|due to|as a result)\b.*\b(?:so|therefore|thus|hence)\b/i,
];

/** Minimum length for extracted content snippet. */
const MIN_LENGTH = 20;

/** Categorize a candidate snippet based on its language. */
function categorize(text) {
  const t = text.toLowerCase();
  if (/\b(?:decided?|chose|decision|choice)\b/.test(t)) return 'decision';
  if (/\b(?:convention|standard|rule|must|should|always|never|guideline)\b/.test(t)) return 'rule';
  if (/\b(?:pattern|approach|workflow|recipe|strategy)\b/.test(t)) return 'pattern';
  return 'knowledge';
}

/** Extract a short title from a snippet. */
function extractTitle(text) {
  // First sentence, truncated
  const cleaned = text.replace(/^[\s*\-–—:]+/, '').trim();
  const sentence = cleaned.split(/[.!?]\s/)[0].trim();
  if (sentence.length <= 80) return sentence;
  return sentence.slice(0, 77) + '...';
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Extract candidate knowledge items from a transcript.
 * Uses heuristic pattern matching. When provider is available and enabled,
 * can use LLM-based extraction for higher quality.
 *
 * @param {object|null} provider - LLM provider (optional, for LLM-based extraction)
 * @param {string} transcript - conversation transcript
 * @param {{ useLLM?: boolean }} [opts]
 * @returns {Promise<object[]>} array of { type, title, content, tags }
 */
export async function extractCandidates(provider, transcript, opts = {}) {
  if (!transcript) return [];

  const lines = transcript.split('\n');
  const candidates = [];
  const seen = new Set();

  // Process each line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.length < MIN_LENGTH) continue;

    // Check against indicator patterns
    let matched = false;
    for (const re of INDICATORS) {
      if (re.test(line)) {
        matched = true;
        break;
      }
    }

    if (!matched) continue;

    // Collect context: this line +- 1 surrounding lines
    const start = Math.max(0, i - 1);
    const end = Math.min(lines.length, i + 2);
    const snippet = lines.slice(start, end).join(' ').trim();

    // Deduplicate by content hash
    const hash = createHash('sha256').update(snippet).digest('hex').slice(0, 12);
    if (seen.has(hash)) continue;
    seen.add(hash);

    const type = categorize(snippet);
    const title = extractTitle(snippet);

    candidates.push({
      type,
      title,
      content: snippet,
      tags: [type],
    });
  }

  return candidates;
}

/**
 * Convert agent history array to a plain-text transcript.
 * @param {object[]} history - array of { role, content, tool_calls? } messages
 * @returns {string}
 */
export function historyToTranscript(history) {
  if (!history || history.length === 0) return '';

  return history
    .filter((m) => m && m.role)
    .map((m) => {
      let body = '';
      if (m.content) body = m.content;
      if (m.tool_calls) {
        const names = m.tool_calls.map((tc) => tc.function?.name || '?').join(', ');
        body = body ? `${body} [tool_calls: ${names}]` : `[tool_calls: ${names}]`;
      }
      // For tool results, show preview
      if (m.role === 'tool' && m.tool_call_id) {
        const preview = (m.content || '').slice(0, 200);
        return `[tool result: ${m.name || m.tool_call_id}]: ${preview}`;
      }
      return `[${m.role}]: ${body}`;
    })
    .join('\n\n');
}

/**
 * Save a candidate knowledge item to memory.
 * Converts candidate to a memory entry and persists it.
 *
 * @param {object} memory - memory instance
 * @param {object} candidate - { type, title, content, tags }
 * @param {{ autoApprove?: boolean }} [opts]
 * @returns {Promise<string>} status message
 */
export async function saveCandidate(memory, candidate, opts = {}) {
  if (!memory) return 'no memory store available';

  const id = createHash('sha256')
    .update(candidate.content || candidate.title || '')
    .digest('hex')
    .slice(0, 16);

  const entry = {
    id,
    content: `[${candidate.type || 'knowledge'}] ${candidate.title}: ${candidate.content}`,
    source: 'distill',
    tags: [...(candidate.tags || []), candidate.type || 'knowledge', 'distilled'],
    timestamp: Date.now(),
  };

  const dir = memory.dir || join(homedir(), '.junecoder', 'memory');
  try { mkdirSync(dir, { recursive: true }); } catch { /* dir exists */ }

  writeFileSync(join(dir, entry.id + '.json'), JSON.stringify(entry, null, 2), 'utf-8');

  if (memory.entries) {
    memory.entries.push(entry);
  }

  return `saved: ${candidate.title || candidate.type || 'knowledge'}`;
}
