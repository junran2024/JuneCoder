import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  DEFAULT_MAX_TURNS,
  DEFAULT_SUBAGENT_TURNS,
  DEFAULT_GOAL_TURNS,
  MIN_REPORT_CHARS,
  REPORT_CONTINUATION,
  TOOL_RESULT_OFFLOAD_LIMIT,
  TOOL_RESULT_PREVIEW,
  MAX_INSTRUCTION_CHARS,
} from '../config.mjs';
import {
  escapeXml,
  tryCanonicalize,
  repairHistory,
  createAgent,
  runAgent,
  ContinueError,
} from '../agent.mjs';
import { loadProjectInstructions } from '../prompt.mjs';

// ─── Constants ────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('DEFAULT_MAX_TURNS is positive', () => {
    assert.ok(DEFAULT_MAX_TURNS > 0 && Number.isInteger(DEFAULT_MAX_TURNS));
  });
  it('DEFAULT_SUBAGENT_TURNS is positive', () => {
    assert.ok(DEFAULT_SUBAGENT_TURNS > 0);
  });
  it('DEFAULT_GOAL_TURNS is positive', () => {
    assert.ok(DEFAULT_GOAL_TURNS > 0);
  });
  it('MIN_REPORT_CHARS is positive', () => {
    assert.ok(MIN_REPORT_CHARS > 0);
  });
  it('TOOL_RESULT_OFFLOAD_LIMIT is positive', () => {
    assert.ok(TOOL_RESULT_OFFLOAD_LIMIT > 0);
  });
  it('TOOL_RESULT_PREVIEW is less than offload limit', () => {
    assert.ok(TOOL_RESULT_PREVIEW < TOOL_RESULT_OFFLOAD_LIMIT);
  });
  it('MAX_INSTRUCTION_CHARS is 32000', () => {
    assert.strictEqual(MAX_INSTRUCTION_CHARS, 32_000);
  });
  it('REPORT_CONTINUATION is non-empty string', () => {
    assert.ok(typeof REPORT_CONTINUATION === 'string' && REPORT_CONTINUATION.length > 0);
  });
});

// ─── escapeXml ─────────────────────────────────────────────────────────────────

describe('escapeXml', () => {
  it('escapes &', () => {
    assert.strictEqual(escapeXml('a&b'), 'a&amp;b');
  });
  it('escapes <', () => {
    assert.strictEqual(escapeXml('a<b'), 'a&lt;b');
  });
  it('escapes >', () => {
    assert.strictEqual(escapeXml('a>b'), 'a&gt;b');
  });
  it('escapes all three together', () => {
    assert.strictEqual(escapeXml('<a>&"b"'), '&lt;a&gt;&amp;"b"');
  });
  it('passes through normal text', () => {
    assert.strictEqual(escapeXml('hello world'), 'hello world');
  });
  it('handles empty string', () => {
    assert.strictEqual(escapeXml(''), '');
  });
  it('coerces non-strings', () => {
    assert.strictEqual(escapeXml(123), '123');
    assert.strictEqual(escapeXml(null), 'null');
  });
});

// ─── tryCanonicalize ───────────────────────────────────────────────────────────

describe('tryCanonicalize', () => {
  it('canonicalizes object args', () => {
    assert.strictEqual(tryCanonicalize('read', { path: '/x' }), 'read:{"path":"/x"}');
  });
  it('canonicalizes string args by parsing first', () => {
    assert.strictEqual(tryCanonicalize('read', '{"path":"/x"}'), 'read:{"path":"/x"}');
  });
  it('handles null args', () => {
    assert.strictEqual(tryCanonicalize('bash', null), 'bash:');
  });
  it('handles undefined args', () => {
    assert.strictEqual(tryCanonicalize('bash', undefined), 'bash:');
  });
  it('returns null for invalid JSON string', () => {
    assert.strictEqual(tryCanonicalize('cmd', 'not json'), null);
  });
  it('sorted keys: same semantic object produces same sig', () => {
    const a = tryCanonicalize('f', { b: 1, a: 2 });
    const b = tryCanonicalize('f', { a: 2, b: 1 });
    assert.strictEqual(a, b);
  });
});

// ─── repairHistory ─────────────────────────────────────────────────────────────

