import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createChecksums } from "./checksums.mjs";

test("publishes one checksum list for all platforms and rejects incomplete artifacts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "legalwork-release-publish-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dist = join(dir, "dist");
  const log = join(dir, "uploads.jsonl");
  // Exercise the real publishing script with a local gh stub; never contact GitHub.
  await writeFile(join(dir, "gh"), `#!/usr/bin/env node
require('node:fs').appendFileSync(process.env.UPLOAD_LOG, JSON.stringify(process.argv.slice(2))+'\\n');
`, { mode: 0o755 });
  const assetFiles = [];
  for (const arch of ["arm64", "x64"]) {
    const platform = join(dist, arch);
    await mkdir(platform, { recursive: true });
    const name = `legalwork-mac-${arch}-1.0.0.zip`;
    const file = join(platform, name);
    assetFiles.push(file);
    await writeFile(file, `final ${arch} bytes`);
    await writeFile(join(platform, "SHA256SUMS"), await createChecksums([file]));
    await writeFile(join(platform, "latest-mac.yml"), `version: 1.0.0\nfiles:\n  - url: ${name}\n    sha512: fixture\n`);
  }
  const script = fileURLToPath(new URL("./publish-electron-assets.mjs", import.meta.url));
  const run = () => spawnSync(process.execPath, [script, "--manifests-only", dist, "v1.0.0"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, RUNNER_TEMP: dir,
      GITHUB_REPOSITORY: "fixture/legalwork", UPLOAD_LOG: log },
  });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  const checksumFile = join(dir, "legalwork-electron-manifests", "SHA256SUMS");
  assert.equal(await readFile(checksumFile, "utf8"), await createChecksums(assetFiles));
  const uploads = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(uploads.length, 2);
  assert.deepEqual(uploads[1], ["release", "upload", "v1.0.0", checksumFile, "--repo", "fixture/legalwork", "--clobber"]);

  // A present, valid list can still be stale or omit its installer.
  await writeFile(join(dist, "x64", "SHA256SUMS"), await createChecksums([assetFiles[0]]));
  const stale = run();
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /Missing SHA256SUMS entry for legalwork-mac-x64/);
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2);

  await rm(join(dist, "x64", "SHA256SUMS"));
  const incomplete = run();
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /Missing SHA256SUMS alongside/);
  assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2);
});
