/**
 * delete tool — delete a file.
 */
import { unlinkSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export const deleteTool = {
  name: 'delete',
  description:
    'Delete a file. Refuses to delete git-tracked files as a safety measure.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to cwd or absolute' },
      force: { type: 'boolean', description: 'Allow deleting git-tracked files (default false)' },
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
      // Check if git-tracked
      if (!args.force) {
        const { execSync } = await import('node:child_process');
        try {
          execSync(`git ls-files --error-unmatch "${abs}"`, {
            cwd,
            stdio: 'ignore',
            timeout: 3000,
          });
          return `Error: "${args.path}" is tracked by git. Use force=true to delete, or remove via bash with explicit user confirmation.`;
        } catch {
          // Not git-tracked — OK to delete
        }
      }

      unlinkSync(abs);
      return `Deleted: ${args.path}`;
    } catch (err) {
      return `Error deleting file: ${err.message}`;
    }
  },
};
