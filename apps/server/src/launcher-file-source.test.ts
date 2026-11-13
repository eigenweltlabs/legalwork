import { expect, test } from "bun:test";
import { constants } from "node:fs";
import { copyFile, mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copyLauncherTransferFile } from "./launcher-file-source.js";

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), "launcher-transfer-source-"));
  const rootPath = join(temporary, "source"); await mkdir(rootPath);
  await writeFile(join(rootPath, "file.txt"), "original");
  const root = await realpath(rootPath), path = join(root, "file.txt");
  return { temporary, source: { rootPath, root, path, relativePath: "file.txt", info: await stat(path) }, destination: join(temporary, "destination.txt") };
}

test("transfer rejects a source changed to an escaping link while approval was pending", async () => {
  const { temporary, source, destination } = await fixture();
  try {
    const outside = join(temporary, "private.txt"); await writeFile(outside, "private contents");
    await rm(source.path); await symlink(outside, source.path);
    await expect(copyLauncherTransferFile(source, destination, true)).rejects.toThrow("source file changed");
    expect(await stat(destination).catch(() => null)).toBeNull();
    expect(await readFile(outside, "utf8")).toBe("private contents");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("move preserves a replacement source created during copying and reports the completed copy", async () => {
  const { temporary, source, destination } = await fixture();
  try {
    await expect(copyLauncherTransferFile(source, destination, true, async (from, to) => {
      await copyFile(from, to, constants.COPYFILE_EXCL);
      await rename(from, join(temporary, "original.txt"));
      await writeFile(from, "replacement created during copy");
    })).rejects.toThrow("copy was created");
    expect(await readFile(source.path, "utf8")).toBe("replacement created during copy");
    expect(await readFile(destination, "utf8")).toBe("original");
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test("unchanged moves succeed and a destination created meanwhile is never replaced", async () => {
  const { temporary, source, destination } = await fixture();
  try {
    await writeFile(destination, "keep destination");
    await expect(copyLauncherTransferFile(source, destination, true)).rejects.toThrow();
    expect(await readFile(destination, "utf8")).toBe("keep destination");
    expect(await readFile(source.path, "utf8")).toBe("original");
    await rm(destination);
    await copyLauncherTransferFile(source, destination, true);
    expect(await readFile(destination, "utf8")).toBe("original");
    expect(await stat(source.path).catch(() => null)).toBeNull();
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
