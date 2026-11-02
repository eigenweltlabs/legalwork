import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError } from "../errors.js";
import { findEntry } from "./common.js";
import { nativeDriveAdapter, nativeSegment, type DriveDriver, type DriveItem } from "./native-drive.js";
import { transferEntry } from "./transfer.js";

function fixture() {
  const root: DriveItem = { id: "root", name: "Drive", folder: true, parents: [], size: 0, version: '"1"', contentType: "folder" };
  const items = new Map<string, DriveItem>([[root.id, root]]);
  const content = new Map<string, Buffer>();
  const mutations: string[] = [];
  const add = (id: string, name: string, parent = "root", folder = false, exported = false) => {
    const item = { ...root, id, name, parents: [parent], folder, exported, contentType: "text/plain", size: 7 };
    items.set(id, item); content.set(id, Buffer.from(`data:${id}`)); return item;
  };
  const get = async (id: string) => { const item = items.get(id); if (!item) throw new ApiError(404, "storage_not_found", "Missing"); return { ...item }; };
  const driver: DriveDriver = { root, namespace: "fixture:account:root", get,
    children: async (id, cursor) => { const children = [...items.values()].filter((item) => item.parents.includes(id)); const offset = Number(cursor ?? "0"); return { items: children.slice(offset, offset + 1), ...(offset + 1 < children.length ? { nextCursor: String(offset + 1) } : {}) }; },
    download: async (item) => new Response(Uint8Array.from(content.get(item.id) ?? Buffer.alloc(0))),
    upload: async (parent, name, current, source) => { mutations.push(`upload:${name}`); const item = current ?? add(String(items.size), name, parent.id); content.set(item.id, typeof source === "string" ? await readFile(source) : source); },
    mkdir: async (parent, name) => { mutations.push(`mkdir:${name}`); add(String(items.size), name, parent.id, true); },
    rename: async (item, parent, name) => { mutations.push(`rename:${name}`); items.set(item.id, { ...item, parents: [parent.id], name }); },
    remove: async (item) => { mutations.push(`delete:${item.id}`); items.delete(item.id); },
  };
  return { adapter: nativeDriveAdapter(driver), driver, items, add, mutations };
}
describe("native drive identities and source capabilities", () => {
  test("native copies recheck source membership and destination collisions before invoking the provider", async () => {
    const { driver, add, mutations } = fixture();
    const source = add("native", "Report.docx", "root", false, true), folder = add("archive", "Archive", "root", true);
    driver.copyFile = async (item, parent, name) => { mutations.push(`copy:${item.id}:${parent.id}:${name}`); };
    const adapter = nativeDriveAdapter(driver);
    await adapter.copyFile!(`${nativeSegment(source)}`, `${nativeSegment(folder)}/Report.docx`);
    expect(mutations).toEqual(["copy:native:archive:Report.docx"]);
    add("existing", "Taken.docx", folder.id);
    await expect(adapter.copyFile!(nativeSegment(source), `${nativeSegment(folder)}/Taken.docx`)).rejects.toMatchObject({ code: "storage_conflict" });
    const outside = add("outside", "Secret.txt", "different-root");
    await expect(adapter.copyFile!(nativeSegment(outside), `${nativeSegment(folder)}/Secret.txt`)).rejects.toMatchObject({ status: 404 });
    await expect(adapter.copyFile!(nativeSegment(source), `${nativeSegment(folder)}/${nativeSegment(source)}`)).rejects.toMatchObject({ code: "invalid_storage_name" });
    expect(mutations).toHaveLength(1);
  });
  test("providers without a rename token resolver still require a strong conditional version", async () => {
    const run = fixture(); const folder = run.add("folder", "Folder", "root", true);
    run.items.set(folder.id, { ...folder, version: "sha256:7" });
    await expect(run.adapter.rename!(nativeSegment(folder), "Renamed", "folder")).rejects.toMatchObject({ code: "storage_conditional_write_unsupported" });
    expect(run.mutations).toEqual([]);
  });
  test("read-only sources cannot use a rename token resolver to bypass their restriction", async () => {
    const run = fixture(); const folder = run.add("folder", "Folder", "root", true);
    run.items.set(folder.id, { ...folder, readOnly: true });
    let tokens = 0; run.driver.renameVersion = async () => { tokens++; return '"version"'; };
    await expect(run.adapter.rename!(nativeSegment(folder), "Renamed", "folder")).rejects.toMatchObject({ code: "storage_read_only" });
    expect(tokens).toBe(0); expect(run.mutations).toEqual([]);
  });
  test("same-name files remain distinct and plain names reject ambiguity across pages", async () => {
    const { adapter, add } = fixture(); const first = add("a", "same.txt"), second = add("b", "same.txt");
    const page = await adapter.list(""); const next = await adapter.list("", page.nextCursor);
    expect(page.entries[0].name).toBe(next.entries[0].name); expect(page.entries[0].path).not.toBe(next.entries[0].path);
    expect((await adapter.read(nativeSegment(first))).data.toString()).toBe("data:a");
    expect((await adapter.read(nativeSegment(second))).data.toString()).toBe("data:b");
    await expect(adapter.read("same.txt")).rejects.toMatchObject({ code: "storage_ambiguous_path" });
    await expect(findEntry(adapter, "same.txt")).rejects.toMatchObject({ code: "storage_ambiguous_path" });
  });
  test("ID paths cannot escape the configured root or bypass parent membership", async () => {
    const { adapter, add } = fixture(); const folder = add("folder", "Folder", "root", true); const outside = add("outside", "secret.txt", "another-root");
    await expect(adapter.read(nativeSegment(outside))).rejects.toMatchObject({ status: 404 });
    await expect(adapter.read(`${nativeSegment(folder)}/${nativeSegment(outside)}`)).rejects.toMatchObject({ status: 404 });
  });
  test("project references survive renames and reject moved-out or account-switched folders", async () => {
    const { adapter, add, items } = fixture(); const folder = add("folder", "Old", "root", true);
    const reference = await adapter.folderReference!(nativeSegment(folder)); items.set(folder.id, { ...folder, name: "New" });
    expect(await adapter.resolveFolder!(reference)).toBe(nativeSegment({ ...folder, name: "New" }));
    await expect(adapter.resolveFolder!({ ...reference, namespace: "another-account" })).rejects.toMatchObject({ code: "storage_namespace_changed" });
    items.set(folder.id, { ...folder, parents: ["missing"] }); await expect(adapter.resolveFolder!(reference)).rejects.toMatchObject({ status: 404 });
  });
  test("exported native documents can be edited locally but cannot replace the native source", async () => {
    const { adapter, add, mutations } = fixture(); const native = add("doc", "Notes.docx", "root", false, true); const path = nativeSegment(native);
    expect((await adapter.read(path)).writable).toBe(false); expect((await adapter.read(path)).exported).toBe(true);
    await expect(adapter.write(path, Buffer.from("edit"), "text/plain", { version: '"1"' })).rejects.toMatchObject({ code: "storage_export_read_only" });
    expect(mutations).toHaveLength(0);
  });
  test("conditional saves reject changed versions before mutating", async () => {
    const { adapter, add, mutations } = fixture(); const file = add("file", "File.txt");
    await expect(adapter.write(nativeSegment(file), Buffer.from("edit"), "text/plain", { version: '"old"' })).rejects.toMatchObject({ code: "storage_conflict" });
    expect(mutations).toHaveLength(0);
    await adapter.write(nativeSegment(file), Buffer.from("edit"), "text/plain", { version: '"1"' }); expect(mutations).toEqual(["upload:File.txt"]);
  });
  test("streams large downloads while inline reads remain bounded", async () => {
    const { driver, add } = fixture(); const file = add("large", "Large.bin");
    driver.download = async () => { let remaining = 52; return new Response(new ReadableStream({ pull(controller) { if (!remaining--) { controller.close(); return; } controller.enqueue(new Uint8Array(1024 * 1024)); } })); };
    const adapter = nativeDriveAdapter(driver); const directory = await mkdtemp(join(tmpdir(), "native-drive-"));
    try {
      expect((await adapter.download(nativeSegment(file), join(directory, "large"))).size).toBe(52 * 1024 * 1024);
      await expect(adapter.read(nativeSegment(file))).rejects.toMatchObject({ code: "storage_file_too_large" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  test("copies use display filenames and folder names instead of opaque identity segments", async () => {
    const source = fixture(), target = fixture(); const folder = source.add("folder", "Folder", "root", true); source.add("file", "Report.docx", folder.id, false, true);
    const result = await transferEntry(source.adapter, target.adapter, { path: nativeSegment(folder), kind: "folder", destinationId: "target", destinationPath: "", mode: "copy" }, false);
    expect(result).toBe("Folder"); expect(target.mutations).toEqual(["mkdir:Folder", "upload:Report.docx"]);
  });
  test("cross-source moves cannot delete native originals after exporting", async () => {
    const source = fixture(), target = fixture(); const file = source.add("native", "Report.docx", "root", false, true);
    await expect(transferEntry(source.adapter, target.adapter, { path: nativeSegment(file), kind: "file", destinationId: "target", destinationPath: "", mode: "move" }, false)).rejects.toMatchObject({ code: "storage_export_read_only" });
    expect(source.mutations).toHaveLength(0); expect(target.mutations).toHaveLength(0);
  });
});
