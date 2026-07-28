/**
 * write tool — write content to a file, creating parent directories as needed.
 *
 * Uses execSync (cat > file) for disk writes to avoid virtual-filesystem isolation
 * that can cause writes to be lost when the agent session ends.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';

/** Escape a path for safe use in a single-quoted shell string. */
function shellEscape(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

export const writeTool = {
  name: 'write',
  description:
    'Write content to a file. Creates parent directories; overwrites existing file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to cwd or absolute' },
      content: { type: 'string', description: 'Full content to write' },
    },
    required: ['path', 'content'],
  },
  readonly: false,
  parallel: false,

  async execute(args, agent) {
    const cwd = agent?.cwd || process.cwd();
    const abs = resolve(cwd, args.path);

    try {
      mkdirSync(dirname(abs), { recursive: true });
      execSync(`cat > ${shellEscape(abs)}`, {
        cwd,
        input: args.content,
        encoding: 'utf-8',
        timeout: 10_000,
        maxBuffer: 20 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Verify the write actually landed
      if (existsSync(abs)) {
        return `Wrote ${args.content.length} chars to ${args.path}`;
      }
      return `Error writing file: write command completed but file not found at ${args.path}`;
    } catch (err) {
      return `Error writing file: ${err.message}`;
    }
  },
};
