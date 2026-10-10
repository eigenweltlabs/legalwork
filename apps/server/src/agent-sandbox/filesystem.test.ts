import { afterEach, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, open, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { SandboxFilesystem } from "./filesystem.js";

const roots: string[] = [];
const filesystems: SandboxFilesystem[] = [];
afterEach(async () => {
  for (const filesystem of filesystems.splice(0)) await filesystem.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "lazy-filesystem-test-")); roots.push(root);
  const workspace = join(root, "workspace"), reference = join(root, "reference");
  await mkdir(workspace); await mkdir(reference);
  const controller = new AbortController();
  const filesystem = await SandboxFilesystem.create([
    { source: workspace, target: "/workspace", writable: true },
    { source: reference, target: "/authorized/0", writable: false },
  ], controller.signal);
  filesystems.push(filesystem);
  return { root, workspace, reference, filesystem, controller };
}
const openFile = async (fs: SandboxFilesystem, path: string, write = false, create = false, truncate = false) =>
  z.number().parse(await fs.request({ op: "open", path, write, create, truncate, exclusive: false }));
const write = (fs: SandboxFilesystem, handle: number, data: string, offset = 0) => fs.request({ op: "write", handle, data: Buffer.from(data), offset });
const read = async (fs: SandboxFilesystem, handle: number, offset = 0, size = 128) =>
  z.instanceof(Buffer).parse(await fs.request({ op: "read", handle, offset, size })).toString();

test("multi-gigabyte folders and files are read in chunks without a snapshot", async () => {
  const f = await fixture();
  const length = 2 * 1024 ** 3;
  const file = await open(join(f.workspace, "large.bin"), "wx");
  try { await file.truncate(length); await file.write(Buffer.from("tail"), 0, 4, length - 4); }
  finally { await file.close(); }
  const handle = await openFile(f.filesystem, "/workspace/large.bin");
  expect(await read(f.filesystem, handle, length - 4, 4)).toBe("tail");
  expect(await f.filesystem.request({ op: "stat", path: "/workspace/large.bin" })).toMatchObject({ st_size: length });
  const space = z.object({ budget: z.number(), available: z.number() }).parse(await f.filesystem.request({ op: "space" }));
  expect(space.available).toBe(space.budget);
});

test("staged output can exceed the former 512 MiB limit without a content buffer", async () => {
  const f = await fixture();
  const length = 512 * 1024 ** 2 + 17;
  const handle = await openFile(f.filesystem, "/workspace/large-output.bin", true, true);
  await f.filesystem.request({ op: "truncate", path: "/workspace/large-output.bin", handle, length });
  await write(f.filesystem, handle, "tail", length - 4);
  await f.filesystem.commit();
  const file = await open(join(f.workspace, "large-output.bin"), "r");
  try {
    expect((await file.stat()).size).toBe(length);
    const bytes = Buffer.alloc(4); await file.read(bytes, 0, 4, length - 4);
    expect(bytes.toString()).toBe("tail");
  } finally { await file.close(); }
}, 60000);

test("edits stay on disk staging until commit and read-only folders reject writes", async () => {
  const f = await fixture();
  const directory = z.object({ st_mode: z.number() }).parse(await f.filesystem.request({ op: "stat", path: "/workspace" }));
  expect(directory.st_mode & 0o100).toBe(0o100);
  await writeFile(join(f.workspace, "input"), "before");
  await writeFile(join(f.reference, "input"), "reference");
  const handle = await openFile(f.filesystem, "/workspace/input", true);
  await write(f.filesystem, handle, "edited");
  expect(await read(f.filesystem, handle)).toBe("edited");
  expect(await readFile(join(f.workspace, "input"), "utf8")).toBe("before");
  await expect(openFile(f.filesystem, "/authorized/0/input", true)).rejects.toMatchObject({ code: "EROFS" });
  await f.filesystem.commit();
  expect(await readFile(join(f.workspace, "input"), "utf8")).toBe("edited");
  expect(await readFile(join(f.reference, "input"), "utf8")).toBe("reference");
});

test("paths, links, private staging and host execution configuration are refused", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "secret"), "private");
  await mkdir(join(f.workspace, "LEGALWORK-SANDBOX-STAGING-hidden"));
  await writeFile(join(f.workspace, "LEGALWORK-SANDBOX-STAGING-hidden", "data"), "private staging");
  // Windows junctions exercise reparse-point containment without requiring
  // administrator rights or enabling Developer Mode to create symlinks.
  await symlink(f.root, join(f.workspace, "link"), process.platform === "win32" ? "junction" : "dir");
  for (const path of ["/workspace/../secret", "/workspace/link/secret", "/workspace/.env", "/workspace/CON", "/workspace/file:stream", "/workspace/legalwork-sandbox-staging-hidden/data", "/workspace/LEGALWORK-SANDBOX-STAGING-hidden/data", "/outside/secret"]) {
    await expect(openFile(f.filesystem, path)).rejects.toThrow();
  }
  await mkdir(join(f.workspace, "folder"));
  await f.filesystem.request({ op: "stat", path: "/workspace/folder" });
  await rm(join(f.workspace, "folder"), { recursive: true });
  await symlink(f.root, join(f.workspace, "folder"), process.platform === "win32" ? "junction" : "dir");
  await expect(f.filesystem.request({ op: "list", path: "/workspace/folder", offset: 0 })).rejects.toThrow();
});

