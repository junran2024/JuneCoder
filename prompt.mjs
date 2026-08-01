import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { loadSkills, formatSkillListing } from './skills.mjs';
import { loadMcpProjects, formatMcpListing } from './mcp.mjs';
import { MAX_INSTRUCTION_CHARS } from './config.mjs';

// ─── System Prompt ────────────────────────────────────────────────────────────
// Loaded from prompt.md at module init time. Falls back to a minimal prompt if
// the file is missing or unreadable.

function loadSystemPrompt() {
  const cwd = process.cwd();
  for (const candidate of [join(cwd, 'prompt.md'), join(homedir(), '.junecoder', 'prompt.md')]) {
    try {
      if (existsSync(candidate)) return readFileSync(candidate, 'utf-8').trim();
    } catch { /* keep trying */ }
  }
  return 'You are JuneCoder, a coding agent.';
}

export const DEFAULT_SYSTEM_PROMPT = loadSystemPrompt();

// ─── Goal Mode ────────────────────────────────────────────────────────────────

export const GOAL_MODE_PREAMBLE =
  '[Goal mode — you are working on an autonomous goal]\n' +
  '\n' +
  'Goal mode differs from normal collaborative mode. In goal mode, you pursue the objective autonomously:\n' +
  '\n' +
  '- Stay relentlessly focused on the goal. Don\'t get sidetracked or lost in the middle, even across many turns.\n' +
  '- Drive forward without frequent back-and-forth. Make decisions yourself — don\'t wait for confirmation on every step.\n' +
  '- If you hit the same blocker 3 genuine attempts in a row, call goal(action=\'blocked\') with the reason. Don\'t loop indefinitely.\n' +
  '- Completion is defined by the goal\'s criteria. Do not declare victory unless the criteria are actually met. When they are, call goal(action=\'complete\') and summarize the evidence.';

// ─── Project Instructions ─────────────────────────────────────────────────────

/**
 * Load project instructions from AGENTS.md, PROJECT_RULES.md etc.
 * Reads from both ~/.junecoder/ and the local project directory.
 * @param {string} cwd
 * @returns {string} combined instructions
 */
export function loadProjectInstructions(cwd) {
  const sources = [
    join(homedir(), '.junecoder', 'AGENTS.md'),
    join(cwd, 'AGENTS.md'),
    join(cwd, 'PROJECT_RULES.md'),
    join(cwd, '.cursorrules'),
    join(cwd, '.windsurfrules'),
  ];

  const contents = [];
  for (const src of sources) {
    if (!existsSync(src)) continue;
    try {
      const text = readFileSync(src, 'utf-8').trim();
      if (text) {
        const label = basename(src);
        contents.push(`--- ${label} ---\n${text}`);
      }
    } catch {
      // skip unreadable files
    }
  }

  if (contents.length === 0) return '';

  let combined = contents.join('\n\n');
  if (combined.length > MAX_INSTRUCTION_CHARS) {
    combined =
      combined.slice(0, MAX_INSTRUCTION_CHARS) +
      `\n\n[WARNING: Instructions exceeded ${MAX_INSTRUCTION_CHARS} chars and were truncated.]`;
  }
  return combined;
}

// ─── System Prompt Builder ────────────────────────────────────────────────────

export function buildSystemPrompt(agent, depth) {
  let prompt = DEFAULT_SYSTEM_PROMPT;

  // Apply overlay if present (e.g., sub-agent role instructions)
  if (agent.overlay) {
    const overlayText = Array.isArray(agent.overlay)
      ? agent.overlay.join('\n')
      : String(agent.overlay);
    prompt += `\n\n${overlayText}`;
  }

  // Working directory
  prompt += `\n\nWorking directory: ${agent.cwd}`;

  // Sub-agent specific note
  if (depth > 0) {
    prompt += `\n\nYou are a sub-agent at depth ${depth}. Work independently on your assigned task and return a concise report. Do not ask follow-up questions — complete the task yourself.`;
  }

  // Append project instructions
  const projInstr = loadProjectInstructions(agent.cwd);
  if (projInstr) {
    prompt += `\n\n--- Project Instructions ---\n${projInstr}`;
  }

  // Append skills listing (name + one-line description)
  try {
    const skills = loadSkills(agent.cwd);
    if (skills.length > 0) {
      const listing = formatSkillListing(skills);
      prompt += `\n\n--- Available Skills ---\n${listing}`;
    }
  } catch { /* skills module may not be available */ }

  // Append MCP project listing (name + one-line description, no auth)
  try {
    const projects = loadMcpProjects(agent.cwd);
    if (projects.length > 0) {
      const listing = formatMcpListing(projects);
      prompt += `\n\n--- Available MCP Projects ---\n${listing}`;
    }
  } catch { /* mcp module may not be available */ }

  return prompt;
}
