/**
 * Skills module — loads and formats project skills from .junecoder/skills/.
 *
 * Skill files are markdown (.md) with optional YAML-like frontmatter.
 * Frontmatter keys: name (string), description (string).
 * Without frontmatter, name derives from filename and description from first line.
 */
import { join, basename, extname } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

/**
 * Load skills from cwd/.junecoder/skills/.
 * @param {string} cwd
 * @returns {{ name: string, description: string, path: string }[]}
 */
export function loadSkills(cwd) {
  const skillsDir = join(cwd, '.junecoder', 'skills');
  if (!existsSync(skillsDir)) return [];

  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const ext = extname(ent.name).toLowerCase();
    if (ext !== '.md') continue;

    const filePath = join(skillsDir, ent.name);
    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const { name, description } = parseFrontmatter(content, ent.name);
    skills.push({ name, description, path: filePath });
  }
  return skills;
}

/**
 * Format a skill listing for inclusion in the system prompt.
 * @param {object[]} skills
 * @returns {string}
 */
export function formatSkillListing(skills) {
  if (!skills || skills.length === 0) return 'No skills loaded.';
  return skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
}

/**
 * Read a specific skill file by name.
 * @param {string} cwd
 * @param {string} name
 * @returns {string|null} skill content or null if not found
 */
export function readSkill(cwd, name) {
  const skillsDir = join(cwd, '.junecoder', 'skills');
  if (!existsSync(skillsDir)) return null;

  // Try exact name match (with/without .md extension)
  const candidates = [
    join(skillsDir, name),
    join(skillsDir, name + '.md'),
  ];

  for (const cand of candidates) {
    if (existsSync(cand)) {
      try {
        return readFileSync(cand, 'utf-8');
      } catch {
        return null;
      }
    }
  }

  // Fallback: scan directory for a match by frontmatter name
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const ent of entries) {
    if (!ent.isFile() || extname(ent.name).toLowerCase() !== '.md') continue;
    const filePath = join(skillsDir, ent.name);
    try {
      const content = readFileSync(filePath, 'utf-8');
      const fm = parseFrontmatter(content, ent.name);
      if (fm.name === name) return content;
    } catch {
      continue;
    }
  }

  return null;
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Parse optional YAML-like frontmatter from markdown content.
 * Frontmatter is delimited by --- lines at the top of the file.
 * Returns { name, description } — falls back to filename/first-line if absent.
 */
function parseFrontmatter(content, filename) {
  const noExt = basename(filename, extname(filename));
  let name = noExt;
  let description = '';

  // Try to parse frontmatter
  const lines = content.split('\n');
  if (lines[0]?.trim() === '---') {
    const endIdx = lines.indexOf('---', 1);
    if (endIdx > 0) {
      const fmLines = lines.slice(1, endIdx);
      for (const line of fmLines) {
        const colonIdx = line.indexOf(':');
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          const value = line.slice(colonIdx + 1).trim();
          if (key === 'name') name = value;
          else if (key === 'description') description = value;
        }
      }
    }
  }

  // Fallback: use first non-empty non-heading line as description
  if (!description) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('---') || trimmed.startsWith('#')) continue;
      description = trimmed.slice(0, 100);
      break;
    }
  }

  return { name, description };
}
