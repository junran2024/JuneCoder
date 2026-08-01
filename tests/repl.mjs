#!/usr/bin/env node
/**
 * Interactive test REPL for the junecoder agent.
 * Usage: DEEPSEEK_API_KEY=sk-... node tests/repl.mjs
 */
import { createInterface } from 'node:readline';
import { createAgent, runAgent } from '../agent.mjs';
import { defaultAgentConfig } from '../config.mjs';
import { getActiveProvider } from '../config-provider.mjs';

const provider = getActiveProvider();

if (!provider.apiKey) {
  console.error('Error: No API key. Set DEEPSEEK_API_KEY env var or ~/.junecoder/config.json');
  process.exit(1);
}

const config = { agent: defaultAgentConfig(), provider };

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
