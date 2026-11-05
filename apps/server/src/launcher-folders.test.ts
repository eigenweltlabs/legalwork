import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherFolders } from "./launcher-folders.js";
import { LauncherFileIndex } from "./launcher-file-index.js";
import { searchFolderFiles } from "./launcher-folder-search.js";
import { registerLauncherRoutes } from "./routes/launcher.js";
import { matchRoute, type Route, type RequestContext } from "./routes/registry.js";

test("search roots survive restart, deduplicate links, enforce boundaries and leave removed files intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "search-folders-"));
  try {
    const path = join(root, "files"), outside = join(root, "outside");
    await mkdir(path); await mkdir(outside); await mkdir(join(path, "nested"));
    await writeFile(join(path, "nested", "contract.txt"), "contract");
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(path, join(root, "alias")); await symlink(outside, join(path, "escape"));
    const folders = await LauncherFolders.open(join(root, "db.sqlite"));
    const saved = await folders.add(path, "Contracts");
    expect(await folders.add(join(root, "alias"))).toEqual(saved);
    const restarted = await LauncherFolders.open(join(root, "db.sqlite"));
    expect(restarted.list()).toEqual([saved]);
    expect((await restarted.file(saved.id, "nested/contract.txt")).absolute).toBe(join(saved.path, "nested/contract.txt"));
    await expect(restarted.file(saved.id, "../outside/secret.txt")).rejects.toThrow();
    await expect(restarted.file(saved.id, "escape/secret.txt")).rejects.toThrow();
    await rename(path, join(root, "moved")); await symlink(outside, path);
    await expect(restarted.root(saved.id)).rejects.toThrow("location changed");
    restarted.remove(saved.id);
    expect(await readFile(join(root, "moved/nested/contract.txt"), "utf8")).toBe("contract");
    await expect(restarted.file(saved.id, "secret.txt")).rejects.toThrow("removed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("folder files join search with provenance and filters, but never become a project target", async () => {
  const root = await mkdtemp(join(tmpdir(), "search-folders-"));
  const index = new LauncherFileIndex({ watch: false });
  try {
    const folders = await LauncherFolders.open(join(root, "db.sqlite"));
    const path = join(root, "files"); await mkdir(path);
    await writeFile(join(path, "Contract.pdf"), "text"); await writeFile(join(path, "Contract.png"), "image");
    const folder = await folders.add(path, "Library");
    await index.ensure(`folder:${folder.id}`, path, true);
    const input = { query: "contract", kinds: ["files"] as const, content: false, limit: 10, fileTypes: ["pdf"] };
    const result = await searchFolderFiles(folders, index, { ...input, kinds: [...input.kinds] }, async () => ({ items: [] }), AbortSignal.timeout(1000));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ title: "Contract.pdf", folderId: folder.id, workspaceId: null, subtitle: "Library" });
    expect(result.sources[0].coverage).toBe("filename-only");
    const browse = await searchFolderFiles(folders, index, { query: "", kinds: ["files"], content: false, limit: 10 }, async () => ({ items: [] }), AbortSignal.timeout(1000));
    expect(browse.items.map(item => item.title).sort()).toEqual(["Contract.pdf", "Contract.png"]);
    const scoped = await searchFolderFiles(folders, index, { ...input, kinds: [...input.kinds], projectId: "project" }, async () => ({ items: [] }), AbortSignal.timeout(1000));
    expect(scoped.items).toHaveLength(0);
    await rm(path, { recursive: true });
    const missing = await searchFolderFiles(folders, index, { ...input, kinds: [...input.kinds] }, async () => ({ items: [] }), AbortSignal.timeout(1000));
    expect(missing.sources[0].coverage).toBe("unavailable");
  } finally { index.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("folder routes require owner configuration and copy explicit attachments into the Assistant", async () => {
  const root = await mkdtemp(join(tmpdir(), "folder-routes-"));
  const fileIndex = new LauncherFileIndex({ watch: false });
  try {
    const path = join(root, "files"), assistantPath = join(root, "assistant"); await mkdir(path); await mkdir(assistantPath);
    await writeFile(join(path, "contract.txt"), "original");
    const searchFolders = await LauncherFolders.open(join(root, "db.sqlite"));
    const routes: Route[] = []; let scope = "owner";
    // Minimal route fixture; unrelated service dependencies are not invoked.
    registerLauncherRoutes({ routes, searchFolders, fileIndex, config: { workspaces: [] }, ensureWritable: () => {},
      requireClientScope: (_ctx: unknown, required: string) => { if (required === "owner" && scope !== "owner") throw new Error("owner required"); },
      jsonResponse: (value: unknown, status = 200) => Response.json(value, { status }), readJsonBodyLimited: (request: Request) => request.json(),
      assistant: { workspace: async () => ({ id: "assistant", path: assistantPath }) },
    } as unknown as Parameters<typeof registerLauncherRoutes>[0]);
    const send = async (method: string, url: string, body?: object) => {
      const matched = matchRoute(routes, method, url)!;
      const request = new Request(`http://localhost${url}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      return matched.handler({ request, url: new URL(request.url), params: matched.params, actor: { type: "host" } } as RequestContext);
    };
    scope = "viewer"; await expect(send("POST", "/launcher/folders", { path })).rejects.toThrow("owner required");
    scope = "owner"; const { folder } = await (await send("POST", "/launcher/folders", { path })).json();
    const { item } = await (await send("POST", `/launcher/folders/${folder.id}/attach`, { path: "contract.txt" })).json();
    expect(item.workspaceId).toBe("assistant");
    expect(await readFile(join(assistantPath, item.path), "utf8")).toBe("original");
    await writeFile(join(path, "contract.txt"), "changed");
    expect(await readFile(join(assistantPath, item.path), "utf8")).toBe("original");
    const cached = { id: "contract.txt", path: "contract.txt", kind: "files", title: "contract.txt", folderId: folder.id, workspaceId: null, sourceId: `folder:${folder.id}`, score: 0, updatedAt: 1, match: "recent", actions: ["open"], fileType: "txt" };
    scope = "viewer";
    expect((await (await send("POST", "/launcher/files/visible", { items: [cached] })).json()).items).toHaveLength(1);
    expect((await (await send("POST", "/launcher/files/visible", { items: [{ ...cached, path: "missing.txt" }] })).json()).items).toEqual([]);
    expect(await readFile(join(path, "contract.txt"), "utf8")).toBe("changed");
    scope = "owner";
    await send("DELETE", `/launcher/folders/${folder.id}`);
    expect(await readFile(join(path, "contract.txt"), "utf8")).toBe("changed");
    expect((await (await send("POST", "/launcher/files/visible", { items: [cached] })).json()).items).toEqual([]);
  } finally { fileIndex.dispose(); await rm(root, { recursive: true, force: true }); }
});
