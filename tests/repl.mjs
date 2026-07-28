#!/usr/bin/env node
/**
 * Interactive test REPL for the junecoder agent.
 * Usage: node --env-file=.env test.mjs
 */
import { createInterface } from 'node:readline';
import { createAgent, runAgent } from '../agent.mjs';
import { defaultConfig } from '../config.mjs';

const config = defaultConfig();
const apiKey = process.env.DEEPSEEK_API_KEY;

if (!apiKey) {
  console.error('Error: DEEPSEEK_API_KEY not set in .env');
  process.exit(1);
}

config.provider.apiKey = apiKey;

const agent = createAgent({ provider: config.provider, config });

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: '\n> ',
});

console.log('junecoder — type your prompt, Ctrl+C to exit\n');

rl.prompt();

rl.on('line', async (line) => {
  const input = line.trim();
  if (!input) {
    rl.prompt();
    return;
  }

  if (input === 'exit' || input === 'quit') {
    console.log('Bye.');
    process.exit(0);
  }

  try {
    const result = await runAgent(agent, input, {
      onToken: (t) => process.stdout.write(t),
      onToolCall: (name) => process.stdout.write(`\n[tool: ${name}] `),
    });
    console.log('\n');
  } catch (err) {
    console.error('\nError:', err.message);
  }

  rl.prompt();
});

rl.on('close', () => {
  console.log('\nBye.');
  process.exit(0);
});
