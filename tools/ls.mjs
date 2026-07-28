/**
 * ls tool — list directory contents with type, size, and modification time.
 */
import { readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';

export const lsTool = {
  name: 'ls',
  description:
    'List directory contents with type, size, and modification time. Directories listed first.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path (default cwd)' },
    },
    required: [],
  },
  readonly: true,
  parallel: true,

  async execute(args, agent) {
    const cwd = agent?.cwd || process.cwd();
    const dir = args.path ? resolve(cwd, args.path) : cwd;

    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      const results = [];

      for (const entry of entries) {
        const fullPath = resolve(dir, entry.name);
        let info;
        try {
          const st = statSync(fullPath);
          info = {
            name: entry.name + (entry.isDirectory() ? '/' : ''),
            size: st.size,
            mtime: st.mtime.toISOString().slice(0, 19),
          };
        } catch {
          info = { name: entry.name, size: 0, mtime: '???' };
        }
        info.isDir = entry.isDirectory();
        results.push(info);
      }

      // Sort: directories first, then alphabetically
      results.sort((a, b) => {
        if (a.isDir && !b.isDir) return -1;
        if (!a.isDir && b.isDir) return 1;
        return a.name.localeCompare(b.name);
      });

      const lines = results.map(
        (r) => `${r.isDir ? 'd' : '-'} ${String(r.size).padStart(8)} ${r.mtime} ${r.name}`,
      );

      return `Directory: ${dir}\n${lines.join('\n') || '(empty)'}`;
    } catch (err) {
      return `Error listing directory: ${err.message}`;
    }
  },
};
