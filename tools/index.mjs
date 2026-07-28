/**
 * Tools index — toOpenAISchema converter and baseTools array.
 */
import { readTool } from './read.mjs';
import { writeTool } from './write.mjs';
import { editTool } from './edit.mjs';
import { bashTool } from './bash.mjs';
import { globTool } from './glob.mjs';
import { grepTool } from './grep.mjs';
import { lsTool } from './ls.mjs';
import { fetchTool } from './fetch.mjs';
import { websearchTool } from './websearch.mjs';
import { deleteTool } from './delete.mjs';

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
