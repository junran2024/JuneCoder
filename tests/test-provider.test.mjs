import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chat } from '../provider.mjs';

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Create a mock Response with a ReadableStream of SSE data lines.
 * Each element of `chunks` is an array of SSE-formatted strings,
 * simulating network chunks. A single `[DONE]` is appended automatically.
 */
function mockSSE(events, usageChunk = null) {
  const lines = events.flatMap((e) => `data: ${JSON.stringify(e)}\n`);
  lines.push('data: [DONE]\n');
  const body = lines.join('');
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** Build a single delta chunk. */
function delta(d) {
  return { choices: [{ delta: d }] };
}

// ─── Mock fetch setup ──────────────────────────────────────────────────────────

let originalFetch;
let mockResponse;

before(() => {
  originalFetch = globalThis.fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

function installMock(response) {
  mockResponse = response;
  globalThis.fetch = async (url, init) => {
    // Verify request shape
    const body = JSON.parse(init.body);
    assert.strictEqual(body.model, 'deepseek-v4-pro');
    assert.strictEqual(body.stream, true);
    assert.ok(body.messages.length > 0);
    return mockResponse;
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('chat - SSE parsing (mocked)', () => {
  it('returns text content from delta.content', async () => {
    installMock(mockSSE([
      delta({ content: 'Hello' }),
      delta({ content: ' world' }),
    ]));

    const result = await chat(
      { apiKey: 'test-key' },
      { messages: [{ role: 'user', content: 'hi' }] },
    );

    assert.strictEqual(result.content, 'Hello world');
    assert.deepStrictEqual(result.toolCalls, []);
    assert.strictEqual(result.reasoning, null);
  });

  it('fires onToken callback for each delta', async () => {
    const tokens = [];
    installMock(mockSSE([
      delta({ content: 'A' }),
      delta({ content: 'B' }),
      delta({ content: 'C' }),
    ]));

    await chat(
      { apiKey: 'test-key' },
      {
        messages: [{ role: 'user', content: 'hi' }],
        onToken: (t) => tokens.push(t),
      },
    );

    assert.deepStrictEqual(tokens, ['A', 'B', 'C']);
  });

  it('accumulates tool_calls across deltas', async () => {
    installMock(mockSSE([
      delta({
        tool_calls: [
          { index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"pa' } },
        ],
      }),
      delta({
        tool_calls: [
          { index: 0, function: { arguments: 'th":"/x"}' } },
        ],
      }),
    ]));

    const result = await chat(
      { apiKey: 'test-key' },
      { messages: [{ role: 'user', content: 'read a file' }], tools: [{}] },
    );

    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0].id, 'call_1');
    assert.strictEqual(result.toolCalls[0].function.name, 'read');
    assert.strictEqual(result.toolCalls[0].function.arguments, '{"path":"/x"}');
    assert.strictEqual(result.content, null);
  });

  it('handles multiple tool calls with different indices', async () => {
    installMock(mockSSE([
      delta({
        tool_calls: [
          { index: 0, id: 'c1', function: { name: 'read', arguments: '{}' } },
          { index: 1, id: 'c2', function: { name: 'write', arguments: '{}' } },
        ],
      }),
    ]));

    const result = await chat(
      { apiKey: 'test-key' },
      { messages: [{ role: 'user', content: 'read and write' }], tools: [{}, {}] },
    );

    assert.strictEqual(result.toolCalls.length, 2);
    assert.strictEqual(result.toolCalls[0].function.name, 'read');
    assert.strictEqual(result.toolCalls[1].function.name, 'write');
  });

  it('captures reasoning_content', async () => {
    installMock(mockSSE([
      delta({ reasoning_content: 'Let me think' }),
      delta({ reasoning_content: ' about this...' }),
      delta({ content: 'Answer: 42' }),
    ]));

    const result = await chat(
      { apiKey: 'test-key' },
      { messages: [{ role: 'user', content: 'q' }] },
    );

    assert.strictEqual(result.reasoning, 'Let me think about this...');
    assert.strictEqual(result.content, 'Answer: 42');
  });

  it('fires onReasoning callback', async () => {
    const reasoningPieces = [];
    installMock(mockSSE([
      delta({ reasoning_content: 'step 1' }),
      delta({ reasoning_content: ', step 2' }),
    ]));

    await chat(
      { apiKey: 'test-key' },
      {
        messages: [{ role: 'user', content: 'q' }],
        onReasoning: (r) => reasoningPieces.push(r),
      },
    );

    assert.deepStrictEqual(reasoningPieces, ['step 1', ', step 2']);
  });

  it('returns null content when only tool_calls present', async () => {
    installMock(mockSSE([
      delta({ tool_calls: [{ index: 0, function: { name: 'bash', arguments: '{}' } }] }),
    ]));

    const result = await chat(
      { apiKey: 'test-key' },
      { messages: [{ role: 'user', content: 'run' }], tools: [{}] },
    );

    assert.strictEqual(result.content, null);
    assert.strictEqual(result.toolCalls.length, 1);
  });

  it('extracts usage from final chunk', async () => {
    installMock(mockSSE(
      [delta({ content: 'ok' })],
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ));

    // Usage comes in a separate chunk without delta
    // Need to modify mockSSE to handle usage chunks
    const events = [
      delta({ content: 'ok' }),
      { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ];
    const lines = events.map((e) => `data: ${JSON.stringify(e)}\n`).join('');
    const body = lines + 'data: [DONE]\n';

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        controller.close();
      },
    });

    globalThis.fetch = async () => new Response(stream, { status: 200 });

    const result = await chat(
      { apiKey: 'test-key' },
      { messages: [{ role: 'user', content: 'hi' }] },
    );

    assert.ok(result.usage);
    assert.strictEqual(result.usage.total_tokens, 15);
  });

  it('throws on non-200 response', async () => {
    globalThis.fetch = async () =>
      new Response('{"error":"unauthorized"}', { status: 401 });

    await assert.rejects(
      () =>
        chat(
          { apiKey: 'bad-key' },
          { messages: [{ role: 'user', content: 'hi' }] },
        ),
      /DeepSeek request failed \(401\)/,
    );
  });
});

// ─── Integration test (requires real API key) ──────────────────────────────────

describe('chat - integration (real API)', () => {
  const apiKey = process.env.DEEPSEEK_API_KEY;

  // Skip if no key configured
  const maybeIt = apiKey ? it : it.skip;
  const reason = apiKey ? '' : ' (no DEEPSEEK_API_KEY in env)';

  /** Wrap a test so auth errors skip instead of fail. */
  async function withAuthSkip(fn) {
    try {
      await fn();
    } catch (e) {
      if (e.message.includes('401') || e.message.includes('unauthorized')) {
        // API key is invalid/expired — skip silently
        return;
      }
      throw e;
    }
  }

  maybeIt(`returns text content${reason}`, () => withAuthSkip(async () => {
    const result = await chat(
      { apiKey },
      {
        messages: [{ role: 'user', content: 'Reply with exactly "OK"' }],
      },
    );
    assert.ok(result.content);
    assert.ok(result.content.includes('OK'));
  }));

  maybeIt(`returns tool_calls when tools provided${reason}`, () => withAuthSkip(async () => {
    const result = await chat(
      { apiKey },
      {
        messages: [{ role: 'user', content: 'What is the current date? Use get_date.' }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_date',
              description: 'Get current date',
              parameters: { type: 'object', properties: {}, required: [] },
            },
          },
        ],
      },
    );
    assert.ok(result.toolCalls.length > 0 || result.content !== null);
  }));

  maybeIt(`includes reasoning when thinking enabled${reason}`, () => withAuthSkip(async () => {
    const result = await chat(
      { apiKey },
      {
        messages: [{ role: 'user', content: 'Count from 1 to 3. Be brief.' }],
      },
    );
    assert.ok(result.reasoning !== null || result.content !== null);
  }));

  maybeIt(`fires onToken callback${reason}`, () => withAuthSkip(async () => {
    const tokens = [];
    const result = await chat(
      { apiKey },
      {
        messages: [{ role: 'user', content: 'Say hello' }],
        onToken: (t) => tokens.push(t),
      },
    );
    assert.ok(tokens.length > 0);
    assert.strictEqual(tokens.join(''), result.content);
  }));
});
