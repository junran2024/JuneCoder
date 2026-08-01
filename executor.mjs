/**
 * Tool execution engine — two-phase tool call processing.
 *
 * Phase 1: parse + validate + permission check (serial)
 * Phase 2: execute parallel-ready tools together, serial tools one-by-one
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  TOOL_RESULT_OFFLOAD_LIMIT,
  TOOL_RESULT_PREVIEW,
} from './agent.mjs';

// ─── executeToolCalls ─────────────────────────────────────────────────────────

/**
 * Execute a batch of tool calls from the LLM.
 *
 * @param {object} agent - agent instance
 * @param {Map<string, object>} toolByName - tool name → tool definition
 * @param {object[]} toolCalls - LLM tool_calls [{id, function:{name,arguments}}]
 * @param {object} callbacks - { onToolCall, onToolOutput, onPermissionRequest }
 * @param {number} depth - nesting depth (0 = top-level)
 * @param {AbortSignal} [signal]
 * @returns {Promise<object[]>} results in original toolCalls order [{id, name, output, error?}]
 */
export async function executeToolCalls(agent, toolByName, toolCalls, callbacks, depth, signal) {
  if (!toolCalls || toolCalls.length === 0) return [];

  const cb = callbacks || {};

  // ── Phase 1: Prepare (serial) ──────────────────────────────────────────
  const prepared = [];

  for (const tc of toolCalls) {
    const id = tc.id || `call_${prepared.length}`;
    const name = tc.function?.name || '';
    let args = {};

    // Parse arguments
    try {
      args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      prepared.push({ id, name, error: `Invalid JSON arguments: ${tc.function?.arguments?.slice(0, 100)}` });
      continue;
    }

    // Check tool exists
    const tool = toolByName.get(name);
    if (!tool) {
      prepared.push({ id, name, error: `Unknown tool: ${name}` });
      continue;
    }

    // Show tool call in TUI
    if (cb.onToolCall) {
      try { cb.onToolCall(name, args); } catch { /* ignore */ }
    }

    // Plan mode: reject non-readonly tools
    if (agent.planMode && !tool.readonly) {
      prepared.push({
        id,
        name,
        denied: true,
        output: `Tool "${name}" is not allowed in plan mode (read-only tools only). Exit plan mode first.`,
      });
      continue;
    }

    // Permission request for non-readonly tools
    let permissionDenied = false;
    let denyReason = '';
    if (!tool.readonly && cb.onPermissionRequest) {
      try {
        const result = await cb.onPermissionRequest(tool, args);
        if (typeof result === 'object' && result !== null) {
          if (!result.allowed) {
            permissionDenied = true;
            denyReason = result.reason || '';
          }
        } else if (!result) {
          permissionDenied = true;
        }
      } catch {
        permissionDenied = true;
      }
    }

    if (permissionDenied) {
      const reasonSuffix = denyReason ? ` Reason: ${denyReason}` : '';
      prepared.push({
        id,
        name,
        denied: true,
        output: `Permission denied for "${name}".${reasonSuffix}`,
      });
      continue;
    }

    prepared.push({ id, name, tool, args });
  }

  // ── Phase 2: Execute (parallel groups, then serial) ────────────────────

  const results = new Array(toolCalls.length).fill(null);

  // Assemble results by original index
  const preparedWithIndex = prepared.map((p, i) => ({ ...p, _idx: i }));

  // Group: parallel (readonly or explicit parallel) vs serial
  const parallelItems = [];
  const serialItems = [];

  for (const item of preparedWithIndex) {
    if (item.error || item.denied) {
      // Already resolved in phase 1
      results[item._idx] = {
        id: item.id,
        name: item.name,
        output: item.error ? null : item.output,
        error: item.error || null,
        denied: item.denied || false,
      };
    } else if (item.tool.parallel === true || item.tool.readonly) {
      parallelItems.push(item);
    } else {
      serialItems.push(item);
    }
  }

  // Execute parallel group
  if (parallelItems.length > 0) {
    const parallelResults = await Promise.all(
      parallelItems.map((item) => runOne(agent, item, cb, signal)),
    );
    for (let i = 0; i < parallelItems.length; i++) {
      results[parallelItems[i]._idx] = parallelResults[i];
    }
  }

  // Execute serial group one by one
  for (const item of serialItems) {
    try {
      const result = await runOne(agent, item, cb, signal);
      results[item._idx] = result;
    } catch {
      results[item._idx] = {
        id: item.id,
        name: item.name,
        output: null,
        error: 'Serial execution failed',
      };
    }
  }

  return results.filter(Boolean);
}

// ─── runOne ───────────────────────────────────────────────────────────────────

async function runOne(agent, item, callbacks, signal) {
  const { id, name, tool, args } = item;

  let output;
  let error = null;

  try {
    const raw = await tool.execute(args, agent, { signal });
    output = typeof raw === 'string' ? raw : JSON.stringify(raw);

    // Offload long results — except read, whose content is already on disk.
    // Offloading read creates a daisy chain of offloaded files the LLM can never reach.
    if (output.length > TOOL_RESULT_OFFLOAD_LIMIT) {
      if (name === 'read') {
        const preview = output.slice(0, TOOL_RESULT_PREVIEW);
        output = `${preview}\n\n[Read output truncated: ${output.length} chars. Use offset/limit to read the file in smaller chunks.]`;
      } else {
        output = offloadToolResult(name, output);
      }
    }
  } catch (err) {
    error = err.message || String(err);
    output = null;
  }

  if (callbacks.onToolOutput) {
    try {
      callbacks.onToolOutput(name, output, error);
    } catch { /* ignore callback errors */ }
  }

  return { id, name, output, error };
}

// ─── offloadToolResult ────────────────────────────────────────────────────────

/**
 * Write long tool results to disk, return a preview + file path.
 * Directory: ~/.junecoder/tool-results/
 */
function offloadToolResult(toolName, fullResult) {
  const dir = join(homedir(), '.junecoder', 'tool-results');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const filename = `${ts}-${rand}-${toolName}.txt`;
  const filepath = join(dir, filename);

  writeFileSync(filepath, fullResult, 'utf-8');

  const preview = fullResult.slice(0, TOOL_RESULT_PREVIEW);
  return `${preview}\n\n[Result offloaded: ${fullResult.length} chars. Full output at ${filepath}]`;
}
