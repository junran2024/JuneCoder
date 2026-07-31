/**
 * Meta tools — built-in agent tools for task management, planning, skills,
 * goal tracking, verification, and sub-agent spawning.
 *
 * Each tool exports: { name, description, parameters, readonly, parallel, execute }
 *
 * subagentTool uses dynamic import('./agent.mjs') to break circular dependency.
 */

import { MIN_REPORT_CHARS } from './agent.mjs';
import { loadSkills, formatSkillListing, readSkill } from './skills.mjs';
import { execSync } from 'node:child_process';

// ─── Overlays (system prompt additions for sub-agent roles) ───────────────────

/** Overlay for 'explore' role: read-only research sub-agent. */
export const EXPLORE_OVERLAY = [
  'You are an explore sub-agent. You perform read-only research and analysis.',
  'You CANNOT write files, run commands, or modify anything.',
  'Report your findings concisely. Do not ask for clarification — infer and proceed.',
];

/** Overlay for 'plan' role: read-only design/planning sub-agent. */
export const PLAN_OVERLAY = [
  'You are a planning sub-agent. Design solutions and write step-by-step plans.',
  'You CANNOT write files, run commands, or modify anything.',
  'Output a clear, actionable plan. Use task list format when appropriate.',
];

/** Overlay for 'coder' role: full implementation sub-agent (write-capable). */
export const CODER_OVERLAY = [
  'You are a coder sub-agent. Implement self-contained tasks in isolated context.',
  'You have full tool access within your scope. Return only your final report.',
  'Be thorough — verify your work before reporting.',
];

// ─── taskTool ─────────────────────────────────────────────────────────────────

export const taskTool = {
  name: 'task',
  description:
    'Plan and track a task list for complex multi-step work. ' +
    'Replaces the entire list on each call. ' +
    'Each item: { title, status } where status is pending|in_progress|done. ' +
    'Keep exactly ONE item in_progress.',
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Full task list with status',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
          },
          required: ['title', 'status'],
        },
      },
    },
    required: ['items'],
  },
  readonly: true,
  parallel: false,

  async execute(args, agent) {
    const items = args.items || [];
    agent.tasks = items;

    const counts = { pending: 0, in_progress: 0, done: 0 };
    for (const item of items) {
      if (counts[item.status] !== undefined) counts[item.status]++;
    }

    const lines = [`Task list updated: ${counts.done}/${items.length} done.`];
    for (const item of items) {
      const icon = item.status === 'done' ? '✓' : item.status === 'in_progress' ? '▶' : '○';
      lines.push(`  ${icon} [${item.status}] ${item.title}`);
    }

    // Reset turn counter
    agent._turnsSinceTaskUpdate = 0;

    return lines.join('\n');
  },
};

// ─── planTool ─────────────────────────────────────────────────────────────────

export const planTool = {
  name: 'plan',
  description:
    'Enter or exit plan mode. In plan mode, only read-only tools are allowed. ' +
    'Use for exploring the codebase and designing solutions before implementing.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['enter', 'exit'], description: 'Enter or exit plan mode' },
    },
    required: ['action'],
  },
  readonly: true,
  parallel: false,

  async execute(args, agent) {
    if (args.action === 'enter') {
      if (agent.planMode) return 'Already in plan mode.';
      agent.planMode = true;
      agent._turnsInPlanMode = 0;
      return 'Entered plan mode. Only read-only tools are available. ' +
        'Explore the codebase, design your approach, then exit plan mode to implement.';
    } else {
      if (!agent.planMode) return 'Not in plan mode.';
      agent.planMode = false;
      return `Exited plan mode after ${agent._turnsInPlanMode || 0} turns. Full tool access restored.`;
    }
  },
};

// ─── skillTool ────────────────────────────────────────────────────────────────

