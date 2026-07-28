import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadSkills, formatSkillListing, readSkill } from '../skills.mjs';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Create an isolated tmpdir, run fn, clean up. */
function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'junecoder-skill-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Ensure .junecoder/skills/ exists inside dir and write a file. */
function writeSkill(dir, filename, content) {
  const skillsDir = join(dir, '.junecoder', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(skillsDir, filename), content);
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

  it('finds by frontmatter name', () => {
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

  it('returns null for non-existent skill', () => {
    withTmpDir((dir) => {
      mkdirSync(join(dir, '.junecoder', 'skills'), { recursive: true });

      const result = readSkill(dir, 'nope');
      assert.strictEqual(result, null);
    });
  });
});
