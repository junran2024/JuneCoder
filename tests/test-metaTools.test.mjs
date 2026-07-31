import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import {
  taskTool,
  planTool,
  skillTool,
  goalTool,
  verifyTool,
  subagentTool,
  metaTools,
  EXPLORE_OVERLAY,
  PLAN_OVERLAY,
  CODER_OVERLAY,
} from '../metaTools.mjs';

import { createAgent } from '../agent.mjs';

// ─── Helper ───────────────────────────────────────────────────────────────────

function freshAgent() {
  return createAgent({});
}

// ─── Structure checks ─────────────────────────────────────────────────────────

describe('meta tools - structure', () => {
  it('all 11 tools are present', () => {
    assert.strictEqual(metaTools.length, 11);
  });

  for (const tool of metaTools) {
    it(`${tool.name} has required fields`, () => {
      assert.ok(typeof tool.name === 'string' && tool.name.length > 0);
      assert.ok(typeof tool.description === 'string' && tool.description.length > 0);
      assert.ok(typeof tool.parameters === 'object');
      assert.ok(typeof tool.readonly === 'boolean');
      assert.ok(typeof tool.parallel === 'boolean');
      assert.ok(typeof tool.execute === 'function');
    });
  }
});

// ─── taskTool ─────────────────────────────────────────────────────────────────

describe('taskTool', () => {
  it('replaces task list and returns summary', async () => {
    const agent = freshAgent();
    const result = await taskTool.execute(
      {
        items: [
          { title: 'Add login', status: 'done' },
          { title: 'Add dashboard', status: 'in_progress' },
          { title: 'Add tests', status: 'pending' },
        ],
      },
      agent,
    );

    assert.strictEqual(agent.tasks.length, 3);
    assert.ok(result.includes('1/3 done'));
    assert.ok(result.includes('[done] Add login'));
    assert.ok(result.includes('[in_progress] Add dashboard'));
    assert.ok(result.includes('[pending] Add tests'));
  });

  it('resets _turnsSinceTaskUpdate', async () => {
    const agent = freshAgent();
    agent._turnsSinceTaskUpdate = 42;
    await taskTool.execute({ items: [] }, agent);
    assert.strictEqual(agent._turnsSinceTaskUpdate, 0);
  });

  it('handles empty items', async () => {
    const agent = freshAgent();
    const result = await taskTool.execute({ items: [] }, agent);
    assert.ok(result.includes('0/0 done'));
    assert.deepStrictEqual(agent.tasks, []);
  });
});

// ─── planTool ─────────────────────────────────────────────────────────────────

describe('planTool', () => {
  it('enters plan mode', async () => {
    const agent = freshAgent();
    const result = await planTool.execute({ action: 'enter' }, agent);
    assert.strictEqual(agent.planMode, true);
    assert.strictEqual(agent._turnsInPlanMode, 0);
    assert.ok(result.includes('Entered plan mode'));
  });

  it('exits plan mode', async () => {
    const agent = freshAgent();
    agent.planMode = true;
    agent._turnsInPlanMode = 5;
    const result = await planTool.execute({ action: 'exit' }, agent);
    assert.strictEqual(agent.planMode, false);
    assert.ok(result.includes('5 turns'));
  });

  it('rejects double enter', async () => {
    const agent = freshAgent();
    agent.planMode = true;
    const result = await planTool.execute({ action: 'enter' }, agent);
    assert.ok(result.includes('Already in plan mode'));
    assert.strictEqual(agent.planMode, true);
  });

  it('rejects double exit', async () => {
    const agent = freshAgent();
    const result = await planTool.execute({ action: 'exit' }, agent);
    assert.ok(result.includes('Not in plan mode'));
  });
});

// ─── skillTool ────────────────────────────────────────────────────────────────

describe('skillTool', () => {
  it('lists skills (stub returns empty)', async () => {
    const agent = freshAgent();
    const result = await skillTool.execute({ action: 'list' }, agent);
    assert.ok(result.includes('No skills loaded'));
  });

  it('load skill not found', async () => {
    const agent = freshAgent();
    const result = await skillTool.execute({ action: 'load', name: 'nonexistent' }, agent);
    assert.ok(result.includes('not found'));
  });

  it('load without name errors', async () => {
    const agent = freshAgent();
    const result = await skillTool.execute({ action: 'load' }, agent);
    assert.ok(result.includes('Error'));
  });
});

// ─── goalTool ─────────────────────────────────────────────────────────────────

