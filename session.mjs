/**
 * Session persistence — save/restore/archive conversation history.
 *
 * Saves display lines (rendered conversation) plus agent history to disk,
 * allowing sessions to survive restarts.
 */
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';

/** Directory under ~/.junecoder/ for session storage. */
function sessionsDir(cwd) {
  const dir = join(homedir(), '.junecoder', 'sessions');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// Matches ANSI escape sequences (colors, cursor moves, etc.).
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-B]|\x1b[=>#][0-9]?/g;

/** Strip ANSI escape sequences from a string. */
function stripAnsi(s) {
  return String(s).replace(ANSI_RE, "");
}

/**
 * Normalize display lines to the canonical persisted shape { text, role }.
 * role is a semantic name (user, assistant, dim, error, …) resolved to an
 * ANSI color by the TUI's code-side table at render time — raw color codes
 * are terminal-only noise and must never land in the session file.
 *
 * Accepts strings and legacy { text, color } objects; lines without a role
 * fall back to "text". Any ANSI escapes inside text are stripped.
 */
export function normalizeLines(lines) {
  if (!Array.isArray(lines)) return [];
  const out = [];
  for (const l of lines) {
    if (typeof l === "string") out.push({ text: stripAnsi(l), role: "text" });
    else if (l && typeof l.text === "string") {
      out.push({ text: stripAnsi(l.text), role: typeof l.role === "string" ? l.role : "text" });
    }
  }
  return out;
}

/** Encode a path for use as a filename (replace / with _). */
function pathSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+/, '') || 'default';
}

/** Path to the session file for a given project directory. */
export function sessionPath(cwd) {
  return join(sessionsDir(), pathSlug(cwd) + '.json');
}

/** Save current agent history and display lines. */
export function saveSession(agent, displayLines) {
  try {
    const data = {
      cwd: agent.cwd,
      history: agent.history,
      displayLines: normalizeLines(displayLines),
      planMode: agent.planMode,
      goal: agent.goal,
      tasks: agent.tasks,
      savedAt: Date.now(),
    };
    writeFileSync(sessionPath(agent.cwd), JSON.stringify(data, null, 2), 'utf-8');
  } catch {
    // Non-fatal: a session save failure must not crash the agent —
    // the conversation lives in memory and is saved again on exit
  }
}

/** Load the last session for a project directory. Returns null if none found. */
export function loadSession(cwd) {
  const path = sessionPath(cwd);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.displayLines)) data.displayLines = normalizeLines(data.displayLines);
    return data;
  } catch {
    return null;
  }
}

/** Clear session data for a project directory. */
export function clearSession(cwd) {
  try {
    const path = sessionPath(cwd);
    if (existsSync(path)) unlinkSync(path);
  } catch { /* best-effort: file may already be gone */ }
}

/** Archive the current session with timestamp. */
export function archiveCurrent(cwd) {
  try {
    const src = sessionPath(cwd);
    if (!existsSync(src)) return;
    const ts = Date.now();
    const dst = join(sessionsDir(), pathSlug(cwd) + '_' + ts + '.json');
    renameSync(src, dst);
  } catch { /* best-effort: archiving failure is non-critical, session stays on disk */ }
}

/** List available session slots for a given project directory. */
export function listSlots(cwd) {
  try {
    const dir = sessionsDir();
    const prefix = pathSlug(cwd);
    const files = readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
    return files.map(f => {
      const match = f.match(/_(\d+)\.json$/);
      return {
        file: f,
        timestamp: match ? parseInt(match[1]) : 0,
        label: match ? new Date(parseInt(match[1])).toLocaleString() : f,
      };
    }).sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

/** Switch to a different session slot. Returns the restored data or null. */
export function switchToSlot(cwd, slot) {
  try {
    const dir = sessionsDir();
    const src = join(dir, slot);
    if (!existsSync(src)) return null;
    const raw = readFileSync(src, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.displayLines)) data.displayLines = normalizeLines(data.displayLines);
    // Save current session first
    const curPath = sessionPath(cwd);
    if (existsSync(curPath)) {
      archiveCurrent(cwd);
    }
    // Copy slot to current session path (already sanitized, no color codes)
    writeFileSync(curPath, JSON.stringify(data, null, 2), 'utf-8');
    return data;
  } catch {
    return null;
  }
}
