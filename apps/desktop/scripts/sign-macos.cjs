const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const builderRequire = createRequire(require.resolve('electron-builder'));
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const { signAsync } = appBuilderRequire('@electron/osx-sign');

// osx-sign calls optionsForFile in signing order, with the outer app last.
// Refresh hashes after helper signing and before sealing the app resources.
module.exports = async function sign(options) {
  const directory = path.join(options.app, 'Contents', 'Resources', 'agent-sandbox');
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const qemu = path.join(directory, `qemu-system-${manifest.architecture}`);
  await signAsync({ ...options, binaries: [...(options.binaries ?? []), qemu], optionsForFile(file) {
    const original = options.optionsForFile?.(file) ?? {};
    if (file === options.app) {
      for (const name of Object.keys(manifest.files)) {
        manifest.files[name] = createHash('sha256').update(readFileSync(path.join(directory, name))).digest('hex');
      }
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    }
    return file === qemu ? { ...original, ...(options.identity === "-" ? { hardenedRuntime: false } : {}), entitlements: path.resolve(__dirname, '../../../scripts/sandbox/qemu-entitlements.plist') } : original;
  } });
};
