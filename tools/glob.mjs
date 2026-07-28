/**
 * glob tool — find files by glob pattern.
 */
import { readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.turbo', 'coverage',
]);

export const globTool = {
  name: 'glob',
  description:
    'Find files by glob pattern. Returns matching paths. Supports ** for recursive matching.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern — supports **, *, ?, and character classes' },
      path: { type: 'string', description: 'Directory to search in (default cwd)' },
    },
    required: ['pattern'],
  },
  readonly: true,
  parallel: true,

  async execute(args, agent) {
    const cwd = agent?.cwd || process.cwd();
    const base = args.path ? resolve(cwd, args.path) : cwd;
    const regex = globToRegex(args.pattern);
    const results = [];

    try {
      for (const relPath of walkFilesSync(base)) {
        if (regex.test(relPath)) {
          results.push(relPath);
          if (results.length >= 1000) break;
        }
      }
    } catch {
      return '(no matches or glob failed)';
    }

    if (results.length === 0) return '(no matches)';

    results.sort();
    return results.slice(0, 200).join('\n') +
      (results.length > 200 ? `\n... and ${results.length - 200} more` : '');
  },
};

/** Recursively walk files, yielding relative paths (skips IGNORED_DIRS). */
function* walkFilesSync(dir, rel = '') {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue;
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      yield* walkFilesSync(join(dir, e.name), relPath);
    } else {
      yield relPath;
    }
  }
}

/** Convert a glob pattern to a RegExp: **\/ matches zero-or-more dirs, ** matches across dirs, * matches within a segment, ? matches a single char. */
function globToRegex(pattern) {
  const DS = '\u0001'; // placeholder for **/
  const DP = '\u0002'; // placeholder for **
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, DS)
    .replace(/\*\*/g, DP)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replaceAll(DS, '(?:.*/)?')
    .replaceAll(DP, '.*');
  return new RegExp('^' + escaped + '$');
}
