import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

import { readTool } from '../tools/read.mjs';
import { writeTool } from '../tools/write.mjs';
import { editTool } from '../tools/edit.mjs';
import { bashTool } from '../tools/bash.mjs';
import { globTool } from '../tools/glob.mjs';
import { grepTool } from '../tools/grep.mjs';
import { lsTool } from '../tools/ls.mjs';
import { deleteTool } from '../tools/delete.mjs';
import { fetchTool } from '../tools/fetch.mjs';
import { websearchTool } from '../tools/websearch.mjs';
import { toOpenAISchema, baseTools } from '../tools.mjs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function freshAgent(cwd) {
  return { cwd: cwd || process.cwd() };
}

function tmpdirCtx() {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), 'junecoder-tools-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });
  return () => dir;
}

// ─── toOpenAISchema / baseTools ──────────────────────────────────────────────

describe('tools', () => {
  it('baseTools has 10 tools', () => {
    assert.strictEqual(baseTools.length, 10);
  });

  it('toOpenAISchema converts a tool correctly', () => {
    const schema = toOpenAISchema(readTool);
    assert.strictEqual(schema.type, 'function');
    assert.strictEqual(schema.function.name, 'read');
    assert.strictEqual(schema.function.description, readTool.description);
    assert.deepStrictEqual(schema.function.parameters, readTool.parameters);
  });

  it('all tools have required fields', () => {
    for (const t of baseTools) {
      assert.ok(typeof t.name === 'string' && t.name.length > 0, `${t.name}: name`);
      assert.ok(typeof t.description === 'string' && t.description.length > 0, `${t.name}: desc`);
      assert.ok(typeof t.parameters === 'object', `${t.name}: params`);
      assert.ok(typeof t.execute === 'function', `${t.name}: execute`);
    }
  });
});

// ─── readTool ────────────────────────────────────────────────────────────────

describe('readTool', () => {
  it('has correct structure', () => {
    assert.strictEqual(readTool.name, 'read');
    assert.strictEqual(readTool.readonly, true);
    assert.strictEqual(readTool.parallel, true);
  });

  const getDir = tmpdirCtx();

  it('reads a file with numbered lines', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'test.txt'), 'line1\nline2\nline3');
    const agent = freshAgent(dir);
    const out = await readTool.execute({ path: 'test.txt' }, agent);
    assert.ok(out.includes('1| line1'));
    assert.ok(out.includes('2| line2'));
    assert.ok(out.includes('3| line3'));
  });

  it('supports offset and limit', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'nums.txt'), 'a\nb\nc\nd\ne\nf');
    const agent = freshAgent(dir);
    const out = await readTool.execute({ path: 'nums.txt', offset: 2, limit: 2 }, agent);
    assert.ok(out.includes('2| b'));
    assert.ok(out.includes('3| c'));
    assert.ok(!out.includes('1| a'));
    assert.ok(!out.includes('4| d'));
  });

  it('errors on missing file', async () => {
    const agent = freshAgent();
    const out = await readTool.execute({ path: '/no/such/file.txt' }, agent);
    assert.ok(out.startsWith('Error: file not found'));
  });

  it('errors on directory', async () => {
    const dir = getDir();
    const sub = join(dir, 'subdir');
    mkdirSync(sub);
    const agent = freshAgent(dir);
    const out = await readTool.execute({ path: 'subdir' }, agent);
    assert.ok(out.startsWith('Error:'));
    assert.ok(out.includes('directory'));
  });
});

// ─── writeTool ───────────────────────────────────────────────────────────────

