/**
 * Tools index — schema conversion + base tool collection.
 * Each tool lives in tools/*.mjs with its real implementation.
 */
import { readTool } from './tools/read.mjs';
import { writeTool } from './tools/write.mjs';
import { editTool } from './tools/edit.mjs';
import { bashTool } from './tools/bash.mjs';
import { globTool } from './tools/glob.mjs';
import { grepTool } from './tools/grep.mjs';
import { lsTool } from './tools/ls.mjs';
import { fetchTool } from './tools/fetch.mjs';
import { websearchTool } from './tools/websearch.mjs';
import { deleteTool } from './tools/delete.mjs';

export { readTool, writeTool, editTool, bashTool, globTool, grepTool, lsTool, fetchTool, websearchTool, deleteTool };

/**
 * Convert an internal tool definition to OpenAI function-calling schema.
 */
export function toOpenAISchema(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/** All base external tools as an array. */
export const baseTools = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
  lsTool,
  fetchTool,
  websearchTool,
  deleteTool,
];
