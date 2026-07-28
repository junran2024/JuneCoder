/**
 * write tool — write content to a file, creating parent directories as needed.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export const writeTool = {
  name: 'write',
  description:
    'Write content to a file. Creates parent directories; overwrites existing file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to cwd or absolute' },
      content: { type: 'string', description: 'Full content to write' },
    },
    required: ['path', 'content'],
  },
  readonly: false,
  parallel: false,

  async execute(args, agent) {
    const cwd = agent?.cwd || process.cwd();
    const abs = resolve(cwd, args.path);

    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, args.content, 'utf-8');
      // Verify the write actually landed
      if (existsSync(abs)) {
        return `Wrote ${args.content.length} chars to ${args.path}`;
      }
      return `Error writing file: write completed but file not found at ${args.path}`;
    } catch (err) {
      return `Error writing file: ${err.message}`;
    }
  },
};
