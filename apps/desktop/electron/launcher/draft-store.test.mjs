import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLauncherDraftStore } from "./draft-store.mjs";

test("7 MiB attachment survives restart; another profile with the same day stays isolated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legalwork-draft-"));
  const profileA = "a".repeat(64), profileB = "b".repeat(64);
  const day = "day:2026-11-20";
  const url = "data:application/pdf;base64," + Buffer.alloc(7 * 1024 * 1024, 65).toString("base64");
  const input = {
    parts: [{ type: "file", mime: "application/pdf", url }],
    queue: { draft: { attachments: [{ id: "same-file", data: url }] } },
  };
  const file = { version: 1, drafts: { [day]: { text: "A", submission: { input } } }, leases: { [day]: { owner: "launcher-a" } } };
  try {
    const store = createLauncherDraftStore(() => root);
    assert.equal(await store.write(file, 0, profileA), true);
    const target = path.join(root, `launcher-drafts-${profileA}.json`);
    assert.ok((await readFile(target, "utf8")).length < 500);
    assert.equal((await readdir(`${target}.attachments`)).length, 1);

    const reopened = createLauncherDraftStore(() => root);
    assert.deepEqual(await reopened.read(profileA), file);
    assert.deepEqual(await reopened.read(profileB), { version: 0, drafts: {}, leases: {} });
    assert.equal(await reopened.write({ version: 1, drafts: { [day]: { text: "B" } }, leases: {} }, 0, profileB), true);
    assert.equal((await reopened.read(profileB)).drafts[day].text, "B");
    assert.equal((await reopened.read(profileA)).drafts[day].text, "A");

    await assert.rejects(reopened.write({ ...file, version: 2, drafts: { [day]: { text: "a".repeat(8 * 1024 * 1024) } } }, 1, profileA), /storage is full/i);
    assert.equal(await reopened.write(file, 0, profileA), false);
    assert.equal(await reopened.write({ ...file, version: 2, drafts: { [day]: { text: "", submission: { state: "accepted" } } } }, 1, profileA), true);
    assert.deepEqual(await readdir(`${target}.attachments`), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
