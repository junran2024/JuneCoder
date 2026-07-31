import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadSkills, formatSkillListing, readSkill } from '../skills.mjs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create an isolated tmpdir, set HOME to it, run fn, clean up. */
function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'junecoder-skill-'));
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  try {
    return fn(dir);
  } finally {
    process.env.HOME = oldHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Ensure .junecoder/skills/ exists inside dir and write a file. */
function writeSkill(dir, filename, content) {
  const skillsDir = join(dir, '.junecoder', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(skillsDir, filename), content);
}

/** Create a subdirectory skill: skills/<name>/SKILL.md */
function writeSubSkill(dir, name, content) {
  const skillDir = join(dir, '.junecoder', 'skills', name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), content);
}

// ─── loadSkills ──────────────────────────────────────────────────────────────

describe('loadSkills', () => {
  it('returns empty array when no .junecoder/skills dir', () => {
    withTmpDir((dir) => {
      const skills = loadSkills(dir);
      assert.deepStrictEqual(skills, []);
    });
  });

  it('loads markdown skills from .junecoder/skills/', () => {
    withTmpDir((dir) => {
      writeSkill(dir, 'testing.md', '# Testing Guide\n\nHow to test.');
      writeSkill(dir, 'deploy.md', '# Deployment\n\nHow to deploy.');

      const skills = loadSkills(dir);
      assert.strictEqual(skills.length, 2);
      assert.ok(skills.some((s) => s.name === 'testing'));
      assert.ok(skills.some((s) => s.name === 'deploy'));
    });
  });

  it('loads subdirectory skills (SKILL.md)', () => {
    withTmpDir((dir) => {
      writeSubSkill(dir, 'my-tool', [
        '---',
        'name: my-tool',
        'description: A subdirectory skill',
        '---',
        '',
        '# My Tool',
      ].join('\n'));

      const skills = loadSkills(dir);
      assert.strictEqual(skills.length, 1);
      assert.strictEqual(skills[0].name, 'my-tool');
      assert.strictEqual(skills[0].description, 'A subdirectory skill');
      assert.ok(skills[0].path.endsWith('SKILL.md'));
    });
  });

  it('flat .md takes precedence over subdirectory with same name', () => {
    withTmpDir((dir) => {
      writeSkill(dir, 'tool.md', '# Flat tool');
      writeSubSkill(dir, 'tool', '# Sub tool');

      const skills = loadSkills(dir);
      // Both are found, but flat comes first (iteration order); seen set dedup by name
      assert.strictEqual(skills.length, 1);
      assert.strictEqual(skills[0].name, 'tool');
    });
  });

  it('parses frontmatter name and description', () => {
    withTmpDir((dir) => {
      writeSkill(dir, 'ci.md', [
        '---',
        'name: continuous-integration',
        'description: CI/CD workflow guide',
        '---',
        '',
        '# CI Pipeline',
      ].join('\n'));

      const skills = loadSkills(dir);
      assert.strictEqual(skills.length, 1);
      assert.strictEqual(skills[0].name, 'continuous-integration');
      assert.strictEqual(skills[0].description, 'CI/CD workflow guide');
    });
  });

  it('falls back to filename when no frontmatter name', () => {
    withTmpDir((dir) => {
      writeSkill(dir, 'my-skill.md', '# Title\n\nSome content.');

      const skills = loadSkills(dir);
      assert.strictEqual(skills[0].name, 'my-skill');
    });
  });

  it('uses first non-heading line as description fallback', () => {
    withTmpDir((dir) => {
      writeSkill(dir, 'fallback.md', [
        '# Heading',
        '',
        'This is the fallback description.',
        '',
        'More content.',
      ].join('\n'));

      const skills = loadSkills(dir);
      assert.strictEqual(skills[0].description, 'This is the fallback description.');
    });
  });

  it('skips non-.md files', () => {
    withTmpDir((dir) => {
      writeSkill(dir, 'notes.txt', 'plain text');
      writeSkill(dir, 'guide.md', '# Guide');

      const skills = loadSkills(dir);
      assert.strictEqual(skills.length, 1);
      assert.strictEqual(skills[0].name, 'guide');
    });
  });

  it('skips subdirectories without SKILL.md', () => {
    withTmpDir((dir) => {
      const skillsDir = join(dir, '.junecoder', 'skills');
      mkdirSync(skillsDir, { recursive: true });
      mkdirSync(join(skillsDir, 'empty-dir'));
      writeSkill(dir, 'real.md', '# Real');

      const skills = loadSkills(dir);
      assert.strictEqual(skills.length, 1);
      assert.strictEqual(skills[0].name, 'real');
    });
  });
});

// ─── formatSkillListing ──────────────────────────────────────────────────────

describe('formatSkillListing', () => {
  it('returns placeholder for empty/null', () => {
    assert.strictEqual(formatSkillListing([]), 'No skills loaded.');
    assert.strictEqual(formatSkillListing(null), 'No skills loaded.');
  });

  it('formats skills for prompt', () => {
    const skills = [
      { name: 'test', description: 'Test things' },
      { name: 'lint', description: 'Lint code' },
    ];
    const out = formatSkillListing(skills);
    assert.ok(out.includes('- test: Test things'));
    assert.ok(out.includes('- lint: Lint code'));
  });
});

// ─── readSkill ───────────────────────────────────────────────────────────────

describe('readSkill', () => {
  it('returns null when no skills dir', () => {
    withTmpDir((dir) => {
      const result = readSkill(dir, 'test');
      assert.strictEqual(result, null);
    });
  });

  it('reads a skill by filename (with .md)', () => {
    withTmpDir((dir) => {
      writeSkill(dir, 'guide.md', '# My Guide\n\nStep 1.');

      const result = readSkill(dir, 'guide.md');
      assert.ok(result.includes('# My Guide'));
    });
  });

  it('reads a skill by name (without .md)', () => {
    withTmpDir((dir) => {
      writeSkill(dir, 'guide.md', '# My Guide');

      const result = readSkill(dir, 'guide');
      assert.ok(result.includes('# My Guide'));
    });
  });

  it('reads a subdirectory skill by name', () => {
    withTmpDir((dir) => {
      writeSubSkill(dir, 'my-tool', '# Subdirectory Skill\n\nContent here.');

      const result = readSkill(dir, 'my-tool');
      assert.ok(result.includes('# Subdirectory Skill'));
    });
  });

  it('finds by frontmatter name (flat)', () => {
    withTmpDir((dir) => {
      writeSkill(dir, 'abc.md', [
        '---',
        'name: custom-name',
        'description: desc',
        '---',
        '',
        '# Content',
      ].join('\n'));

      const result = readSkill(dir, 'custom-name');
      assert.ok(result.includes('# Content'));
    });
  });

  it('finds by frontmatter name (subdirectory)', () => {
    withTmpDir((dir) => {
      writeSubSkill(dir, 'hidden', [
        '---',
        'name: visible-name',
        'description: found via frontmatter',
        '---',
        '',
        '# Visible',
      ].join('\n'));

      const result = readSkill(dir, 'visible-name');
      assert.ok(result.includes('# Visible'));
    });
  });

  it('returns null for non-existent skill', () => {
    withTmpDir((dir) => {
      mkdirSync(join(dir, '.junecoder', 'skills'), { recursive: true });

      const result = readSkill(dir, 'nope');
      assert.strictEqual(result, null);
    });
  });
});