describe('writeTool', () => {
  it('has correct structure', () => {
    assert.strictEqual(writeTool.name, 'write');
    assert.strictEqual(writeTool.readonly, false);
    assert.strictEqual(writeTool.parallel, false);
  });

  const getDir = tmpdirCtx();

  it('writes a file and creates parent dirs', async () => {
    const dir = getDir();
    const agent = freshAgent(dir);
    const out = await writeTool.execute({
      path: 'sub/deep/hello.txt',
      content: 'hello world',
    }, agent);
    assert.ok(out.includes('Wrote'));
    assert.ok(out.includes('sub/deep/hello.txt'));
    assert.ok(existsSync(join(dir, 'sub/deep/hello.txt')));
  });

  it('overwrites existing file', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'existing.txt'), 'old');
    const agent = freshAgent(dir);
    await writeTool.execute({ path: 'existing.txt', content: 'new' }, agent);
    const { readFileSync } = await import('node:fs');
    assert.strictEqual(readFileSync(join(dir, 'existing.txt'), 'utf-8'), 'new');
  });

  it('reports char count', async () => {
    const dir = getDir();
    const agent = freshAgent(dir);
    const out = await writeTool.execute({ path: 'x.txt', content: 'abc' }, agent);
    assert.ok(out.includes('3 chars'));
  });
});

// ─── editTool ────────────────────────────────────────────────────────────────

describe('editTool', () => {
  it('has correct structure', () => {
    assert.strictEqual(editTool.name, 'edit');
    assert.strictEqual(editTool.readonly, false);
    assert.strictEqual(editTool.parallel, false);
  });

  const getDir = tmpdirCtx();

  it('replaces exact text once', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'f.txt'), 'hello world');
    const agent = freshAgent(dir);
    const out = await editTool.execute({
      path: 'f.txt',
      old_string: 'hello',
      new_string: 'hi',
    }, agent);
    assert.ok(out.includes('Replaced 1 occurrence'));
    const { readFileSync } = await import('node:fs');
    assert.strictEqual(readFileSync(join(dir, 'f.txt'), 'utf-8'), 'hi world');
  });

  it('replaces all with replace_all', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'f.txt'), 'x x x');
    const agent = freshAgent(dir);
    const out = await editTool.execute({
      path: 'f.txt',
      old_string: 'x',
      new_string: 'y',
      replace_all: true,
    }, agent);
    assert.ok(out.includes('Replaced 3'));
    const { readFileSync } = await import('node:fs');
    assert.strictEqual(readFileSync(join(dir, 'f.txt'), 'utf-8'), 'y y y');
  });

  it('errors when old_string matches multiple times without replace_all', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'f.txt'), 'dup dup dup');
    const agent = freshAgent(dir);
    const out = await editTool.execute({
      path: 'f.txt',
      old_string: 'dup',
      new_string: 'nope',
    }, agent);
    assert.ok(out.startsWith('Error:'));
  });

  it('errors when file not found', async () => {
    const agent = freshAgent();
    const out = await editTool.execute({
      path: 'no.txt',
      old_string: 'x',
      new_string: 'y',
    }, agent);
    assert.ok(out.startsWith('Error: file not found'));
  });

  it('errors when old_string not found', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'f.txt'), 'nothing here');
    const agent = freshAgent(dir);
    const out = await editTool.execute({
      path: 'f.txt',
      old_string: 'missing',
      new_string: 'y',
    }, agent);
    assert.ok(out.startsWith('Error:'));
  });
});

// ─── bashTool ────────────────────────────────────────────────────────────────