describe('goalTool', () => {
  it('sets a goal', async () => {
    const agent = freshAgent();
    const result = await goalTool.execute(
      { action: 'set', objective: 'Fix all bugs', criteria: 'npm test passes' },
      agent,
    );
    assert.strictEqual(agent.goal.objective, 'Fix all bugs');
    assert.strictEqual(agent.goal.criteria, 'npm test passes');
    assert.strictEqual(agent.goal.status, 'active');
    assert.strictEqual(agent.goal.turnsUsed, 0);
    assert.strictEqual(agent.goal._blockTally, null);
    assert.ok(result.includes('Goal set'));
  });

  it('completes a goal', async () => {
    const agent = freshAgent();
    agent.goal = { objective: 'Test', criteria: '', startedAt: Date.now(), status: 'active', turnsUsed: 0, _blockTally: null };
    agent._mutatedThisRun = false;
    const result = await goalTool.execute({ action: 'complete' }, agent);
    assert.strictEqual(agent.goal.status, 'complete');
    assert.ok(result.includes('Goal marked complete'));
  });

  it('refuses complete when mutated but not verified', async () => {
    const agent = freshAgent();
    agent.goal = { objective: 'Test', criteria: '', startedAt: Date.now(), status: 'active', turnsUsed: 0, _blockTally: null };
    agent._mutatedThisRun = true;
    agent._verifiedThisRun = false;
    const result = await goalTool.execute({ action: 'complete' }, agent);
    assert.ok(result.includes('Error'));
    assert.strictEqual(agent.goal.status, 'active');
  });

  it('blocks a goal after 3 consecutive same-condition attempts', async () => {
    const agent = freshAgent();
    agent.goal = { objective: 'Hard', criteria: '', startedAt: Date.now(), status: 'active', turnsUsed: 0, _blockTally: null };
    // Attempt 1
    let result = await goalTool.execute({ action: 'blocked', reason: 'API down' }, agent);
    assert.ok(result.includes('1/3'));
    assert.strictEqual(agent.goal.status, 'active');
    // Attempt 2 — same reason
    result = await goalTool.execute({ action: 'blocked', reason: 'API down' }, agent);
    assert.ok(result.includes('2/3'));
    assert.strictEqual(agent.goal.status, 'active');
    // Attempt 3 — same reason, now accepted
    result = await goalTool.execute({ action: 'blocked', reason: 'API down' }, agent);
    assert.ok(result.includes('blocked after 3 attempts'));
    assert.strictEqual(agent.goal.status, 'blocked');
  });

  it('resets block tally when reason changes', async () => {
    const agent = freshAgent();
    agent.goal = { objective: 'Hard', criteria: '', startedAt: Date.now(), status: 'active', turnsUsed: 0, _blockTally: null };
    await goalTool.execute({ action: 'blocked', reason: 'API down' }, agent);
    await goalTool.execute({ action: 'blocked', reason: 'API down' }, agent);
    // Different reason — tally resets
    const result = await goalTool.execute({ action: 'blocked', reason: 'Different issue' }, agent);
    assert.ok(result.includes('1/3'));
  });

  it('cancels a goal', async () => {
    const agent = freshAgent();
    agent.goal = { objective: 'Cancel me', criteria: '', startedAt: Date.now(), attempts: 0 };
    const result = await goalTool.execute({ action: 'cancel' }, agent);
    assert.strictEqual(agent.goal, null);
    assert.ok(result.includes('Goal cancelled'));
  });

  it('errors on set without objective', async () => {
    const agent = freshAgent();
    const result = await goalTool.execute({ action: 'set' }, agent);
    assert.ok(result.includes('Error'));
  });
});

// ─── verifyTool ───────────────────────────────────────────────────────────────

describe('verifyTool', () => {
  it('returns verification report', async () => {
    const agent = freshAgent();
    agent.tasks = [
      { title: 'Do thing', status: 'done' },
    ];

    const result = await verifyTool.execute({}, agent);
    assert.ok(result.includes('VERIFICATION REPORT'));
    assert.ok(result.includes('Self-review checklist'));
    assert.ok(result.includes('[done] Do thing'));
    assert.strictEqual(agent._verifiedThisRun, true);
  });

  it('handles non-git directory', async () => {
    const agent = freshAgent();
    const tmp = mkdtempSync(join(tmpdir(), 'junecoder-verify-'));
    agent.cwd = tmp;
    try {
      const result = await verifyTool.execute({}, agent);
      assert.ok(result.includes('not a git repo') || result.includes('git unavailable'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('handles git repo with changes', async () => {
    const gitDir = mkdtempSync(join(tmpdir(), 'junecoder-verify-git-'));
    execSync('git init', { cwd: gitDir, stdio: 'ignore' });
    execSync('git config user.email "test@test.com"', { cwd: gitDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: gitDir, stdio: 'ignore' });

    // Create and commit a file, then modify it for unstaged diff
    writeFileSync(join(gitDir, 'readme.md'), 'v1');
    execSync('git add -A && git commit -m "init"', { cwd: gitDir, stdio: 'ignore' });
    writeFileSync(join(gitDir, 'readme.md'), 'v2');

    const agent = freshAgent();
    agent.cwd = gitDir;

    try {
      const result = await verifyTool.execute({}, agent);
      assert.ok(result.includes('VERIFICATION REPORT'));
      // Should show the diff (readme.md changed)
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  });

  it('shows no tasks when empty', async () => {
    const agent = freshAgent();
    const result = await verifyTool.execute({}, agent);
    assert.ok(result.includes('No active tasks'));
  });
});

// ─── subagentTool ─────────────────────────────────────────────────────────────

describe('subagentTool', () => {
  it('has correct structure', () => {
    assert.strictEqual(subagentTool.name, 'subagent');
    assert.strictEqual(subagentTool.readonly, true);
    assert.strictEqual(subagentTool.parallel, true);
  });

  it('executes and returns report (stub runAgent)', async () => {
    const agent = freshAgent();
    const result = await subagentTool.execute(
      { task: 'Say hello', role: 'explore' },
      agent,
    );

    // With runAgent stub, result should be a report containing "todo"
    assert.ok(typeof result === 'string');
  });
});

// ─── Overlays ─────────────────────────────────────────────────────────────────

describe('overlays', () => {
  it('EXPLORE_OVERLAY exists', () => {
    assert.ok(Array.isArray(EXPLORE_OVERLAY));
    assert.ok(EXPLORE_OVERLAY.length > 0);
  });

  it('PLAN_OVERLAY exists', () => {
    assert.ok(Array.isArray(PLAN_OVERLAY));
    assert.ok(PLAN_OVERLAY.length > 0);
  });

  it('CODER_OVERLAY exists', () => {
    assert.ok(Array.isArray(CODER_OVERLAY));
    assert.ok(CODER_OVERLAY.length > 0);
  });
});
