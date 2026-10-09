import { describe, expect, test } from "bun:test";
import { storageTransferSchema, type StorageRoot } from "@legalwork/types/file-storage";
import { canDropStorageEntry, hasStorageEntryDrag, readStorageEntryDrag, writeStorageEntryDrag, type StorageEntryDragItem } from "../src/app/lib/storage-entry-drag";
import { readStorageFileDrag } from "../src/app/lib/storage-file-drag";

const root: StorageRoot = { id: "source", name: "Source", kind: "s3", writable: true };
const item: StorageEntryDragItem = { workspaceId: "workspace", connectionId: root.id, path: "matter", kind: "folder", writable: true };

describe("drive drag destinations", () => {
  test("accepts other folders and connected drives, including their roots", () => {
    expect(canDropStorageEntry(item, "workspace", root, "archive")).toBe(true);
    expect(canDropStorageEntry(item, "workspace", { ...root, id: "other" }, "")).toBe(true);
  });
  test("rejects descendants, current parents, read-only targets and different workspaces", () => {
    for (const path of ["", "matter", "matter/subfolder"])
      expect(canDropStorageEntry(item, "workspace", root, path)).toBe(false);
    expect(canDropStorageEntry(item, "other-workspace", root, "archive")).toBe(false);
    expect(canDropStorageEntry(item, "workspace", { ...root, id: "other", writable: false }, "")).toBe(false);
    expect(canDropStorageEntry({ ...item, path: "matter/a.txt", kind: "file" }, "workspace", root, "matter")).toBe(false);
  });
  test("defaults transfer requests to copying so omitted modes preserve originals", () => {
    expect(storageTransferSchema.parse({ path: item.path, kind: item.kind, destinationId: "other", destinationPath: "" }).mode).toBe("copy");
  });
  test("preserves the existing task attachment payload and advertises copying for all sources", () => {
    const store = new Map<string, string>();
    const transfer = {
      effectAllowed: "none",
      get types() { return [...store.keys()]; },
      setData: (type: string, value: string) => { store.set(type, value); },
      getData: (type: string) => store.get(type) ?? "",
    };
    // The browser supplies the rest of DataTransfer. This test exercises just its payload methods.
    const data = transfer as unknown as DataTransfer;
    writeStorageEntryDrag(data, "workspace", root, { path: "matter/a.txt", name: "a.txt", kind: "file", size: 1, modifiedAt: null });
    expect(data.effectAllowed).toBe("copy");
    expect(hasStorageEntryDrag(data)).toBe(true);
    expect(readStorageEntryDrag(data)?.kind).toBe("file");
    expect(readStorageFileDrag(data)?.name).toBe("a.txt");
    writeStorageEntryDrag(data, "workspace", { ...root, writable: false }, { path: "matter/a.txt", name: "a.txt", kind: "file", size: 1, modifiedAt: null });
    expect(data.effectAllowed).toBe("copy");
  });
});