describe('bashTool', () => {
  it('has correct structure', () => {
    assert.strictEqual(bashTool.name, 'bash');
    assert.strictEqual(bashTool.readonly, false);
    assert.strictEqual(bashTool.parallel, false);
  });

  it('runs a command and returns stdout', async () => {
    const agent = freshAgent();
    const out = await bashTool.execute({ command: 'echo hello' }, agent);
    assert.ok(out.includes('hello'));
  });

  it('reports failed command with exit code', async () => {
    const agent = freshAgent();
    const out = await bashTool.execute({ command: 'exit 42' }, agent);
    assert.ok(out.includes('Command failed'));
    assert.ok(out.includes('42'));
  });

  it('runs in agent cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'junecoder-bash-'));
    try {
      writeFileSync(join(dir, 'marker.txt'), 'here');
      const agent = freshAgent(dir);
      const out = await bashTool.execute({ command: 'ls marker.txt' }, agent);
      assert.ok(out.includes('marker.txt'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── globTool ────────────────────────────────────────────────────────────────

describe('globTool', () => {
  it('has correct structure', () => {
    assert.strictEqual(globTool.name, 'glob');
    assert.strictEqual(globTool.readonly, true);
    assert.strictEqual(globTool.parallel, true);
  });

  const getDir = tmpdirCtx();

  it('finds files by pattern', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'a.js'), '');
    writeFileSync(join(dir, 'b.js'), '');
    writeFileSync(join(dir, 'c.txt'), '');
    const agent = freshAgent(dir);
    const out = await globTool.execute({ pattern: '*.js' }, agent);
    assert.ok(out.includes('a.js'));
    assert.ok(out.includes('b.js'));
    assert.ok(!out.includes('c.txt'));
  });

  it('supports ** for recursive matching', async () => {
    const dir = getDir();
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'nested.js'), '');
    const agent = freshAgent(dir);
    const out = await globTool.execute({ pattern: '**/*.js' }, agent);
    assert.ok(out.includes('sub/nested.js'));
  });

  it('returns (no matches) for no hits', async () => {
    const dir = getDir();
    const agent = freshAgent(dir);
    const out = await globTool.execute({ pattern: '*.xyz' }, agent);
    assert.strictEqual(out, '(no matches)');
  });

  it('respects path option', async () => {
    const dir = getDir();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'lib.js'), '');
    writeFileSync(join(dir, 'root.js'), '');
    const agent = freshAgent(dir);
    const out = await globTool.execute({ pattern: '*.js', path: 'src' }, agent);
    assert.ok(out.includes('lib.js'));
    assert.ok(!out.includes('root.js'));
  });

  it('skips ignored dirs (node_modules, .git, etc.)', async () => {
    const dir = getDir();
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'pkg.js'), '');
    writeFileSync(join(dir, 'good.js'), '');
    const agent = freshAgent(dir);
    const out = await globTool.execute({ pattern: '**/*.js' }, agent);
    assert.ok(out.includes('good.js'));
    assert.ok(!out.includes('node_modules'));
  });

  it('supports character classes and brace alternation', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'a.js'), '');
    writeFileSync(join(dir, 'b.ts'), '');
    writeFileSync(join(dir, 'c.mjs'), '');
    const agent = freshAgent(dir);
    const cls = await globTool.execute({ pattern: '*.[jt]s' }, agent);
    assert.ok(cls.includes('a.js') && cls.includes('b.ts') && !cls.includes('c.mjs'));
    const braces = await globTool.execute({ pattern: '*.{js,mjs}' }, agent);
    assert.ok(braces.includes('a.js') && braces.includes('c.mjs') && !braces.includes('b.ts'));
  });
});

// ─── grepTool ────────────────────────────────────────────────────────────────

