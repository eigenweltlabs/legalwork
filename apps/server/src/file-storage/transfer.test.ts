import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import type { StorageTransfer, StorageTransferProgress } from "@legalwork/types/file-storage";
import { conflict, entry, hashVersion, type StorageAdapter, type WriteCondition } from "./common.js";
import { transferDestination, transferEntry } from "./transfer.js";

class Drive implements StorageAdapter {
  folders = new Set<string>();
  files = new Map<string, Buffer>();
  removed: string[] = [];
  uploads = 0;
  failUpload = "";
  afterUpload?: () => void;
  afterDelete?: () => void;
  rename?: StorageAdapter["rename"];
  put(path: string, text: string) { this.files.set(path, Buffer.from(text)); return this; }
  async list(path: string, cursor?: string) {
    const children = [...this.folders].map((path) => entry(path, "folder"))
      .concat([...this.files].map(([path, data]) => entry(path, "file", data.length)))
      .filter((item) => item.path.split("/").slice(0, -1).join("/") === path);
    const offset = Number(cursor ?? 0);
    return { entries: children.slice(offset, offset + 2), nextCursor: offset + 2 < children.length ? String(offset + 2) : undefined };
  }
  async stat(path: string) {
    const data = this.files.get(path);
    return data ? { size: data.length, version: hashVersion(data) } : null;
  }
  async read(path: string) {
    const data = this.files.get(path);
    if (!data) throw new Error("Missing file");
    return { data, size: data.length, version: hashVersion(data), contentType: "text/plain" };
  }
  async download(path: string, destination?: string) {
    const data = await this.read(path);
    if (destination) await writeFile(destination, data.data, { flag: "wx" });
    return { size: data.size, version: data.version, sha256: hashVersion(data.data), contentType: data.contentType };
  }
  async write(path: string, data: Buffer, _contentType: string, condition: WriteCondition) {
    if (path === this.failUpload) throw new Error("Upload failed");
    if (condition.createOnly && (this.files.has(path) || this.folders.has(path))) conflict();
    this.files.set(path, data); this.uploads++; this.afterUpload?.();
  }
  async upload(path: string, source: string, contentType: string, condition: WriteCondition) {
    await this.write(path, await readFile(source), contentType, condition);
  }
  async mkdir(path: string) {
    if (this.folders.has(path) || this.files.has(path)) conflict();
    this.folders.add(path);
  }
  async deleteFile(path: string, condition?: WriteCondition) {
    const version = condition?.version;
    if (version && (await this.stat(path))?.version !== version) conflict();
    this.removed.push(path); this.files.delete(path); this.afterDelete?.();
  }
  async deleteFolder(path: string, recursive = true) {
    if (!recursive && [...this.files.keys(), ...this.folders].some((name) => name.startsWith(`${path}/`))) conflict();
    for (const name of this.files.keys()) if (name.startsWith(`${path}/`)) await this.deleteFile(name);
    for (const name of this.folders) if (name === path || name.startsWith(`${path}/`)) this.folders.delete(name);
    this.removed.push(path);
  }
}
const input: StorageTransfer = { path: "matter", kind: "folder", destinationId: "target", destinationPath: "archive", mode: "move" };
function drives() {
  const source = new Drive().put("matter/a.txt", "alpha").put("matter/nested/b.txt", "beta").put("matter/c.txt", "gamma");
  source.folders = new Set(["matter", "matter/nested", "matter/empty"]);
  const target = new Drive(); target.folders.add("archive");
  return { source, target };
}

