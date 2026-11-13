import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { clearDesktopProfile } from "./reset-profile.mjs";

test("clearing a profile preserves default and custom project data while removing settings", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-profile-reset-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["Projects/ws_one/.legalwork", "custom-projects/ws_two/.opencode", "connected/documents", "Cache"]) await mkdir(path.join(root, name), { recursive: true });
  const files = ["Projects/ws_one/.legalwork/attachment.txt", "custom-projects/ws_two/.opencode/review.json", "connected/documents/contract.txt"];
  for (const file of [...files, "Cache/temporary", "Preferences"]) await writeFile(path.join(root, file), file);
  await clearDesktopProfile(root, [path.join(root, "custom-projects/ws_two"), path.join(root, "connected/documents")]);
  assert.deepEqual((await readdir(root)).sort(), ["Projects", "connected", "custom-projects"]);
  for (const file of files) assert.equal(await readFile(path.join(root, file), "utf8"), file);
});
