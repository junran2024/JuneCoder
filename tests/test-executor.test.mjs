import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { executeToolCalls } from '../executor.mjs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function agent(overrides = {}) {
  return { planMode: false, ...overrides };
}

function mkTool(name, opts = {}) {
  return { name, ...opts };
}

function toolCall(id, name, args) {
  return { id, function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } };
}

function mapByName(tools) {
  const m = new Map();
  for (const t of tools) m.set(t.name, t);
  return m;
}

// ─── executeToolCalls ────────────────────────────────────────────────────────

describe('executeToolCalls', () => {
  it('returns empty array for empty toolCalls', async () => {
    const r = await executeToolCalls(agent(), new Map(), []);
    assert.deepStrictEqual(r, []);
  });

  it('returns empty array for null toolCalls', async () => {
    const r = await executeToolCalls(agent(), new Map(), null);
    assert.deepStrictEqual(r, []);
  });

  // ── Phase 1: Error cases ──────────────────────────────────────────────

  it('errors on invalid JSON arguments', async () => {
    const tc = [{ id: 'c1', function: { name: 'read', arguments: 'not json {{{' } }];
    const tools = mapByName([mkTool('read', { readonly: true, execute: async () => 'ok' })]);
    const r = await executeToolCalls(agent(), tools, tc);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].error, 'Invalid JSON arguments: not json {{{');
  });

  it('errors on unknown tool', async () => {
    const tc = [toolCall('c1', 'nonexistent', {})];
    const r = await executeToolCalls(agent(), new Map(), tc);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].error, 'Unknown tool: nonexistent');
  });

  // ── Plan mode ─────────────────────────────────────────────────────────

  it('rejects non-readonly tools in plan mode', async () => {
    const tc = [toolCall('c1', 'write', { path: '/tmp/x' })];
    const tools = mapByName([mkTool('write', { readonly: false, execute: async () => 'ok' })]);
    const a = agent({ planMode: true });
    const r = await executeToolCalls(a, tools, tc);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].denied, true);
    assert.ok(r[0].output.includes('not allowed in plan mode'));
  });

  it('allows readonly tools in plan mode', async () => {
    const tc = [toolCall('c1', 'read', { path: '/tmp/x' })];
    const tools = mapByName([mkTool('read', { readonly: true, execute: async () => 'hello' })]);
    const a = agent({ planMode: true });
    const r = await executeToolCalls(a, tools, tc);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].output, 'hello');
    assert.strictEqual(r[0].error, null);
  });

  // ── Permission ────────────────────────────────────────────────────────

  it('denies when onPermissionRequest returns false', async () => {
    const tc = [toolCall('c1', 'write', { path: '/x' })];
    const tools = mapByName([mkTool('write', { readonly: false, execute: async () => 'ok' })]);
    const cb = { onPermissionRequest: async () => false };
    const r = await executeToolCalls(agent(), tools, tc, cb);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].denied, true);
    assert.ok(r[0].output.includes('Permission denied'));
  });

  it('denies when onPermissionRequest returns { allowed: false }', async () => {
    const tc = [toolCall('c1', 'write', { path: '/x' })];
    const tools = mapByName([mkTool('write', { readonly: false, execute: async () => 'ok' })]);
    const cb = { onPermissionRequest: async () => ({ allowed: false, reason: 'not safe' }) };
    const r = await executeToolCalls(agent(), tools, tc, cb);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].denied, true);
    assert.ok(r[0].output.includes('Reason: not safe'));
  });

  it('allows when onPermissionRequest returns { allowed: true }', async () => {
    const tc = [toolCall('c1', 'write', { path: '/x' })];
    const tools = mapByName([mkTool('write', { readonly: false, execute: async () => 'written' })]);
    const cb = { onPermissionRequest: async () => ({ allowed: true }) };
    const r = await executeToolCalls(agent(), tools, tc, cb);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].output, 'written');
  });

  it('skips permission check for readonly tools', async () => {
    let called = false;
    const tc = [toolCall('c1', 'read', { path: '/x' })];
    const tools = mapByName([mkTool('read', { readonly: true, execute: async () => 'data' })]);
    const cb = { onPermissionRequest: async () => { called = true; return false; } };
    const r = await executeToolCalls(agent(), tools, tc, cb);
    assert.strictEqual(r[0].output, 'data');
    assert.strictEqual(called, false);
  });

  it('denies when onPermissionRequest throws', async () => {
    const tc = [toolCall('c1', 'write', { path: '/x' })];
    const tools = mapByName([mkTool('write', { readonly: false, execute: async () => 'ok' })]);
    const cb = { onPermissionRequest: async () => { throw new Error('boom'); } };
    const r = await executeToolCalls(agent(), tools, tc, cb);
    assert.strictEqual(r[0].denied, true);
  });

  // ── Parallel execution ────────────────────────────────────────────────

  it('executes readonly tools in parallel', async () => {
    const order = [];
    const tools = mapByName([
      mkTool('r1', { readonly: true, execute: async () => { order.push('r1'); return 'a'; } }),
      mkTool('r2', { readonly: true, execute: async () => { order.push('r2'); return 'b'; } }),
    ]);
    const tc = [toolCall('c1', 'r1', {}), toolCall('c2', 'r2', {})];
    const r = await executeToolCalls(agent(), tools, tc);
    assert.strictEqual(r.length, 2);
    assert.strictEqual(r[0].output, 'a');
    assert.strictEqual(r[1].output, 'b');
    // Both were called (parallel means order is not guaranteed, just check both ran)
    assert.ok(order.includes('r1'));
    assert.ok(order.includes('r2'));
  });

  it('executes explicit parallel tools together', async () => {
    const order = [];
    const tools = mapByName([
      mkTool('p1', { readonly: false, parallel: true, execute: async () => { order.push('p1'); return 'x'; } }),
      mkTool('p2', { readonly: false, parallel: true, execute: async () => { order.push('p2'); return 'y'; } }),
    ]);
    const tc = [toolCall('c1', 'p1', {}), toolCall('c2', 'p2', {})];
    const cb = { onPermissionRequest: async () => ({ allowed: true }) };
    const r = await executeToolCalls(agent(), tools, tc, cb);
    assert.strictEqual(r.length, 2);
    assert.ok(order.includes('p1'));
    assert.ok(order.includes('p2'));
  });

  // ── Serial execution ──────────────────────────────────────────────────

  it('executes non-readonly, non-parallel tools serially', async () => {
    const order = [];
    let barrierResolve;
    const barrier = new Promise(r => { barrierResolve = r; });

    const tools = mapByName([
      mkTool('s1', {
        readonly: false,
        execute: async () => {
          order.push('s1-start');
          await barrier;
          order.push('s1-end');
          return 'first';
        },
      }),
      mkTool('s2', {
        readonly: false,
        execute: async () => {
          order.push('s2');
          return 'second';
        },
      }),
    ]);
    const tc = [toolCall('c1', 's1', {}), toolCall('c2', 's2', {})];
    const cb = { onPermissionRequest: async () => ({ allowed: true }) };

    const resultP = executeToolCalls(agent(), tools, tc, cb);

    // s1 should have started but s2 should not
    await new Promise(r => setTimeout(r, 20));
    assert.deepStrictEqual(order, ['s1-start']);

    // Release s1
    barrierResolve();
    const r = await resultP;

    // s1 finished before s2 started
    assert.deepStrictEqual(order, ['s1-start', 's1-end', 's2']);
    assert.strictEqual(r[0].output, 'first');
    assert.strictEqual(r[1].output, 'second');
  });

  // ── Tool execution error ──────────────────────────────────────────────

  it('captures tool execution errors', async () => {
    const tc = [toolCall('c1', 'fail', {})];
    const tools = mapByName([mkTool('fail', {
      readonly: true,
      execute: async () => { throw new Error('tool exploded'); },
    })]);
    const r = await executeToolCalls(agent(), tools, tc);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].error, 'tool exploded');
    assert.strictEqual(r[0].output, null);
  });

  it('handles non-Error throws from tools', async () => {
    const tc = [toolCall('c1', 'fail', {})];
    const tools = mapByName([mkTool('fail', {
      readonly: true,
      execute: async () => { throw 'string error'; },
    })]);
    const r = await executeToolCalls(agent(), tools, tc);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].error, 'string error');
  });

  // ── JSON.stringify for non-string results ─────────────────────────────

  it('stringifies non-string tool results', async () => {
    const tc = [toolCall('c1', 'obj', {})];
    const tools = mapByName([mkTool('obj', {
      readonly: true,
      execute: async () => ({ key: 'value' }),
    })]);
    const r = await executeToolCalls(agent(), tools, tc);
    assert.strictEqual(r[0].output, '{"key":"value"}');
  });

  // ── Callbacks ─────────────────────────────────────────────────────────

  it('invokes onToolCall for each tool', async () => {
    const calls = [];
    const tc = [
      toolCall('c1', 'r1', { x: 1 }),
      toolCall('c2', 'r2', { y: 2 }),
    ];
    const tools = mapByName([
      mkTool('r1', { readonly: true, execute: async () => 'a' }),
      mkTool('r2', { readonly: true, execute: async () => 'b' }),
    ]);
    const cb = { onToolCall: (name, args) => calls.push({ name, args }) };
    await executeToolCalls(agent(), tools, tc, cb);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0].name, 'r1');
    assert.deepStrictEqual(calls[0].args, { x: 1 });
    assert.strictEqual(calls[1].name, 'r2');
    assert.deepStrictEqual(calls[1].args, { y: 2 });
  });

  it('invokes onToolOutput after each tool', async () => {
    const outputs = [];
    const tc = [toolCall('c1', 'r1', {})];
    const tools = mapByName([mkTool('r1', { readonly: true, execute: async () => 'result' })]);
    const cb = { onToolOutput: (name, output, error) => outputs.push({ name, output, error }) };
    await executeToolCalls(agent(), tools, tc, cb);
    assert.strictEqual(outputs.length, 1);
    assert.strictEqual(outputs[0].name, 'r1');
    assert.strictEqual(outputs[0].output, 'result');
    assert.strictEqual(outputs[0].error, null);
  });

  // ── Results order ─────────────────────────────────────────────────────

  it('preserves original toolCalls order in results', async () => {
    const tc = [
      toolCall('c1', 'second', {}),
      toolCall('c2', 'first', {}),
    ];
    const tools = mapByName([
      mkTool('first', { readonly: true, execute: async () => 'first' }),
      mkTool('second', { readonly: true, execute: async () => 'second' }),
    ]);
    const r = await executeToolCalls(agent(), tools, tc);
    assert.strictEqual(r[0].name, 'second');
    assert.strictEqual(r[1].name, 'first');
    assert.strictEqual(r[0].id, 'c1');
    assert.strictEqual(r[1].id, 'c2');
  });

  // ── Mixed: some error, some success ───────────────────────────────────

  it('handles mixed valid and invalid tool calls', async () => {
    const tc = [
      { id: 'c1', function: { name: 'read', arguments: 'bad json' } },
      toolCall('c2', 'read', { path: '/ok' }),
    ];
    const tools = mapByName([mkTool('read', { readonly: true, execute: async () => 'contents' })]);
    const r = await executeToolCalls(agent(), tools, tc);
    assert.strictEqual(r.length, 2);
    assert.ok(r[0].error);
    assert.strictEqual(r[1].output, 'contents');
  });

  // ── Long result offload ──────────────────────────────────────────────

  it('offloads long non-read tool results to disk', async () => {
    const longStr = 'x'.repeat(9000);
    const tc = [toolCall('c1', 'grep', { pattern: 'x' })];
    const tools = mapByName([mkTool('grep', {
      readonly: true,
      execute: async () => longStr,
    })]);
    const r = await executeToolCalls(agent(), tools, tc);
    assert.ok(r[0].output.includes('[Result offloaded:'));
    assert.ok(r[0].output.includes('junecoder/tool-results'));
    // Preview should be present
    assert.ok(r[0].output.startsWith('x'.repeat(500)));
  });

  it('truncates long read tool results without offloading', async () => {
    const longStr = 'a'.repeat(9000);
    const tc = [toolCall('c1', 'read', { path: '/x' })];
    const tools = mapByName([mkTool('read', {
      readonly: true,
      execute: async () => longStr,
    })]);
    const r = await executeToolCalls(agent(), tools, tc);
    assert.ok(r[0].output.includes('[Read output truncated:'));
    assert.ok(r[0].output.includes('offset/limit'));
    assert.ok(!r[0].output.includes('[Result offloaded'));
  });

  // ── Auto-generated call IDs ───────────────────────────────────────────

  it('generates call IDs when missing', async () => {
    const tc = [{ function: { name: 'read', arguments: '{}' } }];
    const tools = mapByName([mkTool('read', { readonly: true, execute: async () => 'ok' })]);
    const r = await executeToolCalls(agent(), tools, tc);
    assert.strictEqual(r.length, 1);
    assert.ok(r[0].id.startsWith('call_'));
  });
});
