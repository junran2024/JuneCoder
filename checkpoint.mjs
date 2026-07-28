/**
 * Git checkpoint management — stub implementation.
 *
 * Provides save/restore of git state for before/after tool executions.
 */
import { execSync } from 'node:child_process';

/** Create a git stash-based checkpoint. Skips if working tree already has uncommitted changes (to avoid hiding user's work). */
export async function createCheckpoint(cwd) {
  try {
    // Bail if there are pre-existing uncommitted changes — we must not hide user's work
    const status = execSync('git status --porcelain', { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (status) return;
    execSync('git stash push -m "junecoder-checkpoint"', { cwd, stdio: 'ignore' });
  } catch {
    // Not a git repo or no changes to stash
  }
}

/** List available junecoder checkpoints. */
export async function listCheckpoints(cwd) {
  try {
    const out = execSync('git stash list', { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return out.split('\n').filter(Boolean).map((line, i) => ({ id: i, summary: line }));
  } catch {
    return [];
  }
}

/** Rewind to a specific checkpoint. (Not yet implemented.) */
export async function rewind(cwd, id) {
  return 'Checkpoint rewind not implemented yet.';
}

/** Check if cwd is inside a git repo. */
export function isGitRepo(cwd) {
  try {
    execSync('git rev-parse --git-dir', { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
