/**
 * read tool — read a text file with line-based or character-based paging.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const readTool = {
  name: 'read',
  description:
    'Read a text file. Returns numbered lines by default. Use chars for character-based slicing (useful for files with very long lines or no newlines).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to cwd or absolute' },
      offset: { type: 'number', description: '1-based line number to start from, or 0-based char offset when chars is set' },
      limit: { type: 'number', description: 'Max lines to return (default 2000, line mode only)' },
      chars: { type: 'number', description: 'Max characters to return. When set, offset becomes 0-based char index.' },
    },
    required: ['path'],
  },
  readonly: true,
  parallel: true,

  async execute(args, agent) {
    const cwd = agent?.cwd || process.cwd();
    const abs = resolve(cwd, args.path);

    if (!existsSync(abs)) {
      return `Error: file not found: ${args.path}`;
    }

    const st = statSync(abs);
    if (st.isDirectory()) {
      return `Error: "${args.path}" is a directory, not a file.`;
    }

    try {
      const content = readFileSync(abs, 'utf-8');

      // Character-based mode
      if (args.chars != null) {
        const start = args.offset || 0;
        const end = start + args.chars;
        const slice = content.slice(start, end);
        return `[Chars ${start}-${Math.min(end, content.length)} of ${content.length}]\n${slice}`;
      }

      // Line-based mode (default)
      const lines = content.split('\n');
      const start = (args.offset || 1) - 1;
      const end = args.limit ? start + args.limit : start + 2000;
      const slice = lines.slice(Math.max(0, start), end);

      return slice
        .map((line, i) => `${String(start + i + 1).padStart(4, ' ')}| ${line}`)
        .join('\n');
    } catch (err) {
      return `Error reading file: ${err.message}`;
    }
  },
};
