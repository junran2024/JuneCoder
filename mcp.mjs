/**
 * MCP (Model Context Protocol) management.
 *
 * Supports two transports:
 *   stdio  — JSON-RPC over child process stdin/stdout (spawn)
 *   http   — JSON-RPC over HTTP POST (fetch, Streamable HTTP transport)
 *
 * Also supports "project" loading: scan ~/.junecoder/mcp/*.json for
 * pre-configured server groups, list them in the system prompt (name+desc only,
 * no auth), and connect on demand via mcp_connect(project="...").
 */

import { spawn } from 'node:child_process';
import { join, basename } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';

// ─── JSON-RPC helpers (stdio) ───────────────────────────────────────────────────

let _nextId = 1;

/** Send a JSON-RPC request over stdio and wait for the response. */
function jsonRpc(proc, method, params = null) {
  return new Promise((resolve, reject) => {
    const id = _nextId++;
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

    const onData = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            proc.stdout.removeListener('data', onData);
            clearTimeout(timer);
            if (msg.error) reject(new Error(`MCP error: ${msg.error.message || JSON.stringify(msg.error)}`));
            else resolve(msg.result);
          }
        } catch { /* skip parse errors */ }
      }
    };

    let buffer = '';
    proc.stdout.on('data', onData);

    const timer = setTimeout(() => {
      proc.stdout.removeListener('data', onData);
      reject(new Error(`MCP request timed out (method: ${method})`));
    }, 15000);

    proc.stdin.write(request);
  });
}

/** Send a JSON-RPC notification over stdio (no response expected). */
function jsonRpcNotify(proc, method, params = null) {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
  proc.stdin.write(msg);
}

// ─── JSON-RPC helpers (HTTP) ────────────────────────────────────────────────────

/**
 * Send a JSON-RPC request over HTTP POST. Returns parsed result.
 * Throws on HTTP error or JSON-RPC error.
 */
async function httpJsonRpc(url, method, params = null, headers = {}) {
  const hdrs = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...headers,
  };
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params,
  });

  const res = await fetch(url, { method: 'POST', headers: hdrs, body });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.result;
}

/** Send a JSON-RPC notification over HTTP (fire-and-forget). */
async function httpJsonRpcNotify(url, method, params = null, headers = {}) {
  const hdrs = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    ...headers,
  };
  const body = JSON.stringify({ jsonrpc: '2.0', method, params });
  // Don't await — fire and forget
  fetch(url, { method: 'POST', headers: hdrs, body }).catch(() => {});
}

// ─── Tool conversion ───────────────────────────────────────────────────────────

/**
 * Convert an MCP tool definition to an internal tool (stdio transport).
 * Calls route through the child process.
 */
function mcpToolToInternalStdio(mcpTool, proc, serverName) {
  const name = `mcp_${serverName}_${mcpTool.name}`;
  const parameters = mcpTool.inputSchema || { type: 'object', properties: {} };

  return {
    name,
    description: mcpTool.description || `MCP tool: ${mcpTool.name}`,
    parameters,
    readonly: false,
    parallel: true,

    async execute(args, _agent) {
      try {
        const result = await jsonRpc(proc, 'tools/call', {
          name: mcpTool.name,
          arguments: args,
        });
        return formatToolResult(result);
      } catch (err) {
        return `MCP tool "${mcpTool.name}" failed: ${err.message}`;
      }
    },
  };
}

/**
 * Convert an MCP tool definition to an internal tool (HTTP transport).
 * Each call is a separate HTTP POST.
 */
function mcpToolToInternalHttp(mcpTool, serverUrl, serverHeaders, serverName) {
  const name = `mcp_${serverName}_${mcpTool.name}`;
  const parameters = mcpTool.inputSchema || { type: 'object', properties: {} };

  return {
    name,
    description: mcpTool.description || `MCP tool: ${mcpTool.name}`,
    parameters,
    readonly: false,
    parallel: true,

    async execute(args, _agent) {
      try {
        const result = await httpJsonRpc(serverUrl, 'tools/call', {
          name: mcpTool.name,
          arguments: args,
        }, serverHeaders);
        return formatToolResult(result);
      } catch (err) {
        return `MCP tool "${mcpTool.name}" failed: ${err.message}`;
      }
    },
  };
}

/** MCP tool result → string for the LLM. */
function formatToolResult(result) {
  if (result.content && Array.isArray(result.content)) {
    return result.content
      .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
      .join('\n');
  }
  if (result.isError) {
    return `MCP tool error: ${JSON.stringify(result)}`;
  }
  return JSON.stringify(result);
}

// ─── Server connection ─────────────────────────────────────────────────────────

/**
 * Connect to an MCP server over HTTP.
 * @param {object} srv — { url, headers?, name }
 * @returns {Promise<object[]>} array of tool definitions
 */
export async function connectMcpServerHttp(srv) {
  if (!srv || !srv.url) return [];

  const name = srv.name || 'mcp';
  const url = srv.url;
  const headers = { ...(srv.headers || {}) };

  try {
    // Step 1: Initialize
    await httpJsonRpc(url, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'junecoder', version: '1.0.0' },
    }, headers);

    // Step 2: Send initialized notification
    await httpJsonRpcNotify(url, 'notifications/initialized', null, headers);

    // Step 3: List tools
    const listResult = await httpJsonRpc(url, 'tools/list', null, headers);
    const mcpTools = listResult.tools || [];

    // Convert to internal tools
    const tools = mcpTools.map((t) => mcpToolToInternalHttp(t, url, headers, name));

    // Mark for tracking (no process, but we track the name)
    tools._mcpName = name;
    tools._mcpHttp = true;

    return tools;
  } catch (err) {
    throw new Error(`MCP HTTP server "${name}" connection failed: ${err.message}`);
  }
}

