/**
 * grep tool — search file contents with a JavaScript regular expression.
 *
 * Pure Node implementation (no shell, no system grep) so semantics are
 * identical on macOS, Linux, and Windows:
 *   - pattern is compiled with `new RegExp()` — real JS regex semantics
 *     (alternation `a|b`, `\d`, `+`, `(…)`, etc. all work as expected)
 *   - no shell escaping, no BSD/GNU grep differences, no grep binary needed
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, basename } from 'node:path';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.turbo', 'coverage',
]);

const MAX_RESULTS = 200;
const MAX_LINE_CHARS = 1000;

export const grepTool = {
  name: 'grep',
  description:
    'Search file contents with a JavaScript regular expression. Returns matching lines as path:line: content.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'JavaScript regular expression (e.g. "foo|bar", "\\d+", "const \\w+ =")' },
      path: { type: 'string', description: 'Directory or file to search (default cwd)' },
      glob: { type: 'string', description: "Only search files matching this glob (e.g. '*.mjs', '**/*.test.mjs'). Without '/', matched against the file name; with '/', matched against the full relative path." },
      caseInsensitive: { type: 'boolean', description: 'Match case-insensitively (equivalent to the JS /i flag). Default false.' },
    },
    required: ['pattern'],
  },
  readonly: true,
  parallel: true,

  async execute(args, agent) {
    const cwd = agent?.cwd || process.cwd();
    const base = args.path ? resolve(cwd, args.path) : cwd;

    // Compile the pattern as a real JS regex — invalid patterns are reported,
    // not silently swallowed like the old shell version did.
    let flags = '';
    if (args.caseInsensitive) flags += 'i';
    let regex;
    try {
      regex = new RegExp(args.pattern, flags);
    } catch (err) {
      return `Error: invalid regular expression: ${err.message}`;
    }

    let fileMatcher = null;
    if (args.glob) {
      try {
        fileMatcher = makeFileMatcher(args.glob);
      } catch (err) {
        return `Error: invalid glob: ${err.message}`;
      }
    }

    let st;
    try {
      st = statSync(base);
    } catch {
      return `Error: path not found: ${args.path || cwd}`;
    }

    const results = [];
    let totalMatches = 0;

    try {
      if (st.isFile()) {
        scanFile(base, regex, fileMatcher, results, () => totalMatches++);
      } else {
        for (const relPath of walkFilesSync(base)) {
          const abs = resolve(base, relPath);
          if (fileMatcher && !fileMatcher(relPath, basename(relPath))) continue;
          scanFile(abs, regex, null, results, () => totalMatches++);
        }
      }
    } catch (err) {
      return `Error: search failed: ${err.message}`;
    }

    if (totalMatches === 0) return '(no matches)';

    const shown = results
      .slice(0, MAX_RESULTS)
      .map((r) => `${r.path}:${r.line}:${r.content}`)
      .join('\n');
    const more = totalMatches > MAX_RESULTS
      ? `\n... and ${totalMatches - MAX_RESULTS} more matches`
      : '';
    return shown + more;
  },
};

/** Search a single file for regex matches. */
function scanFile(abs, regex, fileMatcher, results, countMatch) {
  if (fileMatcher) {
    // Single-file mode: apply the glob to the file name.
    const name = basename(abs);
    if (!fileMatcher(name, name)) return;
  }
  const buf = readFileSync(abs);
  if (buf.length === 0) return;
  // Treat files containing NUL bytes as binary and skip them (like grep -I).
  if (buf.includes(0)) return;

  const text = buf.toString('utf-8');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!regex.test(line)) continue;
    countMatch();
    if (results.length < MAX_RESULTS) {
      const content = line.length > MAX_LINE_CHARS
        ? line.slice(0, MAX_LINE_CHARS) + '…'
        : line;
      results.push({ path: displayPath(abs), line: i + 1, content });
    }
  }
}

/** Recursively walk files under `dir`, yielding POSIX-style relative paths. Skips IGNORED_DIRS. */
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
      yield* walkFilesSync(resolve(dir, e.name), relPath);
    } else {
      yield relPath;
    }
  }
}

/**
 * Build a matcher for the `glob` param.
 * - Contains '/': match against the full relative path (e.g. '**' + '/*.test.mjs').
 * - Otherwise: match against the file name only ('*.mjs'), like grep --include.
 */
function makeFileMatcher(pattern) {
  const regex = globToRegex(pattern);
  return pattern.includes('/')
    ? (relPath) => regex.test(relPath)
    : (_relPath, name) => regex.test(name);
}

/** Convert a glob to an anchored RegExp: '**' + '/' = zero-or-more dirs, '**' = across dirs, '*' = within a segment, '?' = single char. */
function globToRegex(pattern) {
  const DS = '\u0001';
  const DP = '\u0002';
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

/** Path for display: './foo/bar.mjs' when under cwd, otherwise the absolute path. */
function displayPath(abs) {
  const rel = relative(process.cwd(), abs).split('\\').join('/');
  return rel.startsWith('..') ? abs : './' + rel;
}