export const skillTool = {
  name: 'skill',
  description:
    'Manage project skills. Skills are reusable workflows stored in ~/.junecoder/skills/. ' +
    'Use skill=list to see available skills, skill=load to activate one.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'load'], description: "'list' to see available skills, 'load' to activate one" },
      name: { type: 'string', description: 'Skill name (required for load action)' },
    },
    required: ['action'],
  },
  readonly: true,
  parallel: false,

  async execute(args, agent) {
    const cwd = agent.cwd || process.cwd();

    if (args.action === 'list') {
      const skills = loadSkills(cwd);
      return 'Available skills:\n' + formatSkillListing(skills);
    }

    if (args.action === 'load') {
      if (!args.name) return 'Error: skill name is required for load action.';
      const content = readSkill(cwd, args.name);
      if (!content) return `Skill "${args.name}" not found.`;
      return `Loaded skill "${args.name}":\n\n${content}`;
    }

    return `Unknown action: ${args.action}`;
  },
};

// ─── goalTool ─────────────────────────────────────────────────────────────────

export const goalTool = {
  name: 'goal',
  description:
    'Manage a long-running autonomous goal. ' +
    'Set a goal with verifiable criteria; mark complete when criteria are met; ' +
    'mark blocked when stuck (only after 3 genuine attempts). ' +
    'Actions: set | complete | blocked | cancel.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['set', 'complete', 'blocked', 'cancel'] },
      objective: { type: 'string', description: 'What to accomplish (for set)' },
      criteria: { type: 'string', description: 'How completion is PROVEN (required for set)' },
      reason: { type: 'string', description: 'Blocking condition (required for blocked)' },
    },
    required: ['action'],
  },
  readonly: true,
  parallel: false,

  async execute(args, agent) {
    switch (args.action) {
      case 'set': {
        if (!args.objective) return 'Error: objective is required for set.';
        agent.goal = {
          objective: args.objective,
          criteria: args.criteria || '',
          startedAt: Date.now(),
          status: 'active',
          turnsUsed: 0,
          _blockTally: null, // { reason, count } — consecutive same-condition blocks
        };
        return `Goal set: "${agent.goal.objective}"\nDone when: ${agent.goal.criteria || '(no criteria)'}. Use task tool to break it down, then work autonomously.`;
      }

      case 'complete': {
        if (!agent.goal || agent.goal.status !== 'active') return `Error: no active goal (current: ${agent.goal?.status ?? 'none'}).`;
        if (agent._mutatedThisRun && !agent._verifiedThisRun) {
          return 'Error: files were modified but verify has not run. Run verify before marking goal complete.';
        }
        agent.goal.status = 'complete';
        return `Goal marked complete: ${agent.goal.objective}\nSummarize the evidence in your next message.`;
      }

      case 'blocked': {
        if (!agent.goal || agent.goal.status !== 'active') return `Error: no active goal (current: ${agent.goal?.status ?? 'none'}).`;
        if (!args.reason) return 'Error: reason is required for blocked action.';
        const tally = agent.goal._blockTally;
        const count = (tally?.reason === args.reason) ? tally.count + 1 : 1;
        agent.goal._blockTally = { reason: args.reason, count };
        if (count < 3) {
          return `Blocked not accepted yet (${count}/3 for this condition). Try a genuinely different approach — report blocked only when the same condition stops you ${3 - count} more time(s).`;
        }
        agent.goal.status = 'blocked';
        return `Goal blocked after 3 attempts: ${args.reason}\nExplain the blocker to the user — what you tried and what you need.`;
      }

      case 'cancel': {
        if (!agent.goal) return 'No active goal.';
        const obj = agent.goal.objective;
        agent.goal = null;
        return `Goal cancelled: "${obj}"`;
      }

      default:
        return `Unknown action: ${args.action}`;
    }
  },
};

// ─── verifyTool ───────────────────────────────────────────────────────────────

