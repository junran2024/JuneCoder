/**
 * delete tool — delete a file.
 */
import { unlinkSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const deleteTool = {
  name: 'delete',
  description:
    'Delete a file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to cwd or absolute' },
    },
    required: ['path'],
  },
  readonly: false,
  parallel: false,

  async execute(args, agent) {
    const cwd = agent?.cwd || process.cwd();
    const abs = resolve(cwd, args.path);

    if (!existsSync(abs)) {
      return `Error: file not found: ${args.path}`;
    }

    const st = statSync(abs);
    if (st.isDirectory()) {
      return `Error: "${args.path}" is a directory. Use bash to remove directories.`;
    }

    try {
      unlinkSync(abs);
      return `Deleted: ${args.path}`;
    } catch (err) {
      return `Error deleting file: ${err.message}`;
    }
  },
};
