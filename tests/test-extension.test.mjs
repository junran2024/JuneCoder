import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('VS Code Extension manifest check', () => {
  const pkgPath = resolve('package.json');
  assert.ok(existsSync(pkgPath), 'package.json must exist');

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
  assert.equal(pkg.main, 'extension.js', 'package.json main must point to extension.js');
  assert.ok(pkg.engines.vscode, 'package.json engines must declare vscode version');
  assert.ok(pkg.contributes.viewsContainers.activitybar, 'Activity bar container must be contributed');
  assert.ok(pkg.contributes.views['junecoder-sidebar'], 'Sidebar view must be contributed');
  assert.equal(pkg.contributes.commands.length, 3, 'Three VS Code commands must be registered');
});

test('Webview UI HTML file existence & structure', () => {
  const uiPath = resolve('webview/ui.html');
  assert.ok(existsSync(uiPath), 'webview/ui.html must exist');

  const html = readFileSync(uiPath, 'utf-8');
  assert.ok(html.includes('JuneCoder'), 'ui.html must contain JuneCoder branding');
  assert.ok(html.includes('id="chat-container"'), 'ui.html must contain chat-container element');
  assert.ok(html.includes('id="prompt-input"'), 'ui.html must contain prompt-input textarea');
  assert.ok(html.includes('acquireVsCodeApi()'), 'ui.html must initialize VS Code webview API');
  assert.ok(html.includes('permissionRequest'), 'ui.html must support permissionRequest IPC messages');
});

test('Extension host module loading', async () => {
  const extensionModule = await import('../extension.js');
  assert.equal(typeof extensionModule.activate, 'function', 'activate function must be exported');
  assert.equal(typeof extensionModule.deactivate, 'function', 'deactivate function must be exported');
  assert.ok(extensionModule.JuneCoderViewProvider, 'JuneCoderViewProvider class must be exported');
});