export const verifyTool = {
  name: 'verify',
  description:
    'Run a pre-completion self-check. Shows what files changed (git diff --stat), ' +
    'the current task list, and a verification checklist. ' +
    'Call BEFORE declaring any coding task complete.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  readonly: true,
  parallel: false,

  async execute(args, agent) {
    const cwd = agent.cwd || process.cwd();
    const lines = ['=== VERIFICATION REPORT ===', ''];

    // Git diff
    try {
      const diffStat = execSync('git diff --stat', { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      lines.push(`Changed files (git diff --stat):\n${diffStat || '(no changes)'}`);
    } catch {
      lines.push('Changed files: (not a git repo or git unavailable)');
    }
    lines.push('');

    // Task list
    if (agent.tasks.length > 0) {
      const done = agent.tasks.filter((t) => t.status === 'done').length;
      lines.push(`Task list: ${done}/${agent.tasks.length} done`);
      for (const item of agent.tasks) {
        const icon = item.status === 'done' ? '✓' : item.status === 'in_progress' ? '▶' : '○';
        lines.push(`  ${icon} [${item.status}] ${item.title}`);
      }
    } else {
      lines.push('No active tasks.');
    }
    lines.push('');

    // Checklist
    lines.push('Self-review checklist:');
    lines.push('- [ ] Did I run the project\'s tests and do they pass?');
    lines.push('- [ ] Did I read every file I changed to catch leftover debug code or stale comments?');
    lines.push('- [ ] Do comments and docstrings match what the code actually does?');
    lines.push('- [ ] Did I remove placeholder code, TODO stubs, or commented-out experiment blocks?');
    lines.push('- [ ] If I used a subagent, did I verify its report against the actual files it touched?');
    lines.push('- [ ] Are all task items genuinely done (not just marked done to finish early)?');

    agent._verifiedThisRun = true;
    return lines.join('\n');
  },
};

// ─── memorySearchTool ──────────────────────────────────────────────────────────

export const memorySearchTool = {
  name: 'memory_search',
  description:
    'Search long-term memory. Use to recall past debugging insights, ' +
    'project conventions, or architecture decisions. Returns top matches.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural language search query' },
      limit: { type: 'number', description: 'Max results (default 5)' },
    },
    required: ['query'],
  },
  readonly: true,
  parallel: true,

  async execute(args, agent) {
    const { search } = await import('./memory.mjs');
    const result = await search(agent.memory, args.query, { limit: args.limit || 5 });
    return result || 'No matches found.';
  },
};

// ─── memoryPutTool ─────────────────────────────────────────────────────────────

export const memoryPutTool = {
  name: 'memory_put',
  description:
    'Save knowledge to long-term memory. Only save information that is ' +
    'project-specific and non-obvious — a base model could not derive it from training data. ' +
    'Do NOT save common knowledge (e.g. "this project uses Node.js") or session-specific trivia. ' +
    'Types: rule (coding standards), knowledge (facts), decision (architecture decisions), ' +
    'pattern (debugging/workflows). Scopes: personal (default), project, team.',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['rule', 'knowledge', 'decision', 'pattern'] },
      title: { type: 'string', description: 'Short title' },
      content: { type: 'string', description: 'Full content to remember' },
      tags: { type: 'string', description: 'Space-separated tags' },
      scope: { type: 'string', enum: ['personal', 'project', 'team'], description: 'Storage scope (default personal)' },
    },
    required: ['type', 'title', 'content'],
  },
  readonly: false,
  parallel: true,

  async execute(args, agent) {
    const { put } = await import('./memory.mjs');
    const entry = {
      type: args.type || 'knowledge',
      title: args.title,
      content: args.content,
      tags: args.tags ? args.tags.split(/\s+/) : [],
      scope: args.scope || 'personal',
    };
    return await put(agent.memory, entry);
  },
};

// ─── mcpConnectTool ───────────────────────────────────────────────────────────

export const mcpConnectTool = {
  name: 'mcp_connect',
  description:
    'Connect to an MCP server. Returns its tools, registered with an mcp_<name>_ prefix. ' +
    'Tools become available immediately in subsequent turns.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Executable command to spawn the server' },
      args: { type: 'string', description: 'Command arguments (space-separated)' },
      name: { type: 'string', description: 'Server name for disambiguation' },
    },
    required: ['command'],
  },
  readonly: false,
  parallel: false,

  async execute(args, agent) {
    const { connectMcpServer } = await import('./mcp.mjs');
    const srv = {
      name: args.name || 'mcp',
      command: args.command,
      args: args.args ? args.args.split(/\s+/) : [],
    };
    try {
      const mcpTools = await connectMcpServer(srv);

      // Track the child process
      if (!agent._mcpProcesses) agent._mcpProcesses = [];
      if (mcpTools._mcpProc) {
        mcpTools._mcpProc._mcpName = srv.name;
        agent._mcpProcesses.push(mcpTools._mcpProc);

        // Register only the actual tool objects (strip meta properties)
        const cleanTools = mcpTools.filter(t => typeof t.execute === 'function');
        agent.tools.push(...cleanTools);
      }

      const toolNames = mcpTools
        .filter(t => t.name)
        .map(t => t.name)
        .join('\n  ');
      return `Connected to "${srv.name}". Tools available:\n  ${toolNames || '(none)'}`;
    } catch (err) {
      return `MCP connection failed: ${err.message}`;
    }
  },
};