test("a concurrent edit rejects all staged destinations before commit", async () => {
  const f = await fixture();
  await writeFile(join(f.workspace, "input"), "before");
  const existing = await openFile(f.filesystem, "/workspace/input", true);
  const created = await openFile(f.filesystem, "/workspace/output", true, true);
  await write(f.filesystem, existing, "edited"); await write(f.filesystem, created, "new");
  await writeFile(join(f.workspace, "input"), "manual");
  await expect(f.filesystem.commit()).rejects.toMatchObject({ code: "ESTALE" });
  expect(await readFile(join(f.workspace, "input"), "utf8")).toBe("manual");
  expect(await readFile(join(f.workspace, "output")).catch(() => null)).toBeNull();
});

test("atomic replacement preserves external hard links", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "outside"), "original");
  await link(join(f.root, "outside"), join(f.workspace, "input"));
  const handle = await openFile(f.filesystem, "/workspace/input", true, false, true);
  await write(f.filesystem, handle, "changed");
  await f.filesystem.commit();
  expect(await readFile(join(f.root, "outside"), "utf8")).toBe("original");
  expect(await readFile(join(f.workspace, "input"), "utf8")).toBe("changed");
});

test("existing-file rename validates the destination's original contents", async () => {
  const f = await fixture();
  await writeFile(join(f.workspace, "source"), "source contents");
  await writeFile(join(f.workspace, "target"), "target contents");
  await f.filesystem.request({ op: "rename", path: "/workspace/source", destination: "/workspace/target" });
  await f.filesystem.commit();
  expect(await readFile(join(f.workspace, "target"), "utf8")).toBe("source contents");
  expect(await readFile(join(f.workspace, "source")).catch(() => null)).toBeNull();
});

test("deletion and overwrite refuse same-size host edits with restored modification times", async () => {
  for (const op of ["unlink", "rename"]) {
    const f = await fixture();
    const target = join(f.workspace, "target");
    await writeFile(target, "before");
    await writeFile(join(f.workspace, "source"), "sandbox");
    const original = await stat(target);
    await f.filesystem.request(op === "unlink" ? { op, path: "/workspace/target" } : { op, path: "/workspace/source", destination: "/workspace/target" });
    await writeFile(target, "manual");
    await utimes(target, original.atime, original.mtime);
    await expect(f.filesystem.commit()).rejects.toMatchObject({ code: "ESTALE" });
    expect(await readFile(target, "utf8")).toBe("manual");
    expect(await readFile(join(f.workspace, "source"), "utf8")).toBe("sandbox");
  }
});

test("directory creation, temporary-file rename and deletion reach the right destinations", async () => {
  const f = await fixture();
  await mkdir(join(f.workspace, "empty"));
  await writeFile(join(f.workspace, "old"), "remove");
  await f.filesystem.request({ op: "mkdir", path: "/workspace/results", mode: 0o755 });
  const handle = await openFile(f.filesystem, "/workspace/results/temporary", true, true);
  await write(f.filesystem, handle, "draft");
  await f.filesystem.request({ op: "rename", path: "/workspace/results/temporary", destination: "/workspace/results/final" });
  await write(f.filesystem, handle, "final");
  await f.filesystem.request({ op: "unlink", path: "/workspace/old" });
  await f.filesystem.request({ op: "rmdir", path: "/workspace/empty" });
  await f.filesystem.commit();
  expect(await readFile(join(f.workspace, "results", "final"), "utf8")).toBe("final");
  expect(await readFile(join(f.workspace, "old")).catch(() => null)).toBeNull();
});

test("cancellation discards staged edits and rejects further reads", async () => {
  const f = await fixture();
  const handle = await openFile(f.filesystem, "/workspace/output", true, true);
  await write(f.filesystem, handle, "not committed");
  f.controller.abort(new Error("Permission revoked"));
  await expect(f.filesystem.request({ op: "read", handle, offset: 0, size: 1 })).rejects.toThrow("Permission revoked");
  await expect(f.filesystem.commit()).rejects.toThrow("Permission revoked");
  expect(await readFile(join(f.workspace, "output")).catch(() => null)).toBeNull();
});

test("overlapping aliases share staged contents and cannot bypass a read-only grant", async () => {
  const f = await fixture();
  const child = join(f.workspace, "child"); await mkdir(child);
  await writeFile(join(child, "input"), "before");
  const same = await SandboxFilesystem.create([
    { source: f.workspace, target: "/workspace", writable: true },
    { source: child, target: "/authorized/0", writable: true },
  ], f.controller.signal); filesystems.push(same);
  const first = await openFile(same, "/workspace/child/input", true);
  await write(same, first, "edited");
  const second = await openFile(same, "/authorized/0/input");
  expect(await read(same, second)).toBe("edited");
  await same.commit();
  expect(await readFile(join(child, "input"), "utf8")).toBe("edited");
  const restricted = await SandboxFilesystem.create([
    { source: f.workspace, target: "/workspace", writable: true },
    { source: child, target: "/authorized/0", writable: false },
  ], f.controller.signal); filesystems.push(restricted);
  await expect(openFile(restricted, "/workspace/child/input", true)).rejects.toMatchObject({ code: "EROFS" });
  await expect(openFile(restricted, "/workspace/CHILD/input", true)).rejects.toThrow();
});

test.skipIf(process.platform === "linux")("case and Unicode spelling collisions cannot silently merge staged outputs", async () => {
  const f = await fixture();
  const handle = await openFile(f.filesystem, "/workspace/Report.txt", true, true);
  await write(f.filesystem, handle, "first");
  await expect(openFile(f.filesystem, "/workspace/report.txt", true, true)).rejects.toMatchObject({ code: "EEXIST" });
  await expect(f.filesystem.request({ op: "rename", path: "/workspace/Report.txt", destination: "/workspace/report.txt" })).rejects.toMatchObject({ code: "EEXIST" });
  await f.filesystem.commit();
  expect(await readFile(join(f.workspace, "Report.txt"), "utf8")).toBe("first");
});
