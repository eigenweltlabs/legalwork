import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { browserDownloadReadPython } from "./browser-download-collection.mjs";

// Real local filesystem/UID fixtures. The SSH adapter uses this identical reader
// under runuser on Linux; these tests introduce no subprocess output ceiling.
async function readActual(request) {
  const child = spawn("python3", ["-c", browserDownloadReadPython, JSON.stringify(request)], { stdio: ["ignore", "pipe", "pipe"] });
  const output = [], errors = [];
  child.stdout.on("data", bytes => output.push(bytes)); child.stderr.on("data", bytes => errors.push(bytes));
  const code = await new Promise((accept, reject) => { child.once("error", reject); child.once("close", accept); });
  if (code !== 0) throw new Error(Buffer.concat(errors).toString("utf8"));
  return JSON.parse(Buffer.concat(output).toString("utf8"));
}

async function fixture(run) {
  const temporary = await mkdtemp(join(tmpdir(), "lw-download-reader-"));
  const root = await realpath(temporary), workspaceDownloads = join(root, "project", "Downloads"), nativeTempRoot = join(root, "tmp");
  await mkdir(workspaceDownloads, { recursive: true, mode: 0o700 }); await mkdir(nativeTempRoot, { mode: 0o700 });
  try { await run({ root, uid: process.getuid(), workspaceDownloads, nativeTempRoot }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("actual app-owned project download is collected in full beyond one MiB, including its tail", async () => fixture(async settings => {
  const path = join(settings.workspaceDownloads, "source.pdf"), bytes = Buffer.concat([Buffer.alloc(1024 * 1024, 0x5a), Buffer.from("COMPLETE-FILE-TAIL")]);
  await writeFile(path, bytes);
  const result = await readActual({ ...settings, path });
  assert.deepEqual(Buffer.from(result.contentBase64, "base64"), bytes);
  assert.equal(result.acquisition.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(result.acquisition.scope, "workspace-downloads");
  assert.equal(result.acquisition.noSymlinks, true);
  assert.equal(result.acquisition.uid, process.getuid());
}));

test("native export is collected from the real scoped temporary file, rather than a task copy", async () => fixture(async settings => {
  const directory = join(settings.nativeTempRoot, "opencode-browser-owned", "0"); await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "download.pdf"); await writeFile(path, "actual downloaded bytes");
  const result = await readActual({ ...settings, path });
  assert.equal(result.acquisition.scope, "native-browser-temp");
  assert.equal(Buffer.from(result.contentBase64, "base64").toString(), "actual downloaded bytes");
  assert.equal(result.sourcePath, path);
}));

test("collector rejects outside paths, symlinks, hardlinks, fake native directories and wrong UID", async () => fixture(async settings => {
  const outside = join(settings.root, "not-a-download"); await writeFile(outside, "must not collect");
  await assert.rejects(readActual({ ...settings, path: outside }), /outside approved/);
  const symlinkPath = join(settings.workspaceDownloads, "link.pdf"); await symlink(outside, symlinkPath);
  await assert.rejects(readActual({ ...settings, path: symlinkPath }), /ordinary app-owned regular/);
  const hardlinkPath = join(settings.workspaceDownloads, "hardlink.pdf"); await link(outside, hardlinkPath);
  await assert.rejects(readActual({ ...settings, path: hardlinkPath }), /ordinary app-owned regular/);
  const badDirectory = join(settings.nativeTempRoot, "unrelated", "0"); await mkdir(badDirectory, { recursive: true });
  const badPath = join(badDirectory, "source.pdf"); await writeFile(badPath, "wrong scope");
  await assert.rejects(readActual({ ...settings, path: badPath }), /outside approved/);
  await assert.rejects(readActual({ ...settings, uid: settings.uid + 1, path: outside }), /approved ordinary app UID/);
  const linkedDirectory = join(settings.workspaceDownloads, "alias"); await symlink(settings.root, linkedDirectory);
  await assert.rejects(readActual({ ...settings, path: join(linkedDirectory, "not-a-download") }));
  assert.equal(await readFile(outside, "utf8"), "must not collect");
}));
