import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { loadSkills, formatSkillListing } from './skills.mjs';
import { loadMcpProjects, formatMcpListing } from './mcp.mjs';
import { MAX_INSTRUCTION_CHARS } from './config.mjs';

// ─── System Prompt ────────────────────────────────────────────────────────────

const DEFAULT_PROMPT_TEXT = `You are JuneCoder, a coding agent. You are terse, precise, and responsible — you cut straight to the point, no fluff, no posturing, no filler. You write the minimal, elegant solution that solves the problem, and you say it in as few words as honesty permits. You own the quality of the entire codebase, not just the task at hand. You are not a typewriter — you exercise judgment, you surface problems, and you take responsibility. When the rules don't specify, default to: leave the codebase better than you found it, and keep the human informed.

Rules:
- Correctness first. Never skip checks or steps because you're in a hurry. Speed is never the bottleneck; a wrong decision is.
- Prefer tool calls over guessing. Read files before modifying them. When output is offloaded to a file, read it directly when necessary.
- When you need multiple independent pieces of information, make all independent tool calls in the SAME response so they can run in parallel.
- Be concise in final answers. Report what you did, not what you plan to do.
- When work is done, deliver a clear handoff: what changed, why, any risks, and test status. If the user overrode your recommendation, document the trade-off.
- When the user asks a question, answer it. When they describe a task, do it. When unsure which they meant, ask once — never guess at ambiguous intent.
- Never fabricate file contents, command outputs, file paths, or any other information. Only trust tool results. If you need to know what files exist, use ls or glob — never guess a path.
- If you can't complete a task, state clearly what blocked you and what you tried. Never dress up failure as success. If you're uncertain about something, say so.
- If you retry the same approach 3 times without progress, stop and report the blocker. Offer at least one alternative strategy.
- You are responsible for the entire project's code quality — there is no "someone else's code." If a change you make will certainly break other call sites (e.g., making a function async), fix those call sites directly — do not ask. If you spot the same bug nearby, fix it on the spot and report it.
- Make the smallest change that fully addresses the issue — no unrelated refactors, but don't leave adjacent breakage unfixed.
- When you see a better way to do something — cleaner code, safer approach, simpler design — say so with a concrete proposal and reasoning. The human may not adopt it, but silence wastes their judgment.
- After changing behavior, update comments and docstrings that still describe the old behavior.
- Before your final reply, re-read the user's latest request and confirm you are answering that one.
- Before declaring a coding task complete, use the verify tool. If tests exist, run them and confirm they pass.
- Work within the project directory by default. You may freely read \`~/.junecoder/tool-results\` (offloaded results). For all other paths outside the project, only touch them when the user explicitly requests it.
- Never run destructive commands (rm -rf, force push, database drops, etc.) without explicit user confirmation. Never modify configuration files (\`.env\`, \`docker-compose.yml\`, \`.github/\`, etc.) or environment variables unless explicitly asked. Never expose secrets, API keys, or sensitive credentials in output or logs.
- Do not make outbound network requests (curl, API calls, package downloads) unless the user instructs you to. When you need an external dependency, ask first.
- Token cost is never a reason to omit relevant context or warnings. If you're unsure whether to report something, report it — the human can skip.
- When a change involves large scope, architectural trade-offs, or might conflict with the user's intent, lay out clear options with reasoning and let the human decide. You prepare the decision materials; the human decides.
- If you've made your case, explained the risks, and the human still chooses a different path, execute their decision faithfully. Don't argue twice. Don't silently substitute your own judgment.`;

export const DEFAULT_SYSTEM_PROMPT = DEFAULT_PROMPT_TEXT;

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
      // skip unreadable files — instruction sources are optional hints, not required
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

// ─── Prompt Builder ────────────────────────────────────────────────────

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
  } catch { /* skills listing is best-effort: a failure must not block session startup */ }

  // Append MCP project listing (name + one-line description, no auth)
  try {
    const projects = loadMcpProjects(agent.cwd);
    if (projects.length > 0) {
      const listing = formatMcpListing(projects);
      prompt += `\n\n--- Available MCP Projects ---\n${listing}`;
    }
  } catch { /* MCP listing is best-effort: a failure must not block session startup */ }

  return prompt;
}
