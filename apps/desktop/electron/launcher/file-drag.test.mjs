import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { LauncherFileDrag } from "./file-drag.mjs";

const icon = { isEmpty: () => false };

async function fixture(t) {
  const temporary = await mkdtemp(path.join(tmpdir(), "launcher-file-drag-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = await realpath(temporary);
  const file = path.join(root, "Agreement.md");
  const folder = path.join(root, "Contracts");
  await writeFile(file, "Keep the original document.");
  await mkdir(folder);
  return { root, file, folder };
}

test("native drag exports selected files and folders together, deduplicated, once", async t => {
  const { root, file, folder } = await fixture(t);
  const drag = new LauncherFileDrag({ icon: async () => icon });
  const entries = await drag.prepare(7, [{ root, path: file }, { root, path: folder }]);
  const calls = [];
  const sender = { id: 7, startDrag: item => calls.push(item) };
  drag.start(sender, [...entries.map(item => item.token), entries[0].token]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].files, [file, folder]);
  assert.equal(calls[0].icon, icon);
  assert.throws(() => drag.start(sender, entries.map(item => item.token)), /selection has changed/);
});

test("tokens survive another result preparation, but reject another renderer and expiration", async t => {
  const { root, file, folder } = await fixture(t);
  let now = 100;
  const drag = new LauncherFileDrag({ icon: async () => icon, now: () => now });
  const [first] = await drag.prepare(7, [{ root, path: file }]);
  const [second] = await drag.prepare(7, [{ root, path: folder }]);
  const calls = [];
  assert.throws(() => drag.start({ id: 8, startDrag: item => calls.push(item) }, [first.token]), /selection has changed/);
  drag.start({ id: 7, startDrag: item => calls.push(item) }, [first.token]);
  assert.deepEqual(calls[0].files, [file]);
  now += 60_000;
  assert.throws(() => drag.start({ id: 7, startDrag: item => calls.push(item) }, [second.token]), /selection has changed/);
  assert.equal(calls.length, 1);
});

test("missing paths and unavailable icons do not disable unrelated files", async t => {
  const { root, file, folder } = await fixture(t);
  const drag = new LauncherFileDrag({ icon: async value => ({ isEmpty: () => value === folder }) });
  const entries = await drag.prepare(7, [{ root, path: file }, { root, path: folder }, { root, path: path.join(root, "deleted.md") }]);
  assert.deepEqual(entries.map(item => item.path), [file]);
  await assert.rejects(drag.prepare(7, [{ root, path: "relative.md" }]), /local files/);
  await assert.rejects(drag.prepare(7, Array.from({ length: 101 }, () => ({ root, path: file }))), /100/);
});

test("a deleted selected file aborts the whole drag without consuming other tokens", async t => {
  const { root, file, folder } = await fixture(t);
  const drag = new LauncherFileDrag({ icon: async () => icon });
  const entries = await drag.prepare(7, [{ root, path: file }, { root, path: folder }]);
  const calls = [];
  const sender = { id: 7, startDrag: item => calls.push(item) };
  await rm(file);
  assert.throws(() => drag.start(sender, entries.map(item => item.token)));
  assert.equal(calls.length, 0);
  drag.start(sender, [entries[1].token]);
  assert.deepEqual(calls[0].files, [folder]);
});

test("drag rejects links outside the source root and paths swapped after preparation", async t => {
  const { root, file, folder } = await fixture(t);
  const outsideLink = path.join(folder, "outside.md");
  await symlink(file, outsideLink);
  const drag = new LauncherFileDrag({ icon: async () => icon });
  assert.deepEqual(await drag.prepare(7, [{ root: folder, path: outsideLink }]), []);
  const [entry] = await drag.prepare(7, [{ root, path: file }]);
  const replacement = path.join(root, "replacement.md");
  await writeFile(replacement, "different document");
  await rm(file);
  await symlink(replacement, file);
  assert.throws(() => drag.start({ id: 7, startDrag: () => assert.fail("must not start") }, [entry.token]), /location has changed/);
});
