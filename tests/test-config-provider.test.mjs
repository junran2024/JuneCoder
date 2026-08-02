import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Control homedir via $HOME before importing the module
let tmpHome;
let mod;
let oldHome;

let oldUserProfile;

function freshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'junecoder-cfg-'));
  mkdirSync(join(dir, '.junecoder'), { recursive: true });
  return dir;
}

async function reloadMod() {
  const ts = Date.now();
  return await import(`../config-provider.mjs?reload=${ts}`);
}

describe('config-provider', () => {
  before(async () => {
    tmpHome = freshHome();
    oldHome = process.env.HOME;
    oldUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    mod = await reloadMod();
  });

  after(() => {
    process.env.HOME = oldHome;
    process.env.USERPROFILE = oldUserProfile;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  describe('getActiveProvider', () => {
    it('returns default deepseek provider when no config exists', () => {
      const p = mod.getActiveProvider();
      assert.strictEqual(p.name, 'deepseek');
      assert.strictEqual(p.type, 'deepseek');
      assert.strictEqual(p.apiKey, '');
      assert.ok(p.baseURL.includes('api.deepseek.com'));
    });

    it('reads apiKey from config.json', () => {
      writeFileSync(join(tmpHome, '.junecoder', 'config.json'), JSON.stringify({
        providers: [{ name: 'deepseek', apiKey: 'sk-test123' }],
        activeProvider: 'deepseek',
      }));
      const p = mod.getActiveProvider();
      assert.strictEqual(p.apiKey, 'sk-test123');
    });

    it('falls back to .env when config.json key is empty', () => {
      writeFileSync(join(tmpHome, '.junecoder', 'config.json'), JSON.stringify({
        providers: [{ name: 'deepseek', apiKey: '' }],
        activeProvider: 'deepseek',
      }));
      writeFileSync(join(tmpHome, '.junecoder', '.env'), 'DEEPSEEK_API_KEY=sk-from-env-file\n');
      const p = mod.getActiveProvider();
      assert.strictEqual(p.apiKey, 'sk-from-env-file');
    });

    it('auto-migrates .env key to config.json on first read', () => {
      writeFileSync(join(tmpHome, '.junecoder', 'config.json'), JSON.stringify({
        providers: [{ name: 'deepseek', apiKey: '' }],
        activeProvider: 'deepseek',
      }));
      writeFileSync(join(tmpHome, '.junecoder', '.env'), 'DEEPSEEK_API_KEY=sk-migrated\n');
      mod.getActiveProvider();
      const raw = JSON.parse(readFileSync(join(tmpHome, '.junecoder', 'config.json'), 'utf-8'));
      assert.strictEqual(raw.providers[0].apiKey, 'sk-migrated');
    });

    it('skips .env comments and empty lines', () => {
      writeFileSync(join(tmpHome, '.junecoder', 'config.json'), JSON.stringify({
        providers: [{ name: 'deepseek', apiKey: '' }],
        activeProvider: 'deepseek',
      }));
      writeFileSync(join(tmpHome, '.junecoder', '.env'),
        '# comment line\n\nDEEPSEEK_API_KEY=sk-after-comment\n# another comment\n');
      const p = mod.getActiveProvider();
      assert.strictEqual(p.apiKey, 'sk-after-comment');
    });

    it('falls back to OS env var as last resort', () => {
      try { rmSync(join(tmpHome, '.junecoder', '.env'), { force: true }); } catch {}
      writeFileSync(join(tmpHome, '.junecoder', 'config.json'), JSON.stringify({
        providers: [{ name: 'deepseek', apiKey: '' }],
        activeProvider: 'deepseek',
      }));
      process.env.DEEPSEEK_API_KEY = 'sk-from-os-env';
      try {
        const p = mod.getActiveProvider();
        assert.strictEqual(p.apiKey, 'sk-from-os-env');
      } finally {
        delete process.env.DEEPSEEK_API_KEY;
      }
    });

    it('config.json key takes priority over .env', () => {
      writeFileSync(join(tmpHome, '.junecoder', 'config.json'), JSON.stringify({
        providers: [{ name: 'deepseek', apiKey: 'sk-from-config' }],
        activeProvider: 'deepseek',
      }));
      writeFileSync(join(tmpHome, '.junecoder', '.env'), 'DEEPSEEK_API_KEY=sk-from-env\n');
      const p = mod.getActiveProvider();
      assert.strictEqual(p.apiKey, 'sk-from-config');
    });

    it('handles corrupt config.json gracefully', () => {
      writeFileSync(join(tmpHome, '.junecoder', 'config.json'), 'not valid json {{{');
      try { rmSync(join(tmpHome, '.junecoder', '.env'), { force: true }); } catch {}
      const p = mod.getActiveProvider();
      assert.strictEqual(p.name, 'deepseek');
      assert.strictEqual(p.apiKey, '');
    });

    it('respects activeProvider selection', () => {
      writeFileSync(join(tmpHome, '.junecoder', 'config.json'), JSON.stringify({
        providers: [
          { name: 'deepseek', apiKey: 'sk-ds' },
          { name: 'other', apiKey: 'sk-other' },
        ],
        activeProvider: 'other',
      }));
      const p = mod.getActiveProvider();
      assert.strictEqual(p.name, 'other');
      assert.strictEqual(p.apiKey, 'sk-other');
    });
  });

  describe('saveApiKey', () => {
    it('persists apiKey for the named provider', () => {
      writeFileSync(join(tmpHome, '.junecoder', 'config.json'), JSON.stringify({
        providers: [{ name: 'deepseek', apiKey: '' }],
        activeProvider: 'deepseek',
      }));
      mod.saveApiKey('deepseek', 'sk-saved-key');
      const raw = JSON.parse(readFileSync(join(tmpHome, '.junecoder', 'config.json'), 'utf-8'));
      assert.strictEqual(raw.providers[0].apiKey, 'sk-saved-key');
    });

    it('no-ops for unknown provider name', () => {
      writeFileSync(join(tmpHome, '.junecoder', 'config.json'), JSON.stringify({
        providers: [{ name: 'deepseek', apiKey: 'sk-before' }],
        activeProvider: 'deepseek',
      }));
      mod.saveApiKey('nonexistent', 'sk-ignored');
      const raw = JSON.parse(readFileSync(join(tmpHome, '.junecoder', 'config.json'), 'utf-8'));
      assert.strictEqual(raw.providers[0].apiKey, 'sk-before');
    });

    it('creates config.json directory if missing', () => {
      // Delete whole .junecoder dir
      rmSync(join(tmpHome, '.junecoder'), { recursive: true, force: true });
      // saveApiKey should recreate it
      mod.saveApiKey('deepseek', 'sk-new-dir');
      const raw = JSON.parse(readFileSync(join(tmpHome, '.junecoder', 'config.json'), 'utf-8'));
      assert.strictEqual(raw.providers[0].apiKey, 'sk-new-dir');
    });
  });
});
