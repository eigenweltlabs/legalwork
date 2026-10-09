import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const desktopRequire = createRequire(new URL("../../apps/desktop/package.json", import.meta.url));
const YAML = desktopRequire("yaml");
const script = fileURLToPath(new URL("./apply-signpath-windows-artifact.mjs", import.meta.url));

for (const arch of ["x64", "arm64"]) {
  test(`signed ${arch} bytes replace the installer and regenerate updater hashes and blockmap`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "legalwork-signpath-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const signedDir = join(root, "signed", "nested");
    const distDir = join(root, "dist");
    await mkdir(signedDir, { recursive: true });
    await mkdir(distDir);
    const name = `legalwork-win-${arch}-0.1.27-alpha.1.exe`;
    const unsigned = Buffer.alloc(100_000);
    for (let i = 0; i < unsigned.length; i++) unsigned[i] = i % 251;
    // The signature is verified by PowerShell in CI; this fixture checks the
    // updater's response to the changed bytes returned by the signing service.
    const signed = Buffer.concat([unsigned, Buffer.from("signature bytes appended by signing service")]);
    await writeFile(join(signedDir, name), signed);
    await writeFile(join(distDir, name), unsigned);
    await writeFile(join(distDir, `${name}.blockmap`), "stale blockmap");
    await writeFile(join(distDir, "latest.yml"), YAML.stringify({
      version: "0.1.27-alpha.1", files: [{ url: name, sha512: "stale", size: unsigned.length }],
      path: name, sha512: "stale", releaseDate: "2026-10-09T12:00:00Z",
    }));

    const result = spawnSync(process.execPath, [script, join(root, "signed"), distDir], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await readFile(join(distDir, name)), signed);
    const expectedHash = createHash("sha512").update(signed).digest("base64");
    const manifest = YAML.parse(await readFile(join(distDir, "latest.yml"), "utf8"));
    assert.deepEqual(manifest.files, [{ url: name, sha512: expectedHash, size: signed.length }]);
    assert.equal(manifest.sha512, expectedHash);
    assert.equal(manifest.path, name);
    assert.equal(manifest.version, "0.1.27-alpha.1");
    assert.equal(manifest.releaseDate, "2026-10-09T12:00:00Z");
    const blockmap = JSON.parse(gunzipSync(await readFile(join(distDir, `${name}.blockmap`))));
    const sizes = blockmap.files.flatMap((file) => file.sizes);
    assert.equal(sizes.reduce((sum, size) => sum + size, 0), signed.length);
    assert.ok(blockmap.files.every((file) => file.sizes.length === file.checksums.length));
  });
}
