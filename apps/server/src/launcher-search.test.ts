import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LauncherFileIndex } from "./launcher-file-index.js";
import { browseLauncherDirectory } from "./launcher-browse.js";
import { searchLauncher, type LauncherSearchDeps } from "./launcher-search.js";
import type { WorkspaceInfo } from "./types.js";

test("one query fans out to every source, keeps per-source coverage, and never reports a failed source as empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "launcher-search-"));
  const fileIndex = new LauncherFileIndex({ watch: false });
  try {
    await writeFile(join(root, "Mietvertrag Müller.docx"), "x");
    await writeFile(join(root, "Notes.md"), "Der Mietvertrag endet…");
    const mueller: WorkspaceInfo = { id: "mueller", name: "Müller ./. Schmidt", path: root, preset: "starter", workspaceType: "local" };
    const other: WorkspaceInfo = { id: "other", name: "Other", path: join(root, "missing"), preset: "starter", workspaceType: "local" };
    await fileIndex.ensure("mueller", root, true);
    const deps: LauncherSearchDeps = {
      workspaces: async () => ({ workspaces: [mueller, other], unavailable: ["offline-project"] }),
      projectName: workspace => workspace.name,
      tasks: async query => query ? [{ kind: "tasks", id: "task-1", workspaceId: "mueller", title: "Mietvertrag prüfen", excerpt: "", updatedAt: 5, completed: false }] : [],
      recordings: async () => [{ id: "rec-1", title: "Mandantengespräch Müller", createdAt: 7, durationMs: 1000, projectIds: ["mueller"] }],
      fileIndex,
      sessionSearch: async workspace => { if (workspace.id === "other") throw new Error("database locked"); return { items: [{ kind: "sessions", id: "ses-1", workspaceId: workspace.id, title: "Fristen Müller", excerpt: "…Mietvertrag…", updatedAt: 9, messageId: "msg-1" }] }; },
      fileContentSearch: async workspace => workspace.id === "other" ? { items: [] } : ({ items: [{ kind: "files", id: "Notes.md", workspaceId: workspace.id, title: "Notes.md", excerpt: "mietvertrag", updatedAt: 3, sources: [{ path: "Notes.md", hash: "h", page: null, source: "native", quote: "Der Mietvertrag endet…" }] }], preparing: 1 }),
    };
    const all = await searchLauncher(deps, { query: "mietvertrag", kinds: ["files", "projects", "chats", "tasks", "recordings"], content: true, limit: 50 }, new AbortController().signal);
    expect(all.items.map(item => `${item.kind}:${item.id}`)).toEqual(["files:Mietvertrag Müller.docx", "tasks:task-1", "chats:ses-1", "recordings:rec-1", "files:Notes.md"]);
    expect(all.items[0]).toMatchObject({ match: "prefix", path: "Mietvertrag Müller.docx", actions: expect.arrayContaining(["chat-with-assistant", "compare"]) });
    expect(all.items[4]).toMatchObject({ match: "content", excerpt: "Der Mietvertrag endet…" });
    expect(all.items.find(item => item.kind === "tasks")).toMatchObject({ sourceKind: "project", subtitle: mueller.name });
    expect(all.items.find(item => item.kind === "chats")).toMatchObject({ sourceKind: "project", subtitle: mueller.name });
    expect(all.items.find(item => item.kind === "recordings")).toMatchObject({ sourceKind: "project", subtitle: mueller.name });
    const coverage = Object.fromEntries(all.sources.map(source => [source.id, source.coverage]));
    expect(coverage).toMatchObject({ "files:mueller": "indexing", "chats:mueller": "complete", "chats:other": "unavailable", tasks: "complete", recordings: "complete", projects: "partial", "unavailable:offline-project": "unavailable" });
    expect(all.sources.find(source => source.id === "chats:other")?.error).toBe("database locked");
    expect(all.unavailable).toEqual(["offline-project"]);
    const projects = await searchLauncher(deps, { query: "müler", kinds: ["projects"], content: false, limit: 10 }, new AbortController().signal);
    expect(projects.items.map(item => [item.id, item.match])).toEqual([["mueller", "fuzzy"]]);
    const dated = await searchLauncher({ ...deps, workspaces: async () => ({ workspaces: [mueller], unavailable: [] }),
      tasks: async () => [{ kind: "tasks", id: "old-task", workspaceId: "mueller", title: "Müller old task", excerpt: "", updatedAt: 3 }, { kind: "tasks", id: "recent-task", workspaceId: "mueller", title: "Müller recent task", excerpt: "", updatedAt: 8 }],
    }, { query: "Müller", kinds: ["projects", "tasks", "chats", "recordings"], modifiedAfter: 6, content: false, limit: 20 }, new AbortController().signal);
    expect(dated.items.map(item => item.id).sort()).toEqual(["mueller", "rec-1", "recent-task", "ses-1"].sort());
    const scoped = await searchLauncher(deps, { query: "", kinds: ["files", "recordings"], projectId: "other", content: false, limit: 10 }, new AbortController().signal);
    expect(scoped.items).toEqual([]);
    expect(scoped.sources.map(source => source.id)).toEqual(["recordings", "files:other", "unavailable:offline-project"]);
    const noRecorder = await searchLauncher({ ...deps, recordings: null }, { query: "x", kinds: ["recordings"], content: false, limit: 10 }, new AbortController().signal);
    expect(noRecorder.sources[0]).toMatchObject({ coverage: "unavailable", error: expect.stringContaining("desktop app") });
    const browseFiles = await searchLauncher(deps, { query: "", kinds: ["files"], content: false, limit: 10 }, new AbortController().signal);
    expect(browseFiles.items.map(item => item.title)).toContain("Mietvertrag Müller.docx");
    const chatQueries: string[] = [];
    const browseChats = await searchLauncher({ ...deps, sessionSearch: async (workspace, query, signal) => { chatQueries.push(query); return deps.sessionSearch(workspace, query, signal); } }, { query: "", kinds: ["chats"], content: false, limit: 10 }, new AbortController().signal);
    expect(chatQueries).toEqual(["", ""]);
    expect(browseChats.items.map(item => item.id)).toContain("ses-1");

    // Wiki workspaces supply files, but must never masquerade as projects.
    const wiki: WorkspaceInfo = { ...mueller, id: "wiki", name: "Müller Knowledge", preset: "wiki" };
    const withWiki: LauncherSearchDeps = { ...deps, workspaces: async () => ({ workspaces: [mueller, wiki], unavailable: [] }) };
    await fileIndex.ensure(wiki.id, root, true);
    const wikiResults = await searchLauncher(withWiki, { query: "Müller", kinds: ["projects", "files"], content: false, limit: 50 }, new AbortController().signal);
    expect(wikiResults.items.filter(item => item.kind === "projects").map(item => item.id)).toEqual([mueller.id]);
    expect(wikiResults.sources.find(source => source.id === "projects")?.count).toBe(1);
    expect(wikiResults.items.some(item => item.kind === "files" && item.workspaceId === wiki.id)).toBe(true);
    expect(wikiResults.items.filter(item => item.kind === "files" && item.workspaceId === wiki.id).every(item => item.sourceKind === "wiki")).toBe(true);
    expect(wikiResults.items.filter(item => item.kind === "files" && item.workspaceId === mueller.id).every(item => item.sourceKind === "project")).toBe(true);
    const wikiContent = await searchLauncher(withWiki, { query: "mietvertrag", kinds: ["files"], content: true, limit: 50 }, new AbortController().signal);
    expect(wikiContent.items.find(item => item.workspaceId === wiki.id && item.match === "content")?.sourceKind).toBe("wiki");
    const wikiBrowse = await browseLauncherDirectory({ root, path: "", workspaceId: wiki.id, sourceKind: "wiki", name: wiki.name });
    expect(wikiBrowse.items.length).toBeGreaterThan(0);
    expect(wikiBrowse.items.every(item => item.sourceKind === "wiki" && item.subtitle === wiki.name)).toBe(true);
    const readSources: string[] = [];
    for (const [sourceKind, workspaceId] of [["project", mueller.id], ["wiki", wiki.id]] satisfies ["project" | "wiki", string][]) {
      readSources.length = 0;
      const filtered = await searchLauncher({ ...withWiki, fileContentSearch: async (workspace, query, signal) => {
        readSources.push(workspace.id); return deps.fileContentSearch(workspace, query, signal);
      } }, { query: "mietvertrag", kinds: ["files"], content: true, limit: 1, sourceKind, fileTypes: ["md"], modifiedAfter: 2 }, new AbortController().signal);
      expect(readSources).toEqual([workspaceId]);
      expect(filtered.items).toHaveLength(1);
      expect(filtered.items[0]).toMatchObject({ id: "Notes.md", workspaceId, sourceKind, match: "content" });
      expect(filtered.sources.map(item => item.workspaceId)).toEqual([workspaceId]);
    }
    const foldersOnly = await searchLauncher(withWiki, { query: "", kinds: ["files"], content: false, limit: 50, sourceKind: "folder" }, new AbortController().signal);
    expect(foldersOnly.items).toEqual([]);
    expect(foldersOnly.sources).toEqual([]);
    const taskDeps: LauncherSearchDeps = { ...withWiki, tasks: async () => [
      { kind: "tasks", id: "z", workspaceId: mueller.id, title: "Zulu", updatedAt: 20, excerpt: "" },
      { kind: "tasks", id: "a", workspaceId: wiki.id, title: "Alpha", updatedAt: 10, excerpt: "" },
    ] };
    const alphabetical = await searchLauncher(taskDeps, { query: "", kinds: ["tasks"], content: false, limit: 1, sort: "name-asc" }, new AbortController().signal);
    expect(alphabetical.items.map(item => item.id)).toEqual(["a"]);
    expect(alphabetical.items[0]).toMatchObject({ sourceKind: "wiki", subtitle: wiki.name });
    const recent = await searchLauncher(taskDeps, { query: "", kinds: ["tasks"], content: false, limit: 1, sort: "recent" }, new AbortController().signal);
    expect(recent.items.map(item => item.id)).toEqual(["z"]);
  } finally { fileIndex.dispose(); await rm(root, { recursive: true, force: true }); }
});
