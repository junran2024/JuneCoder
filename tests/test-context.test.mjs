import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPRESS_FAILURE_LIMIT,
  estimateTokens,
  compressIfNeeded,
  compressFallback,
  checkAndCompress,
} from '../context.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

describe('COMPRESS_FAILURE_LIMIT', () => {
  it('is 3', () => {
    assert.strictEqual(COMPRESS_FAILURE_LIMIT, 3);
  });
});

// ─── estimateTokens ───────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('returns 0 for empty array', () => {
    assert.strictEqual(estimateTokens([]), 0);
  });

  it('returns 0 for null/undefined', () => {
    assert.strictEqual(estimateTokens(null), 0);
  });

  it('estimates from content', () => {
    // "Hello, this is a test message here!" = 36 chars / 4 = 9 tokens
    const msgs = [{ role: 'user', content: 'Hello, this is a test message here!' }];
    assert.strictEqual(estimateTokens(msgs), 9);
  });

  it('includes tool_calls in estimate', () => {
    const msgs = [{
      role: 'assistant',
      content: null,
      tool_calls: [{ function: { name: 'read', arguments: '{"path":"/x"}' } }],
    }];
    const tokens = estimateTokens(msgs);
    // Should count the JSON of tool_calls
    assert.ok(tokens > 0);
  });
});

// ─── compressIfNeeded (stub) ──────────────────────────────────────────────────

describe('compressIfNeeded', () => {
  it('returns false when under threshold', async () => {
    const agent = { history: [{ role: 'user', content: 'hi' }] };
    const result = await compressIfNeeded(agent, 1000);
    assert.strictEqual(result, false);
  });

  it('returns false when over threshold but LLM call fails (no provider)', async () => {
    const agent = { history: [{ role: 'user', content: 'x'.repeat(10000) }] };
    const result = await compressIfNeeded(agent, 10);
    assert.strictEqual(result, false);
  });
});

// ─── compressFallback ─────────────────────────────────────────────────────────

describe('compressFallback', () => {
  it('keeps system messages at top', () => {
    const agent = {
      history: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'reply1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'reply2' },
        { role: 'user', content: 'msg3' },
        { role: 'assistant', content: 'reply3' },
        { role: 'user', content: 'msg4' },
        { role: 'assistant', content: 'reply4' },
        { role: 'user', content: 'msg5' },
        { role: 'assistant', content: 'reply5' },
        { role: 'user', content: 'msg6' },
        { role: 'assistant', content: 'reply6' },
        { role: 'user', content: 'msg7' },
        { role: 'assistant', content: 'reply7' },
      ],
      _compressFailures: 5,
    };

    compressFallback(agent, 4);

    // System should still be first
    assert.strictEqual(agent.history[0].role, 'system');
    assert.strictEqual(agent.history[0].content, 'You are helpful.');

    // Second should be the truncation note (transient)
    assert.strictEqual(agent.history[1].role, 'user');
    assert.ok(agent.history[1]._transient);
    assert.ok(agent.history[1].content.includes('truncated'));

    // Should have exactly keepRecent recent messages after system + note
    assert.strictEqual(agent.history.length, 1 + 1 + 4); // system + note + 4 recent

    // Failure counter reset
    assert.strictEqual(agent._compressFailures, 0);
  });

  it('no-op when history is short enough', () => {
    const history = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hey' },
    ];
    const agent = { history: [...history], _compressFailures: 3 };

    compressFallback(agent, 10);

    // Should be unchanged
    assert.deepStrictEqual(agent.history, history);
    assert.strictEqual(agent._compressFailures, 0);
  });

  it('handles empty history gracefully', () => {
    const agent = { history: [], _compressFailures: 3 };
    compressFallback(agent);
    assert.deepStrictEqual(agent.history, []);
  });

  it('never leaves orphaned tool messages at the cut boundary', () => {
    const agent = {
      history: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'start' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'r1' },
        { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'r2' },
        { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'r3' },
        { role: 'tool', tool_call_id: 'c1', name: 'read', content: 'r4' },
      ],
      _compressFailures: 3,
    };

    compressFallback(agent, 4); // cut lands inside the tool batch

    // Leading orphan tool messages must be dropped, not kept
    assert.strictEqual(agent.history.filter((m) => m.role === 'tool').length, 0);
    assert.strictEqual(agent.history[0].role, 'system');
  });
});

// ─── checkAndCompress ─────────────────────────────────────────────────────────

describe('checkAndCompress', () => {
  it('returns false when threshold is 0 (disabled)', async () => {
    const agent = { history: [], _compressFailures: 0 };
    const result = await checkAndCompress(agent, 0);
    assert.strictEqual(result, false);
  });

  it('increments failure counter when above threshold', async () => {
    const agent = {
      history: [{ role: 'user', content: 'x'.repeat(5000) }],
      _compressFailures: 0,
    };
    // Above threshold (10 tokens), but compressIfNeeded returns false (stub)
    const result = await checkAndCompress(agent, 10);
    assert.strictEqual(result, false);
    assert.strictEqual(agent._compressFailures, 1);
  });

  it('does not count under-threshold turns as failures', async () => {
    const agent = {
      history: [{ role: 'user', content: 'short message' }],
      _compressFailures: 0,
    };
    // Way under threshold: no counting, no fallback, history untouched
    for (let i = 0; i < COMPRESS_FAILURE_LIMIT + 2; i++) {
      const result = await checkAndCompress(agent, 1_000_000);
      assert.strictEqual(result, false);
    }
    assert.strictEqual(agent._compressFailures, 0);
    assert.strictEqual(agent.history.length, 1);
  });

  it('triggers fallback after COMPRESS_FAILURE_LIMIT failures', async () => {
    const agent = {
      history: [
        { role: 'user', content: '1' },
        { role: 'assistant', content: '2' },
        { role: 'user', content: '3' },
        { role: 'assistant', content: '4' },
        { role: 'user', content: '5' },
        { role: 'assistant', content: '6' },
      ],
      _compressFailures: COMPRESS_FAILURE_LIMIT - 1,
    };
    // Next failure should trigger fallback
    const result = await checkAndCompress(agent, 1);
    assert.strictEqual(result, true);
    assert.strictEqual(agent._compressFailures, 0);
    // History should have been truncated
    assert.ok(agent.history.length < 7);
  });
});
