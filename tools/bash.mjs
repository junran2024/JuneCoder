/**
 * bash tool — execute a shell command and return stdout+stderr.
 */
import { execSync } from 'node:child_process';

export const bashTool = {
  name: 'bash',
  description:
    'Execute a shell command and return stdout+stderr. Use for running commands, builds, tests.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeout: { type: 'number', description: 'Timeout in ms (default 120000)' },
    },
    required: ['command'],
  },
  readonly: false,
  parallel: false,

  async execute(args, agent) {
    const cwd = agent?.cwd || process.cwd();
    const timeout = args.timeout || 120_000;

    try {
      const output = execSync(args.command, {
        cwd,
        encoding: 'utf-8',
        timeout,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return output || '(command completed with no output)';
    } catch (err) {
      const stdout = err.stdout || '';
      const stderr = err.stderr || '';
      const msg = err.message || String(err);
      return `Command failed (exit code ${err.status || '?'}): ${msg}\n${stdout}${stderr}`;
    }
  },
};
