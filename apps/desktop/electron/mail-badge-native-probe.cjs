/** Isolated macOS probe: no LegalWork runtime, network, accounts, vault or DB. */
const { app, BrowserWindow, nativeImage } = require('electron');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');


if (process.platform !== 'darwin') throw Error('This native probe verifies macOS only');
const directory = mkdtempSync(join(tmpdir(), 'legalwork-badge-probe-'));
app.setPath('userData', directory);
app.setName('LegalWork badge probe');
app.whenReady().then(async () => {
const { createAppBadge } = await import('./app-badge.mjs');
try {
  const window = new BrowserWindow({ show: false, width: 320, height: 160 });
  const badge = createAppBadge(app, nativeImage, () => [window]);
  for (const [count, expected] of [[7, '7'], [123, '123'], [0, '']]) {
    badge.set('mail', count);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(app.dock.getBadge(), expected);
  }
  badge.set('tasks', 2); badge.set('mail', 3);
  assert.equal(app.dock.getBadge(), '5');
  badge.set('mail', 0); assert.equal(app.dock.getBadge(), '2');
  badge.set('tasks', 0); assert.equal(app.dock.getBadge(), '');
  window.destroy();
  console.log(`Native Dock set/get/clear + composition passed: ${process.platform}/${process.arch}, Electron ${process.versions.electron}`);
} finally {
  rmSync(directory, { recursive: true, force: true });
  app.quit();
}

}).catch(error => { console.error(error); app.exit(1); });
