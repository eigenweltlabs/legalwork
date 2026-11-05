const { createHash } = require('node:crypto');
const { closeSync, openSync, readSync, readFileSync, readdirSync, statSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { createRequire } = require('node:module');
const builderRequire = createRequire(require.resolve('electron-builder'));
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'));
const { signAsync } = appBuilderRequire('@electron/osx-sign');

// osx-sign treats every binary resource as executable, including PNGs and the
// Linux initrd. Only Mach-O files need individual signatures; other resources
// are authenticated by the enclosing app's resource seal.
function isDataFile(file) {
  if (!statSync(file).isFile()) return false;
  const fd = openSync(file, 'r');
  try {
    const magic = Buffer.alloc(4);
    if (readSync(fd, magic, 0, 4, 0) < 4) return true;
    return ![0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(magic.readUInt32BE());
  } finally { closeSync(fd); }
}

// osx-sign calls optionsForFile in signing order, with the outer app last.
// Refresh hashes after helper signing and before sealing the app resources.
module.exports = async function sign(options) {
  const app = path.resolve(options.app);
  const { opencodeEngineSelection, verifySelectedOpencodeEngine } = await import('@legalwork/opencode-release/selection');
  let immutableEngine;
  if (opencodeEngineSelection.kind === 'derivative') {
    const root = path.join(app, 'Contents', 'Resources', 'opencode-engine', opencodeEngineSelection.artifactId);
    const targets = readdirSync(root);
    if (targets.length !== 1 || !/^darwin-(arm64|x64-baseline)$/.test(targets[0])) throw new Error('The app must contain exactly its selected Mac engine target before signing.');
    immutableEngine = path.join(root, targets[0], 'opencode');
    await verifySelectedOpencodeEngine(immutableEngine, { target: targets[0] });
    const verification = spawnSync('codesign', ['--verify', '--strict', immutableEngine], { encoding: 'utf8' });
    if (verification.status !== 0) throw new Error(`The pinned engine signature is invalid: ${verification.stderr}`);
    if (options.identity !== '-') {
      const signature = spawnSync('codesign', ['--display', '--verbose=4', immutableEngine], { encoding: 'utf8' });
      if (signature.status !== 0 || !/^Authority=Developer ID Application:/m.test(signature.stderr)) throw new Error('Production engine signing must happen before its archive/host pins are generated. This local ad-hoc candidate cannot be published as a production Mac build.');
    }
  }
  const directory = path.join(app, 'Contents', 'Resources', 'agent-sandbox');
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const qemu = path.join(directory, `qemu-system-${manifest.architecture}`);
  const ignore = options.ignore ? (Array.isArray(options.ignore) ? options.ignore : [options.ignore]) : [];
  await signAsync({ ...options, app, ignore: (file) => file === immutableEngine || isDataFile(file) || ignore.some((rule) => typeof rule === 'function' ? rule(file) : file.match(rule)), binaries: [...(options.binaries ?? []), qemu], optionsForFile(file) {
    const original = options.optionsForFile?.(file) ?? {};
    if (file === app) {
      for (const name of Object.keys(manifest.files)) {
        manifest.files[name] = createHash('sha256').update(readFileSync(path.join(directory, name))).digest('hex');
      }
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    }
    return file === qemu ? { ...original, ...(options.identity === "-" ? { hardenedRuntime: false } : {}), entitlements: path.resolve(__dirname, '../../../scripts/sandbox/qemu-entitlements.plist') } : original;
  } });
  if (immutableEngine) await verifySelectedOpencodeEngine(immutableEngine, { target: path.basename(path.dirname(immutableEngine)) });
};
