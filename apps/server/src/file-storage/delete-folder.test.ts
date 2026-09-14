import { expect, test } from "bun:test";
import { entry } from "./common.js";
import { deleteFolderTree } from "./delete-folder.js";

test("folder deletion reads every page before removing files, then removes directories from the bottom up", async () => {
  const files = new Set(["matter/a", "matter/b", "matter/c", "matter/nested/file", "matter-other/keep"]);
  const removed: string[] = [];
  const directories = new Set(["matter", "matter/nested", "matter/empty"]);
  await deleteFolderTree({
    async list(path, cursor) {
      expect(removed).toEqual([]);
      const items = [...directories].filter((name) => name.split("/").slice(0, -1).join("/") === path).map((name) => entry(name, "folder"))
        .concat([...files].filter((name) => name.split("/").slice(0, -1).join("/") === path).map((name) => entry(name, "file")));
      const offset = Number(cursor ?? 0);
      return { entries: items.slice(offset, offset + 2), nextCursor: offset + 2 < items.length ? String(offset + 2) : undefined };
    },
    async deleteFile(path) { files.delete(path); removed.push(path); },
  }, "matter", async (path) => {
    expect([...files, ...directories].some((name) => name.startsWith(`${path}/`))).toBe(false);
    directories.delete(path); removed.push(path);
  });
  expect([...files]).toEqual(["matter-other/keep"]);
  expect(directories.size).toBe(0);
  expect(removed.at(-1)).toBe("matter");
});

test("invalid paths, escaped children and repeated listing pages cannot start deleting", async () => {
  let deleted = false;
  const remove = async () => { deleted = true; };
  for (const path of ["", "../other", "matter/../other"])
    await expect(deleteFolderTree({ list: async () => ({ entries: [] }), deleteFile: remove }, path, remove)).rejects.toThrow();
  for (const child of ["other/file", "matter/nested/file", "matter/../other"])
    await expect(deleteFolderTree({ list: async () => ({ entries: [{ path: child, name: "file", kind: "file", size: 0, modifiedAt: null }] }), deleteFile: remove }, "matter", remove)).rejects.toThrow();
  await expect(deleteFolderTree({ list: async () => ({ entries: [], nextCursor: "again" }), deleteFile: remove }, "matter", remove)).rejects.toThrow("repeated");
  expect(deleted).toBe(false);
});

test("a failed file deletion stops before removing the containing folder", async () => {
  let removedFolder = false;
  await expect(deleteFolderTree({
    list: async () => ({ entries: [entry("matter/file", "file")] }),
    deleteFile: async () => { throw new Error("Permission denied"); },
  }, "matter", async () => { removedFolder = true; })).rejects.toThrow("Permission denied");
  expect(removedFolder).toBe(false);
});
