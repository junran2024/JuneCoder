/**
 * grep tool — search file contents with a JavaScript regular expression.
 *
 * Pure Node implementation (no shell, no system grep) so semantics are
 * identical on macOS, Linux, and Windows:
 *   - pattern is compiled with `new RegExp()` — real JS regex semantics
 *     (alternation `a|b`, `\d`, `+`, `(…)`, etc. all work as expected)
 *   - no shell escaping, no BSD/GNU grep differences, no grep binary needed
 */
import { readdirSync, createReadStream, statSync } from 'node:fs';
import { resolve, relative, basename } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

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
      glob: { type: 'string', description: "Only search files matching this glob (e.g. '*.mjs', '**/*.test.mjs', '*.[jt]s', '*.{js,mjs}'). Without '/', matched against the file name; with '/', matched against the full relative path." },
      caseInsensitive: { type: 'boolean', description: 'Match case-insensitively (equivalent to the JS /i flag). Default false.' },
      unicode: { type: 'boolean', description: 'Compile with the JS /u flag — enables \\p{...} Unicode property escapes (e.g. "\\p{Script=Han}"). Default false.' },
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
    if (args.unicode) flags += 'u';
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
        await scanFile(base, regex, fileMatcher, results, () => totalMatches++);
      } else {
        for (const relPath of walkFilesSync(base)) {
          const abs = resolve(base, relPath);
          if (fileMatcher && !fileMatcher(relPath, basename(relPath))) continue;
          // A single unreadable file must not abort the whole search —
          // skip it and keep scanning, like `grep -r 2>/dev/null` did.
          try {
            await scanFile(abs, regex, null, results, () => totalMatches++);
          } catch {
            // unreadable / deleted mid-scan: skip
          }
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

/**
 * Stream a file and test each line against the regex.
 * Memory use is O(longest line), not O(file size) — safe for GB-level files.
 */
async function scanFile(abs, regex, fileMatcher, results, countMatch) {
  if (fileMatcher) {
    // Single-file mode: apply the glob to the file name.
    const name = basename(abs);
    if (!fileMatcher(name, name)) return;
  }

  const decoder = new StringDecoder('utf-8');
  const stream = createReadStream(abs, { highWaterMark: 1 << 20 }); // 1 MB chunks
  let pending = '';
  let lineNo = 1;

  const emit = (line) => {
    if (!regex.test(line)) return;
    countMatch();
    if (results.length < MAX_RESULTS) {
      const content = line.length > MAX_LINE_CHARS
        ? line.slice(0, MAX_LINE_CHARS) + '…'
        : line;
      results.push({ path: displayPath(abs), line: lineNo, content });
    }
  };

  for await (const chunk of stream) {
    // Binary detection: a UTF-8 text file never contains NUL bytes.
    if (chunk.includes(0)) return;
    pending += decoder.write(chunk);
    let idx;
    while ((idx = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, idx);
      pending = pending.slice(idx + 1);
      // Strip a trailing \r (CRLF) at line-emit time so a \r\n pair split
      // across chunk boundaries is handled correctly.
      emit(line.endsWith('\r') ? line.slice(0, -1) : line);
      lineNo++;
    }
  }
  // Last line may have no trailing newline.
  if (pending) {
    emit(pending.endsWith('\r') ? pending.slice(0, -1) : pending);
  }
}

/** Recursively walk regular files under `dir`, yielding POSIX-style relative paths. Skips IGNORED_DIRS and non-regular entries (symlinks, sockets, etc.). */
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
    } else if (e.isFile()) {
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

/**
 * Convert a glob to an anchored RegExp:
 * '**' + '/' = zero-or-more dirs, '**' = across dirs, '*' = within a segment,
 * '?' = one char, '[a-z]' / '[!a-z]' = character class, '{a,b}' = alternation.
 */
function globToRegex(pattern) {
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
    } else if (!/[A-Za-z0-9_/-]/.test(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp(out + String.fromCharCode(36));
}

/** Path for display: './foo/bar.mjs' when under cwd, otherwise the absolute path. */
function displayPath(abs) {
  const rel = relative(process.cwd(), abs).split('\\').join('/');
  return rel.startsWith('..') ? abs : './' + rel;
}