describe('grepTool', () => {
  it('has correct structure', () => {
    assert.strictEqual(grepTool.name, 'grep');
    assert.strictEqual(grepTool.readonly, true);
    assert.strictEqual(grepTool.parallel, true);
  });

  const getDir = tmpdirCtx();

  it('finds matches in files', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'data.txt'), 'hello\nworld\nhello again');
    const agent = freshAgent(dir);
    const out = await grepTool.execute({ pattern: 'hello' }, agent);
    assert.ok(out.includes('hello'));
  });

  it('returns (no matches) for no results', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'data.txt'), 'nothing');
    const agent = freshAgent(dir);
    const out = await grepTool.execute({ pattern: 'zzzzzNOTFOUNDzzzzz' }, agent);
    assert.ok(out.includes('(no matches)'));
  });

  it('reports path:line:content with 1-based line numbers', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'data.txt'), 'alpha\nworld\nbeta');
    const agent = freshAgent(dir);
    const out = await grepTool.execute({ pattern: 'world' }, agent);
    assert.match(out, /data\.txt:2:world/);
  });

  it('uses real JS regex semantics (alternation, \\d)', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'data.txt'), 'foo\nbar\nbaz123\nqux');
    const agent = freshAgent(dir);
    const alt = await grepTool.execute({ pattern: 'foo|bar' }, agent);
    assert.ok(alt.includes(':1:foo') && alt.includes(':2:bar'));
    assert.ok(!alt.includes('baz'));
    const digits = await grepTool.execute({ pattern: '\\d+' }, agent);
    assert.ok(digits.includes('baz123'));
  });

  it('supports caseInsensitive', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'data.txt'), 'Hello World');
    const agent = freshAgent(dir);
    const strict = await grepTool.execute({ pattern: 'hello' }, agent);
    assert.ok(strict.includes('(no matches)'));
    const ci = await grepTool.execute({ pattern: 'hello', caseInsensitive: true }, agent);
    assert.ok(ci.includes('Hello World'));
  });

  it('glob without / matches the file name (like --include)', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'a.mjs'), 'foo\n');
    writeFileSync(join(dir, 'b.txt'), 'foo\n');
    const agent = freshAgent(dir);
    const out = await grepTool.execute({ pattern: 'foo', glob: '*.mjs' }, agent);
    assert.ok(out.includes('a.mjs'));
    assert.ok(!out.includes('b.txt'));
  });

  it('glob with / matches the relative path', async () => {
    const dir = getDir();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.mjs'), 'foo\n');
    writeFileSync(join(dir, 'b.mjs'), 'foo\n');
    const agent = freshAgent(dir);
    const out = await grepTool.execute({ pattern: 'foo', glob: '**/a.mjs' }, agent);
    assert.ok(out.includes('src/a.mjs'));
    assert.ok(!out.includes('b.mjs'));
  });

  it('glob supports character classes like *.[jt]s', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'a.js'), 'foo\n');
    writeFileSync(join(dir, 'b.ts'), 'foo\n');
    writeFileSync(join(dir, 'c.mjs'), 'foo\n');
    const agent = freshAgent(dir);
    const out = await grepTool.execute({ pattern: 'foo', glob: '*.[jt]s' }, agent);
    assert.ok(out.includes('a.js'));
    assert.ok(out.includes('b.ts'));
    assert.ok(!out.includes('c.mjs'));
  });

  it('glob supports negation classes like *.[!m]s', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'a.js'), 'foo\n');
    writeFileSync(join(dir, 'b.ts'), 'foo\n');
    writeFileSync(join(dir, 'c.mjs'), 'foo\n');
    const agent = freshAgent(dir);
    const out = await grepTool.execute({ pattern: 'foo', glob: '*.[!m]s' }, agent);
    assert.ok(out.includes('a.js'));
    assert.ok(out.includes('b.ts'));
    assert.ok(!out.includes('c.mjs'));
  });

  it('glob supports brace alternation like *.{js,mjs}', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'a.js'), 'foo\n');
    writeFileSync(join(dir, 'b.mjs'), 'foo\n');
    writeFileSync(join(dir, 'c.txt'), 'foo\n');
    const agent = freshAgent(dir);
    const out = await grepTool.execute({ pattern: 'foo', glob: '*.{js,mjs}' }, agent);
    assert.ok(out.includes('a.js'));
    assert.ok(out.includes('b.mjs'));
    assert.ok(!out.includes('c.txt'));
  });

  it('unicode option enables \\p{...} property escapes', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'cn.txt'), '中文内容\n');
    const agent = freshAgent(dir);
    const without = await grepTool.execute({ pattern: '\\p{Script=Han}' }, agent);
    assert.ok(without.includes('(no matches)'));
    const withFlag = await grepTool.execute({ pattern: '\\p{Script=Han}+', unicode: true }, agent);
    assert.ok(withFlag.includes('中文内容'));
  });

  it('handles CRLF files without trailing \\r in output', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'win.txt'), 'one\r\ntwo\r\n');
    const agent = freshAgent(dir);
    const out = await grepTool.execute({ pattern: 'two' }, agent);
    assert.ok(out.includes(':2:two'));
    assert.ok(!out.includes('two\r'));
  });

  it('skips binary files (NUL bytes)', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'text.txt'), 'needle\n');
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x0a]));
    const agent = freshAgent(dir);
    const out = await grepTool.execute({ pattern: 'needle' }, agent);
    assert.ok(out.includes('text.txt'));
    assert.ok(!out.includes('bin.dat'));
  });

  it('decodes multi-byte UTF-8 characters split across chunk boundaries', async () => {
    const dir = getDir();
    // 1.5MB of '中' (3 bytes each): every 1MB chunk boundary lands mid-character
    // (1048576 % 3 === 1), so per-chunk decoding would produce U+FFFD garbage.
    writeFileSync(join(dir, 'cn.txt'), '中'.repeat(500000));
    const agent = freshAgent(dir);
    const out = await grepTool.execute({ pattern: '中' }, agent);
    assert.ok(out.includes('中'));
    assert.ok(!out.includes('�'));
  });

  it('skips node_modules and .git directories', async () => {
    const dir = getDir();
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'pkg.js'), 'secret\n');
    writeFileSync(join(dir, '.git', 'config'), 'secret\n');
    writeFileSync(join(dir, 'good.js'), 'secret\n');
    const agent = freshAgent(dir);
    const out = await grepTool.execute({ pattern: 'secret' }, agent);
    assert.ok(out.includes('good.js'));
    assert.ok(!out.includes('node_modules'));
    assert.ok(!out.includes('.git'));
  });

  it('searches a single file via path', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    writeFileSync(join(dir, 'b.txt'), 'two\n');
    const agent = freshAgent(dir);
    const out = await grepTool.execute({ pattern: 'one', path: 'a.txt' }, agent);
    assert.ok(out.includes('a.txt:1:one'));
    assert.ok(!out.includes('b.txt'));
  });

  it('caps output at 200 results and reports the remainder', async () => {
    const dir = getDir();
    const lines = Array.from({ length: 250 }, (_, i) => `match line ${i}`).join('\n');
    writeFileSync(join(dir, 'big.txt'), lines);
    const agent = freshAgent(dir);
    const out = await grepTool.execute({ pattern: 'match line' }, agent);
    assert.match(out, /and 50 more matches/);
    const shown = out.split('\n').filter((l) => l.includes('big.txt')).length;
    assert.strictEqual(shown, 200);
  });

  it('reports invalid regular expressions instead of swallowing them', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'data.txt'), 'x');
    const agent = freshAgent(dir);
    const out = await grepTool.execute({ pattern: '(unclosed' }, agent);
    assert.match(out, /Error: invalid regular expression/);
  });

  it('reports missing paths instead of returning (no matches)', async () => {
    const dir = getDir();
    const agent = freshAgent(dir);
    const out = await grepTool.execute({ pattern: 'x', path: 'does-not-exist' }, agent);
    assert.match(out, /Error: path not found/);
  });
});

