import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpHome;
let oldHome;
let mod;

function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'junecoder-prompt-'));
  mkdirSync(join(dir, '.junecoder'), { recursive: true });
  return dir;
}

async function reloadMod() {
  const ts = Date.now();
  return await import(`../prompt.mjs?reload=${ts}`);
}

describe('prompt', () => {
  before(async () => {
    tmpHome = freshHome();
    oldHome = process.env.HOME;
    process.env.HOME = tmpHome;
    mod = await reloadMod();
  });

  after(() => {
    process.env.HOME = oldHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('DEFAULT_SYSTEM_PROMPT', () => {
    it('is a non-empty string', () => {
      assert.ok(typeof mod.DEFAULT_SYSTEM_PROMPT === 'string');
      assert.ok(mod.DEFAULT_SYSTEM_PROMPT.length > 100);
    });

    it('contains JuneCoder agent identity', () => {
      assert.ok(mod.DEFAULT_SYSTEM_PROMPT.includes('JuneCoder'));
      assert.ok(mod.DEFAULT_SYSTEM_PROMPT.includes('coding agent'));
    });
  });

  describe('GOAL_MODE_PREAMBLE', () => {
    it('is a non-empty string', () => {
      assert.ok(typeof mod.GOAL_MODE_PREAMBLE === 'string');
      assert.ok(mod.GOAL_MODE_PREAMBLE.length > 50);
    });

    it('mentions goal mode', () => {
      assert.ok(mod.GOAL_MODE_PREAMBLE.includes('goal'));
    });
  });

  describe('loadProjectInstructions', () => {
    it('returns empty string when no instruction files exist', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'junecoder-empty-'));
      try {
        const r = mod.loadProjectInstructions(cwd);
        assert.strictEqual(r, '');
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it('loads AGENTS.md from cwd', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'junecoder-agents-'));
      writeFileSync(join(cwd, 'AGENTS.md'), 'Always use tabs.');
      try {
        const r = mod.loadProjectInstructions(cwd);
        assert.ok(r.includes('--- AGENTS.md ---'));
        assert.ok(r.includes('Always use tabs.'));
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it('loads AGENTS.md from ~/.junecoder/', () => {
      const globalPath = join(tmpHome, '.junecoder', 'AGENTS.md');
      writeFileSync(globalPath, 'Global project rules.');
      const cwd = mkdtempSync(join(tmpdir(), 'junecoder-global-'));
      try {
        const r = mod.loadProjectInstructions(cwd);
        assert.ok(r.includes('Global project rules.'));
      } finally {
        rmSync(globalPath, { force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it('loads PROJECT_RULES.md', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'junecoder-rules-'));
      writeFileSync(join(cwd, 'PROJECT_RULES.md'), 'No console.log allowed.');
      try {
        const r = mod.loadProjectInstructions(cwd);
        assert.ok(r.includes('PROJECT_RULES.md'));
        assert.ok(r.includes('No console.log allowed.'));
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it('loads .cursorrules', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'junecoder-cursor-'));
      writeFileSync(join(cwd, '.cursorrules'), 'Cursor-specific rules.');
      try {
        const r = mod.loadProjectInstructions(cwd);
        assert.ok(r.includes('.cursorrules'));
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it('loads .windsurfrules', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'junecoder-wind-'));
      writeFileSync(join(cwd, '.windsurfrules'), 'Windsurf rules.');
      try {
        const r = mod.loadProjectInstructions(cwd);
        assert.ok(r.includes('.windsurfrules'));
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it('combines multiple instruction files', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'junecoder-multi-'));
      writeFileSync(join(cwd, 'AGENTS.md'), 'Rule A.');
      writeFileSync(join(cwd, 'PROJECT_RULES.md'), 'Rule B.');
      try {
        const r = mod.loadProjectInstructions(cwd);
        assert.ok(r.includes('Rule A.'));
        assert.ok(r.includes('Rule B.'));
        assert.ok(r.includes('--- AGENTS.md ---'));
        assert.ok(r.includes('--- PROJECT_RULES.md ---'));
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it('skips empty instruction files', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'junecoder-skip-'));
      writeFileSync(join(cwd, 'AGENTS.md'), '   \n  \n');
      writeFileSync(join(cwd, 'PROJECT_RULES.md'), 'Actual rules.');
      try {
        const r = mod.loadProjectInstructions(cwd);
        assert.ok(!r.includes('AGENTS.md'));
        assert.ok(r.includes('PROJECT_RULES.md'));
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });

  describe('buildSystemPrompt', () => {
    it('returns a string containing working directory', () => {
      const agent = { cwd: '/test/dir' };
      const prompt = mod.buildSystemPrompt(agent, 0);
      assert.ok(prompt.includes('/test/dir'));
      assert.ok(prompt.includes('JuneCoder'));
    });

    it('includes sub-agent note when depth > 0', () => {
      const agent = { cwd: '/test/dir' };
      const prompt = mod.buildSystemPrompt(agent, 2);
      assert.ok(prompt.includes('sub-agent'));
      assert.ok(prompt.includes('depth 2'));
    });

    it('does not include sub-agent note at depth 0', () => {
      const agent = { cwd: '/test/dir' };
      const prompt = mod.buildSystemPrompt(agent, 0);
      assert.ok(!prompt.includes('sub-agent'));
    });

    it('applies overlay text when present', () => {
      const agent = { cwd: '/test/dir', overlay: 'SPECIAL OVERLAY MODE' };
      const prompt = mod.buildSystemPrompt(agent, 0);
      assert.ok(prompt.includes('SPECIAL OVERLAY MODE'));
    });

    it('handles array overlay', () => {
      const agent = { cwd: '/test/dir', overlay: ['Line 1', 'Line 2'] };
      const prompt = mod.buildSystemPrompt(agent, 0);
      assert.ok(prompt.includes('Line 1\nLine 2'));
    });

    it('appends project instructions when present', () => {
      const cwd = mkdtempSync(join(tmpdir(), 'junecoder-build-'));
      writeFileSync(join(cwd, 'AGENTS.md'), 'Custom project instructions.');
      try {
        const agent = { cwd };
        const prompt = mod.buildSystemPrompt(agent, 0);
        assert.ok(prompt.includes('Custom project instructions.'));
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  });
});