describe("storage transfers", () => {
  test("same-connection copies use native file copies for a whole tree, preserving originals, empty folders and progress", async () => {
    const { source } = drives();
    source.folders.add("archive");
    const copied: string[] = [], progress: StorageTransferProgress[] = [];
    const native = Object.assign(source, {
      copyFile: async (path: string, destination: string) => { source.files.set(destination, source.files.get(path)!); copied.push(path); },
      download: async () => { throw new Error("Native copies must not download"); },
      upload: async () => { throw new Error("Native copies must not upload"); },
    });
    expect(await transferEntry(native, native, { ...input, mode: "copy" }, true, update => progress.push(update))).toBe("archive/matter");
    expect(copied).toEqual(["matter/a.txt", "matter/c.txt", "matter/nested/b.txt"]);
    expect(source.folders.has("archive/matter/empty")).toBe(true);
    expect(source.files.get("archive/matter/nested/b.txt")).toEqual(source.files.get("matter/nested/b.txt"));
    expect(source.removed).toEqual([]);
    expect([...new Set(progress.filter(update => update.phase === "transferring").map(update => update.completedFiles))]).toEqual([0, 1, 2, 3]);
    expect(progress.at(-1)).toMatchObject({ phase: "completed", completedFiles: 3, totalFiles: 3 });
  });
  test("native copy failures retain originals and partial copies without retrying through byte transfer", async () => {
    const { source } = drives(); source.folders.add("archive"); let copies = 0;
    const native = Object.assign(source, {
      copyFile: async (path: string, destination: string) => {
        if (++copies === 2) throw new Error("Copy failed");
        source.files.set(destination, source.files.get(path)!);
      },
      download: async () => { throw new Error("Must not download after a native failure"); },
    });
    await expect(transferEntry(native, native, { ...input, mode: "copy" }, true)).rejects.toMatchObject({ code: "storage_transfer_incomplete" });
    expect(copies).toBe(2); expect(source.removed).toEqual([]);
    expect(source.files.has("archive/matter/a.txt")).toBe(true);
    expect(source.files.has("matter/nested/b.txt")).toBe(true);
  });
  test("different-connection copies keep using streaming even when the source has a native copy method", async () => {
    const { source, target } = drives(); let copies = 0;
    const native = Object.assign(source, { copyFile: async () => { copies++; throw new Error("Wrong account"); } });
    await transferEntry(native, target, { ...input, path: "matter/a.txt", kind: "file", mode: "copy" }, false);
    expect(copies).toBe(0); expect(target.uploads).toBe(1);
  });
  test("an incomplete source listing is rejected before copying any folder contents", async () => {
    const { source, target } = drives();
    const list = source.list.bind(source);
    source.list = async (path, cursor) => ({ ...await list(path, cursor), truncated: true });
    await expect(transferEntry(source, target, { ...input, mode: "copy" }, false)).rejects.toMatchObject({ code: "storage_listing_incomplete" });
    expect(target.uploads).toBe(0); expect(target.folders).toEqual(new Set(["archive"]));
  });
  test("reports real file counts through scanning, verified copies, source cleanup and completion", async () => {
    const { source, target } = drives();
    const updates: StorageTransferProgress[] = [];
    await transferEntry(source, target, input, false, (progress) => {
      updates.push(progress);
      if (progress.phase === "transferring") {
        expect(progress.completedFiles).toBeLessThanOrEqual(target.files.size);
        expect(source.removed).toEqual([]);
      }
    });
    expect(updates[0]).toMatchObject({ phase: "scanning", totalFiles: null, completedFiles: 0 });
    expect([...new Set(updates.filter((progress) => progress.phase === "transferring").map((progress) => progress.completedFiles))]).toEqual([0, 1, 2, 3]);
    expect(updates.filter((progress) => progress.phase === "verifying").at(-1)?.completedFiles).toBe(3);
    expect(updates.filter((progress) => progress.phase === "removing").at(-1)?.completedFiles).toBe(3);
    expect(updates.at(-1)).toMatchObject({ phase: "completed", completedFiles: 3, totalFiles: 3 });
  });
  test("moves a paginated folder tree across drives, preserving nested and empty folders and bytes", async () => {
    const { source, target } = drives();
    expect(await transferEntry(source, target, input, false)).toBe("archive/matter");
    expect([...source.files]).toEqual([]);
    expect([...source.folders]).toEqual([]);
    expect([...target.folders]).toEqual(["archive", "archive/matter", "archive/matter/nested", "archive/matter/empty"]);
    expect(target.files.get("archive/matter/nested/b.txt")?.toString()).toBe("beta");
    expect(target.files.get("archive/matter/c.txt")?.toString()).toBe("gamma");
  });
  test("copies a file without deleting its original", async () => {
    const { source, target } = drives();
    await transferEntry(source, target, { ...input, kind: "file", path: "matter/a.txt", mode: "copy" }, false);
    expect(target.files.get("archive/a.txt")?.toString()).toBe("alpha");
    expect(source.files.get("matter/a.txt")?.toString()).toBe("alpha");
    expect(source.removed).toEqual([]);
  });
  test("copies a complete folder while retaining all original files and empty folders", async () => {
    const { source, target } = drives();
    await transferEntry(source, target, { ...input, mode: "copy" }, false);
    expect(source.files.size).toBe(3);
    expect(source.folders.size).toBe(3);
    expect(source.removed).toEqual([]);
    expect(target.files.get("archive/matter/nested/b.txt")?.toString()).toBe("beta");
    expect(target.folders.has("archive/matter/empty")).toBe(true);
  });
  test("moves virtual object-store folders that disappear when their last file is removed", async () => {
    const { source, target } = drives();
    source.folders = new Set(["matter/empty"]);
    source.list = async (path, cursor) => {
      const folders = new Set(source.folders);
      for (const name of [...source.folders, ...source.files.keys()]) {
        const parts = name.split("/");
        for (let length = 1; length < parts.length; length++) folders.add(parts.slice(0, length).join("/"));
      }
      const items = [...folders].map((path) => entry(path, "folder"))
        .concat([...source.files.keys()].map((path) => entry(path, "file")))
        .filter((item) => item.path.split("/").slice(0, -1).join("/") === path);
      const offset = Number(cursor ?? 0);
      return { entries: items.slice(offset, offset + 2), nextCursor: offset + 2 < items.length ? String(offset + 2) : undefined };
    };
    await transferEntry(source, target, input, false);
    expect(source.files.size).toBe(0);
    expect(source.folders.size).toBe(0);
    expect(target.files.get("archive/matter/nested/b.txt")?.toString()).toBe("beta");
  });
  test("moves within a drive using its native rename without downloading contents", async () => {
    const source = new Drive().put("a.txt", "alpha");
    source.folders.add("archive");
    let renamed = "";
    source.rename = async (path, destination) => { renamed = `${path}:${destination}`; };
    await transferEntry(source, source, { ...input, kind: "file", path: "a.txt" }, true);
    expect(renamed).toBe("a.txt:archive/a.txt");
    expect(source.uploads).toBe(0);
  });
  test("rejects collisions, nonexistent targets, roots, traversal and moves into descendants before copying", async () => {
    const { source, target } = drives();
    target.folders.add("archive/matter");
    await expect(transferEntry(source, target, input, false)).rejects.toMatchObject({ code: "storage_conflict" });
    await expect(transferEntry(source, target, { ...input, destinationPath: "missing" }, false)).rejects.toMatchObject({ code: "storage_not_found" });
    for (const path of ["", "../outside", "a//b", "a\\b"])
      expect(() => transferDestination({ ...input, path }, true)).toThrow();
    for (const destinationPath of ["", "matter", "matter/nested"])
      expect(() => transferDestination({ ...input, destinationPath }, true)).toThrow();
    expect(target.uploads).toBe(0);
    expect(source.removed).toEqual([]);
  });
  test("keeps all originals if a later upload fails and reports partial copies", async () => {
    const { source, target } = drives();
    target.failUpload = "archive/matter/c.txt";
    await expect(transferEntry(source, target, input, false)).rejects.toMatchObject({ code: "storage_transfer_incomplete" });
    expect(source.files.size).toBe(3);
    expect(source.removed).toEqual([]);
    expect(target.files.size).toBeGreaterThan(0);
  });
  test("preserves concurrent source edits or additions before deleting originals", async () => {
    for (const change of ["edit", "add"]) {
      const { source, target } = drives();
      target.afterUpload = () => { source.put(change === "edit" ? "matter/a.txt" : "matter/new.txt", "new work"); };
      await expect(transferEntry(source, target, input, false)).rejects.toMatchObject({ code: "storage_transfer_incomplete" });
      expect(source.removed).toEqual([]);
      expect(source.files.get(change === "edit" ? "matter/a.txt" : "matter/new.txt")?.toString()).toBe("new work");
    }
  });
  test("retains originals if destination read-back differs from the uploaded bytes", async () => {
    const { source, target } = drives();
    target.afterUpload = () => target.put("archive/matter/a.txt", "corrupted");
    await expect(transferEntry(source, target, input, false)).rejects.toMatchObject({ code: "storage_transfer_incomplete" });
    expect(source.files.size).toBe(3);
    expect(source.removed).toEqual([]);
  });
  test("does not delete new files that arrive while originals are being removed", async () => {
    const { source, target } = drives();
    source.afterDelete = () => { source.put("matter/new.txt", "new work"); };
    await expect(transferEntry(source, target, input, false)).rejects.toMatchObject({ code: "storage_transfer_incomplete" });
    expect(source.files.get("matter/new.txt")?.toString()).toBe("new work");
    expect(source.folders.has("matter")).toBe(true);
    expect(target.files.size).toBe(3);
  });
});