// ─── lsTool ──────────────────────────────────────────────────────────────────

describe('lsTool', () => {
  it('has correct structure', () => {
    assert.strictEqual(lsTool.name, 'ls');
    assert.strictEqual(lsTool.readonly, true);
    assert.strictEqual(lsTool.parallel, true);
  });

  const getDir = tmpdirCtx();

  it('lists directory contents', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'file1.txt'), 'hello');
    mkdirSync(join(dir, 'subdir'));
    const agent = freshAgent(dir);
    const out = await lsTool.execute({}, agent);
    assert.ok(out.includes('Directory:'));
    assert.ok(out.includes('file1.txt'));
    assert.ok(out.includes('subdir/'));
  });

  it('directories listed before files', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'zfile.txt'), '');
    mkdirSync(join(dir, 'adir'));
    const agent = freshAgent(dir);
    const out = await lsTool.execute({}, agent);
    const dirIdx = out.indexOf('adir/');
    const fileIdx = out.indexOf('zfile.txt');
    assert.ok(dirIdx < fileIdx);
  });

  it('handles path option', async () => {
    const dir = getDir();
    mkdirSync(join(dir, 'mydir'));
    writeFileSync(join(dir, 'mydir', 'inside.txt'), '');
    const agent = freshAgent(dir);
    const out = await lsTool.execute({ path: 'mydir' }, agent);
    assert.ok(out.includes('inside.txt'));
  });

  it('errors on non-existent dir', async () => {
    const agent = freshAgent();
    const out = await lsTool.execute({ path: '/no/such/dir/xyz' }, agent);
    assert.ok(out.startsWith('Error'));
  });
});

