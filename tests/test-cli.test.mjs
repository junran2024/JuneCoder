import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

const cliPath = resolve('./cli.js');

test('CLI --help prints usage information', () => {
  const output = execSync(`node "${cliPath}" --help`, { encoding: 'utf-8' });
  assert.match(output, /Usage:/);
  assert.match(output, /junecoder \[directory\]/);
  assert.match(output, /junecoder open/);
});

test('CLI --version prints version', () => {
  const output = execSync(`node "${cliPath}" --version`, { encoding: 'utf-8' });
  assert.match(output, /junecoder v/);
});

test('CLI open <non-existent-dir> fails with error', () => {
  assert.throws(() => {
    execSync(`node "${cliPath}" open /non/existent/dir/path/12345`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }, (err) => {
    assert.match(err.stderr || err.stdout || '', /does not exist/);
    return true;
  });
});

test('CLI TUI mode non-TTY fails gracefully', () => {
  // Executing cli.js open . via child_process without TTY stream attached
  assert.throws(() => {
    execSync(`node "${cliPath}" open .`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DEEPSEEK_API_KEY: 'sk-dummy-key-for-test' },
    });
  }, (err) => {
    assert.match(err.stderr || err.stdout || '', /Terminal UI requires an interactive TTY/);
    return true;
  });
});
