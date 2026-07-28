/**
 * grep tool — search file contents with a regex.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';
import { execSync } from 'node:child_process';

const TEXT_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.json', '.md', '.txt', '.yml', '.yaml', '.toml',
  '.css', '.html', '.xml', '.svg', '.py', '.rb', '.go',
  '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.sh',
  '.mjs', '.env', '.gitignore', '.dockerignore',
]);

export const grepTool = {
  name: 'grep',
  description:
    'Search file contents with a regex. Returns matching lines as path:line: content.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression' },
      path: { type: 'string', description: 'Directory or file to search (default cwd)' },
      glob: { type: 'string', description: "Only search files matching this glob (e.g. '*.mjs')" },
    },
    required: ['pattern'],
  },
  readonly: true,
  parallel: true,

  async execute(args, agent) {
    const cwd = agent?.cwd || process.cwd();
    const base = args.path ? resolve(cwd, args.path) : cwd;

    try {
      const globPart = args.glob ? ` --include='*.${args.glob}'` : '';
      // Escape the pattern for shell
      const escaped = args.pattern.replace(/'/g, "'\\''");
      let cmd = `grep -rn${globPart} '${escaped}' "${base}" 2>/dev/null | head -200`;

      const output = execSync(cmd, {
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 5 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

      if (!output) return '(no matches)';

      const lines = output.split('\n').filter(Boolean);
      return lines.slice(0, 200).join('\n') +
        (lines.length > 200 ? `\n... and ${lines.length - 200} more` : '');
    } catch {
      return '(no matches or grep failed)';
    }
  },
};