// ─── mcpDisconnectTool ────────────────────────────────────────────────────────

export const mcpDisconnectTool = {
  name: 'mcp_disconnect',
  description:
    'Disconnect from an MCP server by name. Removes its tools and kills the process.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Server name to disconnect' },
    },
    required: ['name'],
  },
  readonly: false,
  parallel: false,

  async execute(args, agent) {
    const { removeMcpTools } = await import('./mcp.mjs');
    try {
      removeMcpTools(agent, args.name);
      return `Disconnected from "${args.name}".`;
    } catch (err) {
      return `Disconnect failed: ${err.message}`;
    }
  },
};

// ─── mcpListTool ──────────────────────────────────────────────────────────────

export const mcpListTool = {
  name: 'mcp_list',
  description: 'List currently connected MCP servers.',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  readonly: true,
  parallel: true,

  async execute(args, agent) {
    if (!agent._mcpProcesses || agent._mcpProcesses.length === 0) {
      return 'No MCP servers connected.';
    }
    const names = agent._mcpProcesses
      .map(p => `- ${p._mcpName || '(unnamed)'}`)
      .join('\n');
    return `Connected MCP servers:\n${names}`;
  },
};

// ─── subagentTool ─────────────────────────────────────────────────────────────

export const subagentTool = {
  name: 'subagent',
  description:
    'Spawn a sub-agent to handle an independent subtask in an isolated context. ' +
    'Use role=explore for read-only research, role=plan for design, role=coder for implementation. ' +
    'Spawn MULTIPLE sub-agents in parallel for concurrent work.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Self-contained task description for the sub-agent' },
      context: { type: 'string', description: 'Optional background the sub-agent needs' },
      role: {
        type: 'string',
        enum: ['explore', 'plan', 'coder'],
        description: "explore (read-only research), plan (read-only design), or coder (full implementation)",
      },
    },
    required: ['task'],
  },
  readonly: true,
  parallel: true,

  async execute(args, agent) {
    const role = args.role || 'coder';

    // Dynamic import to break circular dependency with agent.mjs
    const { createAgent } = await import('./agent.mjs');

    // Map role to overlay
    const overlays = {
      explore: EXPLORE_OVERLAY,
      plan: PLAN_OVERLAY,
      coder: CODER_OVERLAY,
    };

    const subAgent = createAgent({
      provider: agent.provider,
      tools: agent.tools,
      config: agent.config,
      cwd: agent.cwd,
      memory: agent.memory,
      overlay: overlays[role] || overlays.coder,
    });

    // Build input
    let input = args.task;
    if (args.context) {
      input = `Context: ${args.context}\n\nTask: ${args.task}`;
    }

    // We need runAgent from agent.mjs too
    const { runAgent } = await import('./agent.mjs');

    try {
      const report = await runAgent(subAgent, input, {}, { depth: (agent._depth || 0) + 1 });
      if (!report || (typeof report === 'string' && report.length < MIN_REPORT_CHARS)) {
        return `Sub-agent report too short (${report ? report.length : 0} chars). Full report:\n${report || '(empty)'}`;
      }
      return `Sub-agent report:\n\n${report}`;
    } catch (err) {
      return `Sub-agent error: ${err.message}`;
    }
  },
};

// ─── All meta tools ───────────────────────────────────────────────────────────

export const metaTools = [
  taskTool,
  planTool,
  skillTool,
  goalTool,
  verifyTool,
  memorySearchTool,
  memoryPutTool,
  mcpConnectTool,
  mcpDisconnectTool,
  mcpListTool,
  subagentTool,
];
