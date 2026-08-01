#!/usr/bin/env node
/**
 * junecoder CLI entry point — starts the TUI or single-shot execution.
 *
 * Usage:
 *   junecoder [directory]               # Start TUI in directory (default: .)
 *   junecoder open [directory]          # Start TUI in directory (default: .)
 *   junecoder -d <dir> [prompt]         # Specify working directory
 *   junecoder "write a hello world"     # Single-shot (non-TUI)
 *
 * API keys can be provided via:
 *   1. Interactive setup on first run (TUI)
 *   2. ~/.junecoder/.env (managed by /key command)
 *   3. DEEPSEEK_API_KEY environment variable
 */
import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import './env.mjs';
import { createAgent } from './agent.mjs';
import { startTUI } from './tui.mjs';
import { defaultConfig } from './config.mjs';
import { loadSession } from './session.mjs';
import { memoryDir } from './memory.mjs';

function expandHome(p) {
  if (!p) return p;
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) {
    return join(homedir(), p.slice(1));
  }
  return p;
}

const rawArgs = process.argv.slice(2);

let targetDir = process.cwd();
let isTui = true;
let promptInput = null;

if (rawArgs.length > 0) {
  const first = rawArgs[0];

  if (first === '-h' || first === '--help' || first === 'help') {
    console.log(`junecoder - AI coding agent

Usage:
  junecoder [directory]               Start TUI in directory (default: .)
  junecoder open [directory]          Start TUI in directory (default: .)
  junecoder --dir <path> [prompt]     Set working directory
  junecoder -p, --prompt <prompt>     Run single-shot prompt (non-TUI)
  junecoder "your prompt here"        Run single-shot prompt (non-TUI)

Options:
  -d, --dir <path>    Working directory
  -t, --tui           Force TUI mode
  -p, --prompt <text> Run single-shot mode with prompt
  -h, --help          Show help message
  -v, --version       Show version number
`);
    process.exit(0);
  }

  if (first === '-v' || first === '--version') {
    try {
      const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'));
      console.log(`junecoder v${pkg.version}`);
    } catch {
      console.log('junecoder v1.0.0');
    }
    process.exit(0);
  }

  // Check subcommands and flags
  if (first === 'open' || first === 'ui' || first === 'tui') {
    isTui = true;
    if (rawArgs.length > 1 && !rawArgs[1].startsWith('-')) {
      targetDir = resolve(expandHome(rawArgs[1]));
    }
  } else if (first === '-t' || first === '--tui') {
    isTui = true;
    if (rawArgs.length > 1 && !rawArgs[1].startsWith('-')) {
      const candidate = resolve(expandHome(rawArgs[1]));
      if (existsSync(candidate) && statSync(candidate).isDirectory()) {
        targetDir = candidate;
      }
    }
  } else if (first === '-d' || first === '--dir' || first === '--cwd') {
    if (rawArgs.length > 1) {
      targetDir = resolve(expandHome(rawArgs[1]));
      const rest = rawArgs.slice(2);
      if (rest.length > 0) {
        if (rest[0] === '-t' || rest[0] === '--tui') {
          isTui = true;
        } else if (rest[0] === '-p' || rest[0] === '--prompt') {
          isTui = false;
          promptInput = rest.slice(1).join(' ');
        } else {
          isTui = false;
          promptInput = rest.join(' ');
        }
      } else {
        isTui = true;
      }
    }
  } else if (first === '-p' || first === '--prompt' || first === '-s' || first === '--single-shot') {
    isTui = false;
    promptInput = rawArgs.slice(1).join(' ');
  } else {
    // Check if the argument is a directory path or relative directory reference
    const candidate = resolve(expandHome(first));
    const isDirRef =
      first === '.' ||
      first === './' ||
      first === '.\\' ||
      first === '..' ||
      first === '../' ||
      first === '..\\' ||
      first.startsWith('~') ||
      (existsSync(candidate) && statSync(candidate).isDirectory());

    if (isDirRef) {
      isTui = true;
      targetDir = candidate;
      if (rawArgs.length > 1) {
        const rest = rawArgs.slice(1);
        if (rest[0] === '-p' || rest[0] === '--prompt') {
          isTui = false;
          promptInput = rest.slice(1).join(' ');
        } else if (rest[0] === '-t' || rest[0] === '--tui') {
          isTui = true;
        } else {
          isTui = false;
          promptInput = rest.join(' ');
        }
      }
    } else {
      // Prompt text passed directly
      isTui = false;
      promptInput = rawArgs.join(' ');
    }
  }
}

// Change process working directory if targetDir is specified
if (existsSync(targetDir) && statSync(targetDir).isDirectory()) {
  process.chdir(targetDir);
} else {
  console.error(`Error: Working directory "${targetDir}" does not exist.`);
  process.exit(1);
}

// Load config (defaults only — no config.json) and API key from env
const config = defaultConfig();
const apiKey = process.env.DEEPSEEK_API_KEY || '';

// Only treat as valid if it starts with sk- (DeepSeek key format)
if (apiKey && !apiKey.startsWith('sk-')) {
  config.provider.apiKey = '';  // invalid format, treat as not configured
} else {
  config.provider.apiKey = apiKey;
}

// Create Agent instance with target cwd
const agent = createAgent({
  provider: config.provider,
  config,
  cwd: process.cwd(),
  memory: { dir: memoryDir() },
});

if (!isTui) {
  // Single-shot mode
  if (!promptInput) {
    console.error('Error: No prompt provided for single-shot execution.');
    process.exit(1);
  }

  const { runAgent } = await import('./agent.mjs');
  try {
    const result = await runAgent(agent, promptInput, {
      onToken: (t) => process.stdout.write(t),
      onToolCall: (name) => process.stdout.write(`\n[tool: ${name}] `),
    });
    console.log('');
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
  process.exit(0);
}

// TUI mode
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('Error: Terminal UI requires an interactive TTY.');
  process.exit(1);
}

const restored = loadSession(agent.cwd);
startTUI(agent, { projectDir: agent.cwd, restored, needsSetup: !apiKey });
