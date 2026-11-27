import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LauncherSearchResult } from "@legalwork/types/launcher";
import { existingLauncherFiles } from "./launcher-file-visibility.js";
import { LauncherFileIndex } from "./launcher-file-index.js";
import { LauncherFolders } from "./launcher-folders.js";
import { searchFolderFiles } from "./launcher-folder-search.js";
import { searchLauncher, type LauncherSearchDeps } from "./launcher-search.js";

test("cached project and added-folder search omit deleted files, deleted folders and stale content hits without repairing the index", async () => {
  const root = await mkdtemp(join(tmpdir(), "launcher-visible-"));
  const index = new LauncherFileIndex({ watch: false });
  try {
    const path = join(root, "project");
    await mkdir(join(path, "Removed folder"), { recursive: true });
    await writeFile(join(path, "Keep.txt"), "Keep this untouched");
    await writeFile(join(path, "Removed.txt"), "Delete me");
    await writeFile(join(path, "Removed folder", "Child.txt"), "Delete me too");
    const folders = await LauncherFolders.open(join(root, "folders.sqlite"));
    const folder = await folders.add(path);
    await index.ensure("project", path, true);
    await index.ensure(`folder:${folder.id}`, path, true);
    await rm(join(path, "Removed.txt"));
    await rm(join(path, "Removed folder"), { recursive: true });
    const content: LauncherSearchDeps["fileContentSearch"] = async () => ({ items: ["Keep.txt", "Removed.txt"].map(id => ({ kind: "files", id, workspaceId: "project", title: id, excerpt: "needle", updatedAt: 1, sources: [{ path: id, hash: "h", page: null, source: "native", quote: "needle" }] })) });
    const workspace = { id: "project", name: "Matter", path, preset: "starter", workspaceType: "local" } satisfies Awaited<ReturnType<LauncherSearchDeps["workspaces"]>>["workspaces"][number];
    const deps: LauncherSearchDeps = { workspaces: async () => ({ workspaces: [workspace], unavailable: [] }), projectName: item => item.name, tasks: async () => [], recordings: null, fileIndex: index, sessionSearch: async () => ({ items: [] }), fileContentSearch: content };
    for (const query of ["", "needle"]) {
      const input = { query, kinds: ["files"], content: Boolean(query), limit: 50 } satisfies Parameters<typeof searchLauncher>[1];
      const project = await searchLauncher(deps, input, AbortSignal.timeout(2000));
      const extra = await searchFolderFiles(folders, index, input, (_folder, signal) => content(workspace, query, signal), AbortSignal.timeout(2000));
      expect(project.items.map(item => item.path)).toEqual(["Keep.txt"]);
      expect(extra.items.map(item => item.path)).toEqual(["Keep.txt"]);
      expect(project.sources[0].count).toBe(1);
      expect(extra.sources[0].count).toBe(1);
    }
    expect(index.search("project", "Removed").length).toBeGreaterThan(0);
    expect(await readFile(join(path, "Keep.txt"), "utf8")).toBe("Keep this untouched");
  } finally { index.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("recent file validation rejects missing paths, changed kinds, trash and escaped roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "launcher-visible-boundary-"));
  try {
    const path = join(root, "project");
    await mkdir(join(path, "Folder"), { recursive: true });
    await mkdir(join(path, ".legalwork", "sync-trash"), { recursive: true });
    await writeFile(join(path, "Keep.txt"), "keep");
    await writeFile(join(path, ".legalwork", "sync-trash", "Old.txt"), "trash");
    await writeFile(join(root, "Outside.txt"), "outside");
    await symlink(join(root, "Outside.txt"), join(path, "Link.txt"));
    const result = (name: string, folder = false): LauncherSearchResult => ({ id: name, path: name, kind: "files", title: name, workspaceId: "project", sourceId: "local:project", score: 0, updatedAt: 1, match: "recent", actions: ["open"], fileType: folder ? "folder" : "txt" });
    const candidates = [result("Keep.txt"), result("Folder", true), result("Folder"), result("Keep.txt", true), result("Missing.txt"), result(".legalwork/sync-trash/Old.txt"), result("../Outside.txt"), result("Link.txt"), { ...result("", true), folderId: "configured-root" }];
    expect((await existingLauncherFiles(path, candidates)).map(item => item.path)).toEqual(["Keep.txt", "Folder", ""]);
    await rm(path, { recursive: true });
    expect(await existingLauncherFiles(path, candidates)).toEqual([]);
    expect(await readFile(join(root, "Outside.txt"), "utf8")).toBe("outside");
  } finally { await rm(root, { recursive: true, force: true }); }
});
