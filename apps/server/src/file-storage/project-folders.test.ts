import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { storageInputSchema } from "@legalwork/types/file-storage";
import { projectRemoteSchema } from "@legalwork/types/workspace";
import { captureFolder, scopedFolderAdapter, connectionFingerprint, ProjectFolderBindings } from "./project-folders.js";
import { entry, type StorageAdapter } from "./common.js";
import { readProjectDetails, updateProjectRemote, setProjectSyncId } from "../project-store.js";

function source(): StorageAdapter {
  const unexpected = async (): Promise<never> => { throw new Error("unexpected source mutation"); };
  return {
    list: async (path, cursor) => path === "" ? { entries: cursor ? [entry("Matter", "folder")] : [], nextCursor: cursor ? undefined : "next" } : { entries: [entry(`${path}/contract.txt`, "file")] },
    search: async () => ({ entries: [entry("Matter/contract.txt", "file"), entry("Other/private.txt", "file")], nextCursor: "search-next" }),
    read: async (path) => ({ data: Buffer.from(path), size: 1, version: "1" }),
    stat: async () => ({ size: 1, version: "1" }), download: unexpected,
    write: unexpected, upload: unexpected, mkdir: unexpected, deleteFolder: unexpected,
  };
}
test("path adapters resolve exact folders across pages and reject missing folders", async () => {
  expect(await captureFolder(source(), "Matter", "Storage")).toEqual({ path: "Matter", name: "Matter" });
  await expect(captureFolder(source(), "Missing", "Storage")).rejects.toMatchObject({ status: 404 });
  await expect(captureFolder(source(), "../Other", "Storage")).rejects.toMatchObject({ status: 400 });
});
test("linked virtual roots confine listing, reading and provider search and cannot mutate source", async () => {
  const adapter = await scopedFolderAdapter(source(), { path: "Matter", name: "Matter" });
  expect((await adapter.list("")).entries.map((item) => item.path)).toEqual(["contract.txt"]);
  expect((await adapter.read("contract.txt")).data.toString()).toBe("Matter/contract.txt");
  const results = await adapter.search!({ query: "contract", mode: "content", path: "" });
  expect(results.entries.map((item) => item.path)).toEqual(["contract.txt"]);
  expect(results.nextCursor).toBe("search-next");
  expect((await adapter.search!({ query: "contract", mode: "content", path: "nested", cursor: "search-next" })).entries).toEqual([]);
  expect(() => adapter.read("../Other/private.txt")).toThrow();
  await expect(adapter.write("contract.txt", Buffer.from("x"), "text/plain", {})).rejects.toMatchObject({ status: 403 });
  expect(adapter.deleteFolder).toBeUndefined();
});
test("project references survive metadata and sync identity changes without carrying credentials or local grants", async () => {
  const root = await mkdtemp(join(tmpdir(), "project-references-"));
  try {
    const connection = storageInputSchema.parse({ name: "Firm", config: { kind: "s3", bucket: "matters", region: "eu-central-1", accessKeyId: "member-key" }, secrets: { secretAccessKey: "secret-value" } });
    const fingerprint = connectionFingerprint(connection);
    expect(connectionFingerprint({ ...connection, secrets: { secretAccessKey: "rotated" } })).toBe(fingerprint);
    expect(connectionFingerprint({ ...connection, config: { ...connection.config, kind: "s3", bucket: "other", region: "eu-central-1", prefix: "", accessKeyId: "", forcePathStyle: false } })).not.toBe(fingerprint);
    const location = { id: randomUUID(), connectionId: randomUUID(), connectionName: "Firm", connectionFingerprint: fingerprint, folder: { path: "Matter", name: "Matter" } };
    const remote = projectRemoteSchema.parse({ version: 1, context: "Reviewed contract.txt; further documents remain unread.", initialization: "ready", folders: [location] });
    expect(remote).not.toHaveProperty("context");
    await updateProjectRemote(root, remote, 0);
    await setProjectSyncId(root, randomUUID());
    await setProjectSyncId(root, null);
    expect((await readProjectDetails(root)).remote).toEqual(remote);
    await expect(updateProjectRemote(root, { ...remote, folders: [] }, 0)).rejects.toMatchObject({ status: 409 });
    const bindings = new ProjectFolderBindings(join(root, "storage.json"));
    await bindings.save("local-project", location, "source-project");
    expect(await bindings.source("different-project", location)).toBeUndefined();
    expect(await bindings.source("local-project", { ...location, folder: { name: "Private", path: "Private" } })).toBeUndefined();
    const json = await readFile(join(root, ".legalwork/project.json"), "utf8");
    expect(json).not.toContain("Reviewed contract.txt");
    expect(json).not.toContain("source-project");
    expect(json).not.toContain("secret-value");
    expect(projectRemoteSchema.safeParse({ ...remote, folders: [{ ...location, secrets: { token: "no" } }] }).success).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
