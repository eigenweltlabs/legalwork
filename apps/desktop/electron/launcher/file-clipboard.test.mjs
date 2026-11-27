import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { copyFilesToClipboard } from "./file-clipboard.mjs";

async function fixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-clipboard-"));
  try {
    const file = path.join(root, "Übersicht ' $(do-not-run).txt");
    const folder = path.join(root, "Folder");
    await writeFile(file, "Contents"); await mkdir(folder);
    await fn({ file, folder, missing: path.join(root, "missing") });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("macOS copies multiple file URLs as data, including folders and special filenames", () => fixture(async ({ file, folder }) => {
  const calls = [];
  await copyFilesToClipboard([file, folder, file], { writeBuffer: () => assert.fail("unexpected fallback") }, {
    platform: "darwin", run: async (...args) => { calls.push(args); },
  });
  assert.equal(calls[0][0], "/usr/bin/osascript");
  assert.deepEqual(calls[0][1].slice(-2), [file, folder]);
  assert.ok(!calls[0][1][3].includes(file));
}));

test("missing files and invalid selections preserve the clipboard; native failures reject", () => fixture(async ({ file, missing }) => {
  const never = () => assert.fail("clipboard must remain unchanged");
  for (const paths of [[], ["relative.txt"], [file, missing], Array(101).fill(file)]) {
    await assert.rejects(copyFilesToClipboard(paths, { writeBuffer: never }, { run: never }));
  }
  await assert.rejects(copyFilesToClipboard([file], { writeBuffer: never }, { platform: "darwin", run: async () => { throw new Error("denied"); } }), /denied/);
}));

test("Windows uses a native file drop list and keeps filenames out of executable code", () => fixture(async ({ file, folder }) => {
  await copyFilesToClipboard([file, folder], { writeBuffer: () => assert.fail() }, {
    platform: "win32", run: async (command, args) => {
      assert.equal(command, "powershell.exe");
      assert.ok(args.includes("-STA"));
      const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
      assert.match(script, /SetFileDropList/);
      assert.ok(!script.includes(file));
      const payload = script.match(/FromBase64String\('([^']+)'\)/)[1];
      assert.deepEqual(JSON.parse(Buffer.from(payload, "base64").toString("utf8")), [file, folder]);
    },
  });
}));

test("Linux writes encoded file URLs, not raw path text", () => fixture(async ({ file, folder }) => {
  const writes = [];
  await copyFilesToClipboard([file, folder], { writeBuffer: (...args) => writes.push(args) }, { platform: "linux" });
  assert.equal(writes[0][0], "text/uri-list");
  assert.equal(writes[0][1].toString(), `${pathToFileURL(file).href}\r\n${pathToFileURL(folder).href}\r\n`);
}));