describe('repairHistory', () => {
  it('strips transient messages', () => {
    const input = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q', transient: true },
      { role: 'assistant', content: 'a' },
    ];
    const out = repairHistory(input);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].role, 'system');
    assert.strictEqual(out[1].role, 'assistant');
  });

  it('strips _transient messages too', () => {
    const input = [
      { role: 'user', content: 'q', _transient: true },
      { role: 'assistant', content: 'a' },
    ];
    const out = repairHistory(input);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].role, 'assistant');
  });

  it('skips messages without valid role', () => {
    const input = [
      { role: 'system', content: 'sys' },
      {},
      null,
      { content: 'no role' },
      { role: 'user', content: 'q' },
    ];
    const out = repairHistory(input);
    assert.strictEqual(out.length, 2);
  });

  it('moves system message to index 0 if not first', () => {
    const input = [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'a' },
    ];
    const out = repairHistory(input);
    assert.strictEqual(out[0].role, 'system');
    assert.strictEqual(out[1].role, 'user');
    assert.strictEqual(out[2].role, 'assistant');
  });

  it('preserves tool_calls field', () => {
    const input = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: '1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
    ];
    const out = repairHistory(input);
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(out[0].tool_calls, input[0].tool_calls);
  });

  it('drops orphaned tool messages without matching tool_calls', () => {
    const input = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      { role: 'tool', tool_call_id: 'ghost', name: 'read', content: 'orphan' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'real', type: 'function', function: { name: 'read', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'real', name: 'read', content: 'ok' },
    ];
    const out = repairHistory(input);
    const tools = out.filter((m) => m.role === 'tool');
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].tool_call_id, 'real');
  });

  it('preserves reasoning_content', () => {
    const input = [
      { role: 'assistant', content: 'ok', reasoning_content: 'thinking...' },
    ];
    const out = repairHistory(input);
    assert.strictEqual(out[0].reasoning_content, 'thinking...');
  });

  it('returns empty array for non-array input', () => {
    assert.deepStrictEqual(repairHistory(null), []);
    assert.deepStrictEqual(repairHistory(undefined), []);
    assert.deepStrictEqual(repairHistory('not array'), []);
  });

  it('does not mutate original', () => {
    const input = [
      { role: 'user', content: 'q', transient: true },
      { role: 'assistant', content: 'a' },
    ];
    const copy = JSON.parse(JSON.stringify(input));
    repairHistory(input);
    assert.deepStrictEqual(input, copy);
  });
});

// ─── loadProjectInstructions ───────────────────────────────────────────────────

describe('loadProjectInstructions', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'junecoder-instr-'));
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty string when no instruction files exist', () => {
    const out = loadProjectInstructions(tmpDir);
    assert.strictEqual(out, '');
  });

  it('reads AGENTS.md', () => {
    writeFileSync(join(tmpDir, 'AGENTS.md'), 'Be nice.');
    const out = loadProjectInstructions(tmpDir);
    assert.ok(out.includes('Be nice.'));
    assert.ok(out.includes('AGENTS.md'));
  });

  it('reads PROJECT_RULES.md', () => {
    writeFileSync(join(tmpDir, 'PROJECT_RULES.md'), 'Use tabs.');
    const out = loadProjectInstructions(tmpDir);
    assert.ok(out.includes('Use tabs.'));
    assert.ok(out.includes('PROJECT_RULES.md'));
  });

  it('truncates when exceeding MAX_INSTRUCTION_CHARS', () => {
    const bigContent = 'x'.repeat(MAX_INSTRUCTION_CHARS + 100);
    writeFileSync(join(tmpDir, 'AGENTS.md'), bigContent);
    const out = loadProjectInstructions(tmpDir);
    assert.ok(out.includes('WARNING'));
    assert.ok(out.length <= MAX_INSTRUCTION_CHARS + 200); // + warning text
  });
});

// ─── createAgent ───────────────────────────────────────────────────────────────

describe('createAgent', () => {
  it('returns an object with default fields', () => {
    const agent = createAgent({});
    assert.deepStrictEqual(agent.provider, {});
    assert.deepStrictEqual(agent.tools, []);
    assert.deepStrictEqual(agent.history, []);
    assert.deepStrictEqual(agent.tasks, []);
    assert.strictEqual(agent.planMode, false);
    assert.strictEqual(agent.goal, null);
  });

  it('accepts custom provider', () => {
    const agent = createAgent({ provider: 'deepseek' });
    assert.strictEqual(agent.provider, 'deepseek');
  });

  it('accepts custom tools', () => {
    const tools = [{ name: 'read' }];
    const agent = createAgent({ tools });
    assert.deepStrictEqual(agent.tools, tools);
  });

  it('uses provided cwd', () => {
    const agent = createAgent({ cwd: '/tmp/test' });
    assert.strictEqual(agent.cwd, '/tmp/test');
  });

  it('initializes _permQueue to resolved promise', async () => {
    const agent = createAgent({});
    await agent._permQueue; // should not throw or hang
  });
});

// ─── runAgent (stub) ───────────────────────────────────────────────────────────

describe('runAgent', () => {
  it('is an async function', () => {
    assert.strictEqual(typeof runAgent, 'function');
    assert.ok(runAgent.constructor.name === 'AsyncFunction');
  });

  it('throws when no valid provider configured', async () => {
    const agent = createAgent({});
    // Without a valid provider, runAgent will fail on the LLM call
    let threw = false;
    try {
      await runAgent(agent, 'test', {}, { depth: 0 });
    } catch (err) {
      threw = true;
      assert.ok(err instanceof Error);
    }
    assert.ok(threw, 'Expected runAgent to throw without valid provider');
  });
});
