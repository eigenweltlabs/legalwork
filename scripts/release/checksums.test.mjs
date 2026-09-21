import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChecksums, mergeChecksums } from "./checksums.mjs";

test("hashes release bytes and merges platform lists in filename order", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "legalwork-checksums-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mac = join(dir, "legalwork-mac-arm64-1.0.0.dmg");
  const win = join(dir, "legalwork-win-x64-1.0.0.exe");
  await writeFile(mac, "abc");
  await writeFile(win, "");
  const macList = join(dir, "mac-sums");
  const winList = join(dir, "win-sums");
  await writeFile(macList, await createChecksums([mac]));
  await writeFile(winList, await createChecksums([win]));
  assert.equal(await mergeChecksums([winList, macList]),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  legalwork-mac-arm64-1.0.0.dmg\n" +
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  legalwork-win-x64-1.0.0.exe\n");
  const original = await createChecksums([mac]);
  await writeFile(mac, "changed after signing");
  assert.notEqual(await createChecksums([mac]), original);
});

test("refuses missing, malformed and conflicting checksum artifacts", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "legalwork-checksums-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(mergeChecksums([]), /Missing platform/);
  await assert.rejects(createChecksums([]), /No Electron release assets/);
  const first = join(dir, "first");
  const second = join(dir, "second");
  await writeFile(first, "");
  await assert.rejects(mergeChecksums([first]), /Empty checksum/);
  await writeFile(first, "not a checksum\n");
  await assert.rejects(mergeChecksums([first]), /Invalid checksum/);
  await writeFile(first, `${"a".repeat(64)}  legalwork-mac-arm64-1.0.0.zip\n`);
  await writeFile(second, `${"b".repeat(64)}  legalwork-mac-arm64-1.0.0.zip\n`);
  await assert.rejects(mergeChecksums([first, second]), /Conflicting checksums/);
});
