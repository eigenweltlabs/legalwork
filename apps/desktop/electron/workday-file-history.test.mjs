import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectFileHistory, importWorkdayFileHistory, normalizeHistory, validDay } from "./workday-file-history.mjs";

const date = "2026-03-29";
const observedAt = "2026-03-28T23:30:00.000Z";
const options = { zone: "Europe/Berlin" };

test("normalizes last use in the selected day across a clock change and drops malformed or duplicate observations", () => {
  assert.equal(validDay("2026-02-29"), false);
  assert.deepEqual(normalizeHistory([
    { name: "Memo.pdf", observedAt }, { name: "Memo.pdf", observedAt: "2026-03-29T00:30:00+01:00" },
    { name: "Another.docx", observedAt: "2026-03-29T22:15:00Z" }, { name: "bad.pdf", observedAt: "(null)" },
    ...["/outside.pdf", "../other.txt", "C:\\secret.pdf", "a.u202e\u202e.pdf", ".hidden.txt", "~$doc.docx", "bad.exe"].map(name => ({ name, observedAt })),
  ], date, options.zone), [{ name: "Memo.pdf", observedAt }]);
});

test("both providers bound output to ordinary documents directly inside the chosen folder", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "lw-file-history-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = path.join(root, "chosen");
  await mkdir(folder);
  await mkdir(path.join(folder, "nested"));
  for (const name of ["chosen/Memo.pdf", "elsewhere.pdf", "chosen/.private.pdf", "chosen/nested/hidden.txt", "chosen/other.exe"])
    await writeFile(path.join(root, name), "");
  await symlink(path.join(root, "elsewhere.pdf"), path.join(folder, "link.pdf"));
  const mac = await collectFileHistory(folder, date, { ...options, platform: "darwin",
    execute: async (binary, args) => {
      if (binary === "/usr/bin/osascript") {
        assert.equal(path.basename(args.at(-1)), "chosen");
        assert.match(args[3], /NSURLVolumeIsLocalKey/);
        return { stdout: "local" };
      }
      assert.equal(binary, "/usr/bin/mdls");
      assert.deepEqual(args.slice(0, 3), ["-raw", "-name", "kMDItemLastUsedDate"]);
      assert.equal(path.basename(args[3]), "Memo.pdf");
      return { stdout: "2026-03-28 23:30:00 +0000" };
    } });
  assert.deepEqual(mac.entries, [{ name: "Memo.pdf", observedAt }]);
  await assert.rejects(collectFileHistory(folder, date, { ...options, platform: "darwin",
    execute: async binary => { assert.equal(binary, "/usr/bin/osascript"); return { stdout: "remote" }; } }), /local folder/);
  const windows = await collectFileHistory(folder, date, { ...options, platform: "win32",
    execute: async (binary, args, config) => {
      assert.equal(path.win32.basename(binary), "powershell.exe");
      const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
      assert.match(script, /System.Link.DateVisited/);
      assert.match(script, /GetFolderPath\('Recent'\)/);
      assert.doesNotMatch(script, /LastWriteTime|Get-Content/);
      assert.equal(path.basename(config.env.LEGALWORK_HISTORY_DIRECTORY), "chosen");
      return { stdout: JSON.stringify({ entries: ["Memo.pdf", "link.pdf", "missing.pdf", "../elsewhere.pdf"].map(name => ({ name, observedAt })), limited: true }) };
    } });
  assert.deepEqual(windows, { platform: "win32", date, entries: mac.entries, limited: true });
});

test("host checks profile and consent before showing the native picker and again before any file use read", async () => {
  const info = { running: true, hostToken: "host", clientToken: "client", baseUrl: "http://127.0.0.1:9999" };
  let checks = 0, picks = 0, reads = 0;
  /** @type {typeof collectFileHistory} */
  const collect = async () => { reads++; return { platform: "darwin", date, limited: false, entries: [{ name: "Memo.pdf", observedAt }] }; };
  const flow = { info, date, profileId: "test", choose: async () => { picks++; return "/selected"; }, collect };
  await assert.rejects(importWorkdayFileHistory({ ...flow, request: async () => { throw Error("disabled"); } }));
  assert.equal(picks, 0);
  for (const epoch of [undefined, -1, "12"]) {
    await assert.rejects(importWorkdayFileHistory({ ...flow, request: async () => ({ epoch }) }), /settings unavailable/);
  }
  assert.equal(picks, 0);
  await assert.rejects(importWorkdayFileHistory({ ...flow, request: async () => ({ epoch: ++checks }) }));
  assert.equal(reads, 0);
  await assert.rejects(importWorkdayFileHistory({ ...flow, info: { ...info, baseUrl: "https://remote.invalid" } }));
  const done = await importWorkdayFileHistory({ ...flow, request: async (_info, url, body) => {
    assert.equal(url, "/private-timesheet/desktop-history?profileId=test");
    if (!body) return { epoch: 12 };
    assert.equal(body.epoch, 12);
    assert.deepEqual(Object.keys(body).sort(), ["date", "entries", "epoch", "limited", "platform"]);
    return { imported: 1 };
  } });
  assert.deepEqual(done, { imported: 1, matched: 1, limited: false });
  assert.equal(await importWorkdayFileHistory({ ...flow, choose: async () => null, request: async () => ({ epoch: 12 }) }), null);
  assert.equal(reads, 1);
});

test("a denied folder cannot produce a successful empty import", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), "lw-inaccessible-history-"));
  const directory = path.join(root, "denied");
  await mkdir(directory);
  t.after(async () => {
    await chmod(directory, 0o700);
    await rm(root, { recursive: true, force: true });
  });
  await chmod(directory, 0);
  /** @type {NodeJS.Platform[]} */
  const platforms = ["darwin", "win32"];
  for (const platform of platforms) {
    const info = { running: true, hostToken: "test", baseUrl: "http://localhost" };
    let writes = 0;
    const collect = (folder, day) => collectFileHistory(folder, day, {
      platform, execute: async binary => {
        assert.equal(binary, "/usr/bin/osascript"); // macOS checks the selected volume's locality first.
        return { stdout: "local" };
      },
    });
    await assert.rejects(importWorkdayFileHistory({ info, profileId: "sample", date, collect, choose: async () => directory,
      request: async (_info, _route, body) => { if (body) writes++; return { epoch: 1 }; } }), { code: "EACCES" });
    assert.equal(writes, 0);
  }
});
