import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tmpHome;
let oldHome;
let mod;

function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'junecoder-mcp-'));
  mkdirSync(join(dir, '.junecoder', 'mcp'), { recursive: true });
  return dir;
}

async function reloadMod() {
  const ts = Date.now();
  return await import(`../mcp.mjs?reload=${ts}`);
}

let oldUserProfile;

describe('mcp', () => {
  before(async () => {
    tmpHome = freshHome();
    oldHome = process.env.HOME;
    oldUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    mod = await reloadMod();
  });

  after(() => {
    process.env.HOME = oldHome;
    process.env.USERPROFILE = oldUserProfile;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('loadMcpProjects', () => {
    it('returns empty array when no mcp dir exists', () => {
      // rm the mcp dir
      rmSync(join(tmpHome, '.junecoder', 'mcp'), { recursive: true, force: true });
      // use a cwd that also has no .junecoder/mcp
      const projects = mod.loadMcpProjects(tmpHome);
      assert.deepStrictEqual(projects, []);
    });

    it('loads project from ~/.junecoder/mcp/*.json', () => {
      const mcpDir = join(tmpHome, '.junecoder', 'mcp');
      mkdirSync(mcpDir, { recursive: true });
      writeFileSync(join(mcpDir, 'testproj.json'), JSON.stringify({
        description: 'Test project description',
        mcpServers: { srv1: {}, srv2: {} },
      }));

      const projects = mod.loadMcpProjects('/nonexistent/cwd');
      assert.strictEqual(projects.length, 1);
      assert.strictEqual(projects[0].name, 'testproj');
      assert.strictEqual(projects[0].description, 'Test project description');
    });

    it('generates description from server count when not provided', () => {
      const mcpDir = join(tmpHome, '.junecoder', 'mcp');
      rmSync(mcpDir, { recursive: true, force: true });
      mkdirSync(mcpDir, { recursive: true });
      writeFileSync(join(mcpDir, 'noproj.json'), JSON.stringify({
        mcpServers: { srv1: {}, srv2: {}, srv3: {} },
      }));

      const projects = mod.loadMcpProjects('/nonexistent/cwd');
      assert.strictEqual(projects.length, 1);
      assert.strictEqual(projects[0].name, 'noproj');
      assert.strictEqual(projects[0].description, '3 MCP servers');
    });

    it('uses singular for one server', () => {
      const mcpDir = join(tmpHome, '.junecoder', 'mcp');
      rmSync(mcpDir, { recursive: true, force: true });
      mkdirSync(mcpDir, { recursive: true });
      writeFileSync(join(mcpDir, 'single.json'), JSON.stringify({
        mcpServers: { only: {} },
      }));

      const projects = mod.loadMcpProjects('/nonexistent/cwd');
      assert.strictEqual(projects[0].description, '1 MCP server');
    });

    it('global mcp wins for same-named projects (processed first)', () => {
      const globalMcpDir = join(tmpHome, '.junecoder', 'mcp');
      mkdirSync(globalMcpDir, { recursive: true });
      writeFileSync(join(globalMcpDir, 'shared.json'), JSON.stringify({
        description: 'global version',
        mcpServers: { g: {} },
      }));

      // Create cwd with project-level mcp
      const cwdDir = mkdtempSync(join(tmpdir(), 'junecoder-cwd-'));
      const projMcpDir = join(cwdDir, '.junecoder', 'mcp');
      mkdirSync(projMcpDir, { recursive: true });
      writeFileSync(join(projMcpDir, 'shared.json'), JSON.stringify({
        description: 'project version',
        mcpServers: { p: {} },
      }));

      try {
        const projects = mod.loadMcpProjects(cwdDir);
        const p = projects.find(p => p.name === 'shared');
        assert.ok(p);
        assert.strictEqual(p.description, 'global version');
      } finally {
        rmSync(cwdDir, { recursive: true, force: true });
      }
    });

    it('skips corrupt JSON files', () => {
      const mcpDir = join(tmpHome, '.junecoder', 'mcp');
      rmSync(mcpDir, { recursive: true, force: true });
      mkdirSync(mcpDir, { recursive: true });
      writeFileSync(join(mcpDir, 'bad.json'), 'not json {{{');
      writeFileSync(join(mcpDir, 'good.json'), JSON.stringify({
        description: 'valid',
        mcpServers: { s: {} },
      }));

      const projects = mod.loadMcpProjects('/nonexistent/cwd');
      assert.strictEqual(projects.length, 1);
      assert.strictEqual(projects[0].name, 'good');
    });
  });

  describe('formatMcpListing', () => {
    it('returns placeholder when empty', () => {
      assert.strictEqual(mod.formatMcpListing([]), 'No MCP projects available.');
      assert.strictEqual(mod.formatMcpListing(null), 'No MCP projects available.');
    });

    it('formats project listing', () => {
      const projects = [
        { name: 'p1', description: 'first project' },
        { name: 'p2', description: 'second project' },
      ];
      const out = mod.formatMcpListing(projects);
      assert.ok(out.includes('p1: first project'));
      assert.ok(out.includes('p2: second project'));
    });
  });

  describe('readMcpProject', () => {
    it('returns null when project not found', () => {
      const result = mod.readMcpProject('nonexistent', '/tmp');
      assert.strictEqual(result, null);
    });

    it('reads project from global mcp dir', () => {
      const mcpDir = join(tmpHome, '.junecoder', 'mcp');
      mkdirSync(mcpDir, { recursive: true });
      writeFileSync(join(mcpDir, 'myproj.json'), JSON.stringify({
        description: 'my test project',
        mcpServers: { srv: { command: 'node', args: ['-e', '1'] } },
      }));

      const cfg = mod.readMcpProject('myproj', '/nonexistent/cwd');
      assert.ok(cfg);
      assert.strictEqual(cfg.description, 'my test project');
      assert.ok(cfg.mcpServers.srv);
    });

    it('project dir takes priority over global', () => {
      const globalMcpDir = join(tmpHome, '.junecoder', 'mcp');
      mkdirSync(globalMcpDir, { recursive: true });
      writeFileSync(join(globalMcpDir, 'priority.json'), JSON.stringify({
        description: 'global',
        mcpServers: {},
      }));

      const cwdDir = mkdtempSync(join(tmpdir(), 'junecoder-mcp-prio-'));
      const projMcpDir = join(cwdDir, '.junecoder', 'mcp');
      mkdirSync(projMcpDir, { recursive: true });
      writeFileSync(join(projMcpDir, 'priority.json'), JSON.stringify({
        description: 'project',
        mcpServers: { s: {} },
      }));

      try {
        const cfg = mod.readMcpProject('priority', cwdDir);
        assert.strictEqual(cfg.description, 'project');
      } finally {
        rmSync(cwdDir, { recursive: true, force: true });
      }
    });

    it('returns null for corrupt JSON', () => {
      const mcpDir = join(tmpHome, '.junecoder', 'mcp');
      mkdirSync(mcpDir, { recursive: true });
      writeFileSync(join(mcpDir, 'corrupt.json'), 'not json {{{');

      const result = mod.readMcpProject('corrupt', '/tmp');
      assert.strictEqual(result, null);
    });
  });

  describe('removeMcpTools', () => {
    it('removes tools with matching mcp_ prefix', () => {
      const agent = {
        tools: [
          { name: 'mcp_myproj_list', execute() {} },
          { name: 'mcp_myproj_search', execute() {} },
          { name: 'read', execute() {} },
          { name: 'write', execute() {} },
        ],
        _mcpProcesses: [],
        _mcpProjectNames: ['myproj'],
      };

      mod.removeMcpTools(agent, 'myproj');

      assert.strictEqual(agent.tools.length, 2);
      assert.strictEqual(agent.tools[0].name, 'read');
      assert.strictEqual(agent.tools[1].name, 'write');
      assert.strictEqual(agent._mcpProjectNames.length, 0);
    });

    it('kills associated child processes', () => {
      let killed = false;
      const agent = {
        tools: [{ name: 'mcp_test_tool', execute() {} }],
        _mcpProcesses: [
          { _mcpName: 'other' },
          { _mcpName: 'test', kill: () => { killed = true; } },
        ],
        _mcpProjectNames: ['test'],
      };

      mod.removeMcpTools(agent, 'test');

      assert.strictEqual(killed, true);
      assert.strictEqual(agent._mcpProcesses.length, 1);
      assert.strictEqual(agent._mcpProcesses[0]._mcpName, 'other');
    });

    it('no-ops when agent has no tools', () => {
      mod.removeMcpTools(null, 'test');
      mod.removeMcpTools({}, 'test');
      // Should not throw
    });

    it('no-ops when agent.tools is null', () => {
      const agent = { tools: null };
      mod.removeMcpTools(agent, 'test');
      // Should not throw
    });
  });

  describe('closeAllMcp', () => {
    it('kills all child processes', async () => {
      const killed = [];
      const agent = {
        _mcpProcesses: [
          { kill: () => killed.push('a') },
          { kill: () => killed.push('b') },
        ],
        _mcpProjectNames: ['x', 'y'],
      };

      await mod.closeAllMcp(agent);

      assert.deepStrictEqual(killed, ['a', 'b']);
      assert.deepStrictEqual(agent._mcpProcesses, []);
      assert.deepStrictEqual(agent._mcpProjectNames, []);
    });

    it('handles kill throwing gracefully', async () => {
      const agent = {
        _mcpProcesses: [
          { kill: () => { throw new Error('already dead'); } },
        ],
        _mcpProjectNames: ['z'],
      };

      await mod.closeAllMcp(agent);
      // Should not throw
      assert.deepStrictEqual(agent._mcpProcesses, []);
    });

    it('no-ops when agent is null', async () => {
      await mod.closeAllMcp(null);
      // Should not throw
    });

    it('no-ops when no _mcpProcesses', async () => {
      await mod.closeAllMcp({});
      // Should not throw
    });
  });
});
