import { expect, test } from "bun:test";
import { objectMutations, type StoredObject } from "./object-mutations.js";
import { conflict, renameDestination } from "./common.js";

function fixture(beforeCopy?: (path: string, files: Map<string, string>) => void, beforeRemove?: (path: string, files: Map<string, string>) => void) {
  const files = new Map([["old/a.txt", "a"], ["old/nested/b.txt", "b"], ["old/empty/", "marker"]]);
  const deleted: string[] = [];
  const record = (path: string): StoredObject | null => files.has(path) ? { path, version: files.get(path)! } : null;
  const adapter = objectMutations({
    list: async (prefix) => [...files.keys()].filter((path) => path.startsWith(prefix)).map((path) => record(path)!),
    stat: async (path) => record(path),
    async copy(source, destination) {
      beforeCopy?.(destination, files);
      if (files.has(destination) || files.get(source.path) !== source.version) conflict();
      files.set(destination, source.version);
    },
    async remove(source) {
      beforeRemove?.(source.path, files);
      if (files.get(source.path) !== source.version) conflict();
      deleted.push(source.path); files.delete(source.path);
    },
  });
  return { adapter, files, deleted };
}

test("renames a complete prefix including nested files and empty folder markers", async () => {
  const { adapter, files } = fixture();
  files.set("old-other/file", "unrelated");
  await adapter.rename!("old", "new", "folder");
  expect([...files]).toEqual([["old-other/file", "unrelated"], ["new/a.txt", "a"], ["new/nested/b.txt", "b"], ["new/empty/", "marker"]]);
});
test("rejects virtual-folder and file collisions before copying", async () => {
  for (const destination of ["new", "new/existing"]) {
    const { adapter, files, deleted } = fixture();
    files.set(destination, "keep");
    await expect(adapter.rename!("old", "new", "folder")).rejects.toMatchObject({ code: "storage_conflict" });
    expect(files.size).toBe(4); expect(deleted).toEqual([]);
  }
});
test("a failed copy leaves all originals and reports partial destinations", async () => {
  const { adapter, files, deleted } = fixture((path) => { if (path.endsWith("b.txt")) throw new Error("offline"); });
  await expect(adapter.rename!("old", "new", "folder")).rejects.toMatchObject({ code: "storage_rename_incomplete" });
  expect(files.get("old/a.txt")).toBe("a"); expect(files.get("old/nested/b.txt")).toBe("b");
  expect(files.get("new/a.txt")).toBe("a"); expect(deleted).toEqual([]);
});
test("concurrent additions or changes during a folder copy prevent source cleanup", async () => {
  for (const path of ["old/a.txt", "old/concurrent.txt"]) {
    const { adapter, files, deleted } = fixture((destination, files) => { if (destination.endsWith("empty/")) files.set(path, "new work"); });
    await expect(adapter.rename!("old", "new", "folder")).rejects.toMatchObject({ code: "storage_rename_incomplete" });
    expect(files.get(path)).toBe("new work"); expect(deleted).toEqual([]);
  }
});
test("conditional deletion preserves a concurrent update", async () => {
  const { adapter, files } = fixture(undefined, (path, files) => files.set(path, "new work"));
  await expect(adapter.deleteFile!("old/a.txt")).rejects.toMatchObject({ code: "storage_conflict" });
  expect(files.get("old/a.txt")).toBe("new work");
});
test("renames cannot move roots, traverse folders, or inject protocol commands", () => {
  expect(renameDestination("Matter/old.docx", "Neu ü.docx")).toBe("Matter/Neu ü.docx");
  for (const name of ["../outside", "a/b", "..", "/root", "a\\b", "file\r\nDELE x", ""]) expect(() => renameDestination("Matter/old", name)).toThrow();
  expect(() => renameDestination("", "new")).toThrow();
  expect(() => renameDestination("old", "old")).toThrow();
});
