/**
 * grep tool — search file contents with a regex.
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execSync } from 'node:child_process';

function grepJs(baseDir, patternStr) {
  const matches = [];
  let re;
  try {
    re = new RegExp(patternStr);
  } catch {
    return [];
  }

  function walk(dir) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const content = readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              matches.push(`${fullPath}:${i + 1}:${lines[i]}`);
              if (matches.length >= 200) return;
            }
          }
        } catch { /* skip binary or unreadable files */ }
      }
    }
  }

  try {
    const stat = statSync(baseDir);
    if (stat.isFile()) {
      const content = readFileSync(baseDir, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matches.push(`${baseDir}:${i + 1}:${lines[i]}`);
        }
      }
    } else {
      walk(baseDir);
    }
  } catch { /* ignore */ }

  return matches;
}

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
      const escaped = args.pattern.replace(/'/g, "'\\''");
      let cmd = `grep -rn${globPart} '${escaped}' "${base}" 2>/dev/null | head -200`;

      const output = execSync(cmd, {
        encoding: 'utf-8',
        timeout: 5000,
        maxBuffer: 5 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();

      if (output) {
        const lines = output.split('\n').filter(Boolean);
        return lines.slice(0, 200).join('\n') +
          (lines.length > 200 ? `\n... and ${lines.length - 200} more` : '');
      }
    } catch {
      // Fall through to JS implementation
    }

    const matches = grepJs(base, args.pattern);
    if (matches.length === 0) return '(no matches)';
    return matches.slice(0, 200).join('\n') +
      (matches.length > 200 ? `\n... and ${matches.length - 200} more` : '');
  },
};
