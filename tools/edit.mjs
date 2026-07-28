/**
 * edit tool — replace exact text in a file.
 *
 * Uses execSync (cat > file) for disk writes to avoid virtual-filesystem isolation
 * that can cause writes to be lost when the agent session ends.
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';

/** Escape a path for safe use in a single-quoted shell string. */
function shellEscape(str) {
  return "'" + str.replace(/'/g, "'\\''") + "'";
}

export const editTool = {
  name: 'edit',
  description:
    'Edit a file by exact string replacement. old_string must match exactly once unless replace_all is set.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      old_string: { type: 'string', description: 'Exact text to find and replace' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace all occurrences instead of just one (default false)' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  readonly: false,
  parallel: false,

  async execute(args, agent) {
    const cwd = agent?.cwd || process.cwd();
    const abs = resolve(cwd, args.path);

    if (!existsSync(abs)) {
      return `Error: file not found: ${args.path}`;
    }

    try {
      const original = readFileSync(abs, 'utf-8');
      const count = original.split(args.old_string).length - 1;

      if (count === 0) {
        return `Error: old_string not found in ${args.path}. Make sure the text matches exactly (whitespace, indentation).`;
      }

      if (count > 1 && !args.replace_all) {
        return `Error: old_string matches ${count} times in ${args.path}. Use replace_all=true or add more surrounding context to make it unique.`;
      }

      const updated = args.replace_all
        ? original.split(args.old_string).join(args.new_string)
        : original.replace(args.old_string, args.new_string);

      mkdirSync(dirname(abs), { recursive: true });
      execSync(`cat > ${shellEscape(abs)}`, {
        cwd,
        input: updated,
        encoding: 'utf-8',
        timeout: 10_000,
        maxBuffer: 20 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return `Replaced ${args.replace_all ? count : 1} occurrence(s) in ${args.path}`;
    } catch (err) {
      return `Error editing file: ${err.message}`;
    }
  },
};