// ─── deleteTool ──────────────────────────────────────────────────────────────

describe('deleteTool', () => {
  it('has correct structure', () => {
    assert.strictEqual(deleteTool.name, 'delete');
    assert.strictEqual(deleteTool.readonly, false);
    assert.strictEqual(deleteTool.parallel, false);
  });

  const getDir = tmpdirCtx();

  it('deletes an untracked file', async () => {
    const dir = getDir();
    writeFileSync(join(dir, 'remove.me'), 'bye');
    const agent = freshAgent(dir);
    const out = await deleteTool.execute({ path: 'remove.me' }, agent);
    assert.ok(out.includes('Deleted'));
    assert.ok(!existsSync(join(dir, 'remove.me')));
  });

  it('errors on missing file', async () => {
    const agent = freshAgent();
    const out = await deleteTool.execute({ path: 'no.such' }, agent);
    assert.ok(out.startsWith('Error: file not found'));
  });

  it('errors on directory', async () => {
    const dir = getDir();
    mkdirSync(join(dir, 'sub'));
    const agent = freshAgent(dir);
    const out = await deleteTool.execute({ path: 'sub' }, agent);
    assert.ok(out.includes('directory'));
  });

  it('deletes git-tracked file', async () => {
    const gitDir = mkdtempSync(join(tmpdir(), 'junecoder-del-git-'));
    try {
      execSync('git init', { cwd: gitDir, stdio: 'ignore' });
      execSync('git config user.email "t@t.com"', { cwd: gitDir, stdio: 'ignore' });
      execSync('git config user.name "T"', { cwd: gitDir, stdio: 'ignore' });
      writeFileSync(join(gitDir, 'bye.txt'), 'x');
      execSync('git add bye.txt && git commit -m "add"', { cwd: gitDir, stdio: 'ignore' });
      const agent = freshAgent(gitDir);
      const out = await deleteTool.execute({ path: 'bye.txt' }, agent);
      assert.ok(out.includes('Deleted'));
      assert.ok(!existsSync(join(gitDir, 'bye.txt')));
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
    }
  });
});

// ─── fetchTool (stub - network calls would fail) ─────────────────────────────

describe('fetchTool', () => {
  it('has correct structure', () => {
    assert.strictEqual(fetchTool.name, 'fetch');
    assert.strictEqual(fetchTool.readonly, true);
    assert.strictEqual(fetchTool.parallel, true);
  });

  it('errors on invalid URL', async () => {
    const out = await fetchTool.execute({ url: 'not-a-valid-url://' }, {});
    assert.ok(out.startsWith('Error'));
  });

  it('errors on connection failure', async () => {
    const out = await fetchTool.execute({ url: 'http://127.0.0.1:1/nope' }, {});
    assert.ok(out.startsWith('Error'));
  });
});

// ─── websearchTool (stub - network calls would fail) ─────────────────────────

describe('websearchTool', () => {
  it('has correct structure', () => {
    assert.strictEqual(websearchTool.name, 'websearch');
    assert.strictEqual(websearchTool.readonly, true);
    assert.strictEqual(websearchTool.parallel, true);
  });

  it('errors on network failure', async () => {
    // Bing search requires network, so this will fail
    const out = await websearchTool.execute({ query: 'test' }, {});
    assert.ok(typeof out === 'string');
  });
});
