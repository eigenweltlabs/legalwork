const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const defaults = require("../build/windows-vc-runtime.json");

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function targetFor(arch, pin) {
  const target = pin.targets[arch];
  if (!target) throw new Error(`Unsupported Windows VC++ runtime architecture: ${arch}`);
  return target;
}

/** Check the exact target's DLLs, including cached builds and the packaged addon directory. */
function assertWindowsVcRuntime(directory, arch, pin = defaults) {
  for (const [name, expected] of Object.entries(targetFor(arch, pin).files)) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== expected) {
      throw new Error(`Missing or invalid Windows ${arch} VC++ runtime: ${name}`);
    }
  }
}

/** Only retail CRT members enter the app; never extract debug DLLs or arbitrary ZIP paths. */
function extractWindowsVcRuntime(bytes, arch, pin = defaults) {
  const { unzipSync } = require("fflate");
  const target = targetFor(arch, pin);
  if (sha256(bytes) !== target.sha256) throw new Error(`Windows ${arch} VC++ archive checksum mismatch`);
  const prefix = `Contents/VC/Redist/MSVC/${pin.directoryVersion}/${arch}/Microsoft.VC143.CRT/`;
  const members = new Set(Object.keys(target.files).map(name => prefix + name));
  const archive = unzipSync(bytes, { filter: entry => members.has(entry.name) });
  return Object.fromEntries(Object.entries(target.files).map(([name, expected]) => {
    const file = archive[prefix + name];
    if (!file || sha256(file) !== expected) throw new Error(`Missing or invalid VC++ archive member: ${name}`);
    return [name, file];
  }));
}

async function prepareWindowsVcRuntime(directory, arch, pin = defaults) {
  const target = targetFor(arch, pin);
  try {
    assertWindowsVcRuntime(directory, arch, pin);
    return;
  } catch { /* A missing, changed, or wrong-architecture cache must be replaced. */ }
  const response = await fetch(target.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Windows VC++ runtime download failed: HTTP ${response.status}`);
  const files = extractWindowsVcRuntime(Buffer.from(await response.arrayBuffer()), arch, pin);
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), bytes);
  assertWindowsVcRuntime(directory, arch, pin);
  console.log(`[vc-runtime] verified and prepared ${pin.packageVersion} for Windows ${arch}`);
}

module.exports = { assertWindowsVcRuntime, extractWindowsVcRuntime, prepareWindowsVcRuntime };
