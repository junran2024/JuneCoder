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
    'Find files by glob pattern. Returns matching paths. Supports **, *, ?, [a-z] character classes, and {a,b} alternation.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern — supports **, *, ?, [a-z] classes, and {a,b} alternation (e.g. "**/*.{js,mjs}", "*.[jt]s")' },
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

/**
 * Convert a glob to an anchored RegExp:
 * '**' + '/' = zero-or-more dirs, '**' = across dirs, '*' = within a segment,
 * '?' = one char, '[a-z]' / '[!a-z]' = character class, '{a,b}' = alternation.
 */
function globToRegex(pattern) {
  const SAFE = /[A-Za-z0-9_/-]/; // chars that need no escaping in the regex
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += pattern[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += pattern[i + 2] === '/' ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\['; // unterminated class: treat '[' as a literal
        continue;
      }
      let cls = pattern.slice(i + 1, close);
      if (cls.startsWith('!') || cls.startsWith('^')) cls = '^' + cls.slice(1);
      if (cls === '' || cls === '^') {
        out += '\\[\\]'; // empty class: treat as a literal
      } else {
        out += '[' + cls + ']';
      }
      i = close;
    } else if (c === '{') {
      const close = pattern.indexOf('}', i + 1);
      const inner = close !== -1 ? pattern.slice(i + 1, close) : '';
      if (close !== -1 && inner.includes(',')) {
        out += '(?:' + inner.split(',').join('|') + ')';
        i = close;
      } else {
        out += '\\{';
      }
    } else if (!SAFE.test(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp(out + String.fromCharCode(36));
}
