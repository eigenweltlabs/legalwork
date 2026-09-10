import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { keepWorkspaceCopy, snapshotWorkspaceFile, workingCopy } from "./working-copy.js";
import { receiveFile } from "./common.js";
import { smbPath } from "./smb.js";

test("working copies remain separate, preserve existing destinations and reject workspace escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "storage-copies-"));
  const outside = await mkdtemp(join(tmpdir(), "storage-outside-"));
  try {
    const copy = await workingCopy(root, "合同 Müller.docx");
    await writeFile(copy.path, "draft");
    await keepWorkspaceCopy(root, copy.relativePath, "Matters/local.docx");
    expect(await readFile(copy.path, "utf8")).toBe("draft");
    await writeFile(copy.path, "new draft");
    await expect(keepWorkspaceCopy(root, copy.relativePath, "Matters/local.docx")).rejects.toMatchObject({
      status: 409,
    });
    expect(await readFile(join(root, "Matters/local.docx"), "utf8")).toBe("draft");
    await writeFile(join(outside, "secret"), "private");
    await symlink(outside, join(root, "escape"));
    await expect(snapshotWorkspaceFile(root, "escape/secret")).rejects.toMatchObject({ status: 403 });
    await expect(keepWorkspaceCopy(root, copy.relativePath, "escape/out.docx")).rejects.toMatchObject({ status: 403 });
    await copy.remove();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("interrupted downloads remove partial files without deleting existing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "storage-interrupted-"));
  try {
    const path = join(root, "download");
    const broken = async function* () {
      yield Buffer.from("partial");
      throw new Error("connection lost");
    };
    await expect(receiveFile(broken(), path)).rejects.toThrow("connection lost");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(path, "existing");
    await expect(receiveFile(Readable.from(["new"]), path)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path, "utf8")).toBe("existing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SMB paths reject Windows device names, streams and traversal while allowing Unicode", () => {
  for (const path of ["../outside", "a\\b", "a:secret", "NUL.txt", "CON", "x/COM1", "folder.", "a ", "*.txt", "a//b"])
    expect(() => smbPath(path)).toThrow();
  expect(smbPath("Matters/合同 Müller #1.docx")).toBe("Matters/合同 Müller #1.docx");
});