/**
 * Connect to an MCP server over stdio.
 * Auto-detects: if srv.url is set, delegates to connectMcpServerHttp.
 * @param {object} srv — { name, command, args?: string[], env?: object, url?, headers? }
 * @returns {Promise<object[]>} array of tool definitions
 */
export async function connectMcpServer(srv) {
  if (!srv) return [];

  // Auto-detect HTTP transport
  if (srv.url) return connectMcpServerHttp(srv);

  if (!srv.command) return [];

  const name = srv.name || 'mcp';
  const command = srv.command;
  const args = srv.args || [];
  const env = { ...process.env, ...(srv.env || {}) };

  let proc;
  try {
    proc = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      shell: false,
    });
  } catch (err) {
    throw new Error(`Failed to spawn MCP server "${name}": ${err.message}`);
  }

  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  proc.on('error', () => { /* handled via exit */ });

  try {
    // Step 1: Initialize
    await jsonRpc(proc, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      clientInfo: { name: 'junecoder', version: '1.0.0' },
    });

    // Step 2: Send initialized notification
    jsonRpcNotify(proc, 'notifications/initialized');

    // Step 3: List tools
    const listResult = await jsonRpc(proc, 'tools/list');
    const mcpTools = listResult.tools || [];

    // Convert to internal tools
    const tools = mcpTools.map((t) => mcpToolToInternalStdio(t, proc, name));

    // Attach process reference
    tools._mcpProc = proc;
    tools._mcpName = name;

    return tools;
  } catch (err) {
    try { proc.kill(); } catch { /* ignore */ }
    throw new Error(`MCP server "${name}" connection failed: ${err.message}${stderr ? '\nStderr: ' + stderr.slice(-500) : ''}`);
  }
}

// ─── MCP Project loading ───────────────────────────────────────────────────────

/**
 * Load MCP project listings from ~/.junecoder/mcp/ and cwd/.junecoder/mcp/.
 * Only scans .json files, reads name + description — no auth/urls exposed.
 * Project-level overrides global when names collide.
 *
 * @param {string} cwd
 * @returns {{ name: string, description: string }[]}
 */
export function loadMcpProjects(cwd) {
  const dirs = [
    join(homedir(), '.junecoder', 'mcp'),
    join(cwd, '.junecoder', 'mcp'),
  ];

  const seen = new Set();
  const projects = [];

  for (const mcpDir of dirs) {
    if (!existsSync(mcpDir)) continue;
    let entries;
    try { entries = readdirSync(mcpDir, { withFileTypes: true }); } catch { continue; }

    for (const ent of entries) {
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith('.json')) continue;

      const name = basename(ent.name, '.json');
      if (seen.has(name)) continue; // project overrides global
      seen.add(name);

      const filePath = join(mcpDir, ent.name);
      let description = '';
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const cfg = JSON.parse(raw);
        description = cfg.description || '';
        const count = Object.keys(cfg.mcpServers || {}).length;
        if (!description) {
          description = `${count} MCP server${count !== 1 ? 's' : ''}`;
        }
      } catch { continue; }

      projects.push({ name, description });
    }
  }

  return projects;
}

/**
 * Format MCP project listing for system prompt injection.
 * @param {{ name: string, description: string }[]} projects
 * @returns {string}
 */
export function formatMcpListing(projects) {
  if (!projects || projects.length === 0) return 'No MCP projects available.';
  return projects.map((p) => `- ${p.name}: ${p.description}`).join('\n');
}

/**
 * Read a full MCP project config from file.
 * Searches project dir first, then global.
 *
 * @param {string} name — project name (without .json)
 * @param {string} cwd
 * @returns {object|null} parsed JSON or null
 */
export function readMcpProject(name, cwd) {
  const dirs = [
    join(cwd, '.junecoder', 'mcp'),
    join(homedir(), '.junecoder', 'mcp'),
  ];

  for (const mcpDir of dirs) {
    const filePath = join(mcpDir, `${name}.json`);
    if (!existsSync(filePath)) continue;
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch { continue; }
  }

  return null;
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Close all active MCP connections for an agent.
 * Kills all tracked child processes; HTTP servers need no cleanup.
 * @param {object} agent
 */
export async function closeAllMcp(agent) {
  if (!agent || !agent._mcpProcesses) return;

  for (const proc of agent._mcpProcesses) {
    try { proc.kill('SIGTERM'); } catch { /* already dead */ }
  }
  agent._mcpProcesses = [];
  if (agent._mcpProjectNames) agent._mcpProjectNames = [];
}

/**
 * Remove MCP tools for a named server or project from the agent.
 * Kills child processes if any; HTTP servers need no cleanup.
 * @param {object} agent
 * @param {string} name — server name or project name
 */
export function removeMcpTools(agent, name) {
  if (!agent || !agent.tools) return;

  const prefix = `mcp_${name}_`;

  agent.tools = agent.tools.filter((t) => {
    if (t.name?.startsWith(prefix)) {
      if (agent._toolByName) agent._toolByName.delete(t.name);
      return false;
    }
    return true;
  });

  // Kill stdio processes
  if (agent._mcpProcesses) {
    agent._mcpProcesses = agent._mcpProcesses.filter((p) => {
      if (p._mcpName === name) {
        try { p.kill('SIGTERM'); } catch { /* ignore */ }
        return false;
      }
      return true;
    });
  }

  // Remove from project tracking
  if (agent._mcpProjectNames) {
    agent._mcpProjectNames = agent._mcpProjectNames.filter((n) => n !== name);
  }
}
