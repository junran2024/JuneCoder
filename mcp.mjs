/**
 * MCP (Model Context Protocol) management.
 *
 * Communicates with MCP servers via JSON-RPC over stdio.
 * Each connected server's tools are added to the agent with an mcp_ prefix.
 * Child processes are tracked on agent._mcpProcesses for cleanup.
 */

import { spawn } from 'node:child_process';

// ─── JSON-RPC helpers ──────────────────────────────────────────────────────────

let _nextId = 1;

/** Send a JSON-RPC request and wait for the response. */
function jsonRpc(proc, method, params = null) {
  return new Promise((resolve, reject) => {
    const id = _nextId++;
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

    const onData = (chunk) => {
      buffer += chunk.toString();
      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line in buffer
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

/** Send a JSON-RPC notification (no response expected). */
function jsonRpcNotify(proc, method, params = null) {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
  proc.stdin.write(msg);
}

// ─── Tool conversion ───────────────────────────────────────────────────────────

/**
 * Convert an MCP tool definition to an internal tool with an execute wrapper.
 * MCP tools send tools/call requests to the child process.
 */
function mcpToolToInternal(mcpTool, proc, serverName) {
  const name = `mcp_${serverName}_${mcpTool.name}`;

  // MCP tool inputSchema → OpenAI parameters
  const parameters = mcpTool.inputSchema || { type: 'object', properties: {} };

  return {
    name,
    description: mcpTool.description || `MCP tool: ${mcpTool.name}`,
    parameters,
    readonly: false,
    parallel: true,

    async execute(args, agent) {
      try {
        const result = await jsonRpc(proc, 'tools/call', {
          name: mcpTool.name,
          arguments: args,
        });

        // MCP result is an array of content items
        if (result.content && Array.isArray(result.content)) {
          return result.content
            .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
            .join('\n');
        }
        if (result.isError) {
          return `MCP tool error: ${JSON.stringify(result)}`;
        }
        return JSON.stringify(result);
      } catch (err) {
        return `MCP tool "${mcpTool.name}" failed: ${err.message}`;
      }
    },
  };
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Connect to an MCP server. Returns list of internal tool definitions.
 *
 * @param {object} srv - Server config: { name, command, args?: string[], env?: object }
 * @returns {Promise<object[]>} array of tool definitions
 */
export async function connectMcpServer(srv) {
  if (!srv || !srv.command) return [];

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

  // Collect stderr for debugging
  let stderr = '';
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  proc.on('error', () => { /* handled via exit */ });

  try {
    // Step 1: Initialize
    const initResult = await jsonRpc(proc, 'initialize', {
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
    const tools = mcpTools.map((t) => mcpToolToInternal(t, proc, name));

    // Attach process reference so we can close it later
    tools._mcpProc = proc;
    tools._mcpName = name;

    return tools;
  } catch (err) {
    // Clean up on failure
    try { proc.kill(); } catch { /* ignore */ }
    throw new Error(`MCP server "${name}" connection failed: ${err.message}${stderr ? '\nStderr: ' + stderr.slice(-500) : ''}`);
  }
}

/**
 * Close all active MCP connections for an agent.
 * Kills all tracked child processes.
 * @param {object} agent
 */
export async function closeAllMcp(agent) {
  if (!agent || !agent._mcpProcesses) return;

  for (const proc of agent._mcpProcesses) {
    try { proc.kill('SIGTERM'); } catch { /* already dead */ }
  }
  agent._mcpProcesses = [];
}

/**
 * Remove MCP tools associated with a named server from an agent's tool set.
 * @param {object} agent
 * @param {string} name - server name
 */
export function removeMcpTools(agent, name) {
  if (!agent || !agent.tools) return;

  const prefix = `mcp_${name}_`;

  // Filter out tools with matching prefix
  agent.tools = agent.tools.filter((t) => {
    if (t.name?.startsWith(prefix)) {
      // Also remove from toolByName map if it exists
      if (agent._toolByName) agent._toolByName.delete(t.name);
      return false;
    }
    return true;
  });

  // Kill the process if tracked
  if (agent._mcpProcesses) {
    agent._mcpProcesses = agent._mcpProcesses.filter((p) => {
      if (p._mcpName === name) {
        try { p.kill('SIGTERM'); } catch { /* ignore */ }
        return false;
      }
      return true;
    });
  }
}
