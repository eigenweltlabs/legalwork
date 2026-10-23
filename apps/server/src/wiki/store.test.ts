import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerConfig } from "../types.js";
import { WikiStore } from "./store.js";
import { StoredViewSchema } from "../views/schema.js";

const roots: string[] = [], stores: WikiStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-wiki-"));
  roots.push(root);
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "wiki-client", hostToken: "wiki-host", configPath: join(root, "config", "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  const store = new WikiStore(config);
  stores.push(store);
  return { root, config, store };
}

describe("Markdown wiki store", () => {
  test("duplicating a dashboard or its folder assigns new IDs but retains same-wiki live queries", async () => {
    const { store } = await fixture(), wiki = await store.create({ name: "Views", template: "blank" });
    const original = StoredViewSchema.parse({ version: 1, id: crypto.randomUUID(), updatedAt: 100, title: "Live overview", mode: "dashboard", catalog: "legalwork-1", program: 'root = Text("Overview")', queries: { rows: { fields: ["title"] } } });
    const bytes = Buffer.from(JSON.stringify(original));
    await store.writeAsset(wiki.id, "Dashboards/Overview.view.json", bytes, "");
    const file = await store.entry(wiki.id, "Dashboards/Overview.view.json");
    await store.changeEntry(wiki.id, { action: "copy", path: file.path, destination: "Dashboards/Overview copy.view.json", baseRevision: file.revision });
    const folder = await store.entry(wiki.id, "Dashboards");
    await store.changeEntry(wiki.id, { action: "copy", path: folder.path, destination: "Copies", baseRevision: folder.revision });
    const ids = new Set([original.id]);
    for (const path of ["Dashboards/Overview copy.view.json", "Copies/Overview.view.json", "Copies/Overview copy.view.json"]) {
      const copy = StoredViewSchema.parse(JSON.parse((await store.readAsset(wiki.id, path)).toString()));
      ids.add(copy.id); expect(copy.queries).toEqual(original.queries);
    }
    expect(ids.size).toBe(4);
    expect(await store.readAsset(wiki.id, file.path)).toEqual(bytes);
    await expect(store.changeEntry(wiki.id, { action: "copy", path: file.path, destination: "Wrong.json", baseRevision: file.revision })).rejects.toMatchObject({ code: "invalid_view_path" });
  });
  test("identifies default storage across canonical paths and keeps custom folders distinct", async () => {
    const { root, store } = await fixture();
    const managed = await store.create({ name: "Managed", template: "blank" });
    const custom = await store.create({ name: "Custom", template: "blank", root: join(root, "custom") });
    expect((await store.snapshot(managed.id)).wiki.isDefaultLocation).toBe(true);
    expect((await store.snapshot(custom.id)).wiki.isDefaultLocation).toBe(false);
    await store.update(managed.id, { name: "Renamed" });
    expect((await store.snapshot(managed.id)).wiki.isDefaultLocation).toBe(true);
  });

  test("wikis with the same name own distinct workspaces and retain them after rename and reopen", async () => {
    const { store, config } = await fixture();
    const first = await store.create({ name: "Firm knowledge" });
    const second = await store.create({ name: "Firm knowledge" });
    expect(second.workspaceId).not.toBe(first.workspaceId);
    expect(second.root).not.toBe(first.root);
    for (const wiki of [first, second]) {
      expect(config.workspaces.find(item => item.id === wiki.workspaceId)).toMatchObject({ path: wiki.root, preset: "wiki" });
    }
    await store.update(first.id, { name: "Renamed firm knowledge" });
    expect((await store.get(first.id)).workspaceId).toBe(first.workspaceId);
    await store.close();
    const reopened = new WikiStore(config);
    stores.push(reopened);
    expect((await reopened.list()).map(wiki => wiki.workspaceId)).toEqual([first.workspaceId, second.workspaceId]);
  });

  test("external agent batches update the watched tree, relations and indexed fields without a manual refresh", async () => {
    const { store } = await fixture(), wiki = await store.create({ name: "Import", template: "firm" });
    const before = (await store.graph(wiki.id, undefined, true)).revision;
    await writeFile(join(wiki.root, "Clients/C001.md"), "---\ntype: client\nclient_id: C001\n---\n# Example client\n");
    await writeFile(join(wiki.root, "Matters/M001.md"), '---\ntype: matter\nclient: "[[Clients/C001.md]]"\nstage: active\n---\n# Example matter\n');
    await mkdir(join(wiki.root, "Attachments/Batch 1"), { recursive: true });
    await writeFile(join(wiki.root, "Attachments/Batch 1/source.pdf"), Buffer.from([0, 255, 1]));
    let revision = before;
    for (let attempt = 0; attempt < 100 && revision === before; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      revision = (await store.graph(wiki.id, undefined, true)).revision;
    }
    expect(revision).not.toBe(before);
    const snapshot = await store.snapshot(wiki.id);
    expect(snapshot.pages.find(page => page.path === "Matters/M001.md")?.properties.stage).toBe("active");
    expect(snapshot.assets.some(file => file.path === "Attachments/Batch 1/source.pdf")).toBe(true);
    expect(snapshot.folders).toContain("Attachments/Batch 1");
    const graph = await store.graph(wiki.id);
    if (graph.kind !== "snapshot") throw new Error("Expected graph snapshot");
    expect(graph.edges.some(edge => edge.source === "Matters/M001.md" && edge.target === "Clients/C001.md")).toBe(true);
  });

  test("graph polling observes edits, assets, folders and configuration without returning rich snapshots", async () => {
    const { store } = await fixture(), wiki = await store.create({ name: "Graph", template: "blank" });
    const a = await store.write(wiki.id, "A.md", "# A\n[[B]]", "");
    await store.write(wiki.id, "B.md", "# B", "");
    const first = await store.graph(wiki.id);
    if (first.kind !== "snapshot") throw new Error("Expected initial graph");
    expect(first.nodes.map((node) => node.path)).toContain("A.md");
    expect(first.edges.some((edge) => edge.source === "A.md" && edge.target === "B.md")).toBe(true);
    expect(first.nodes.every((node) => node.properties !== undefined && !("excerpt" in node))).toBe(true);
    const contentBefore = (await store.graph(wiki.id, undefined, true)).revision;
    await store.write(wiki.id, "A.md", "# A\n[[B]]\nChanged body", a.revision);
    expect((await store.graph(wiki.id, undefined, true)).revision).not.toBe(contentBefore);
    expect(await store.graph(wiki.id, first.revision)).toEqual({ kind: "unchanged", revision: first.revision });
    let contentRevision = (await store.graph(wiki.id, undefined, true)).revision;
    await store.writeAsset(wiki.id, "scan.png", Buffer.from([0, 255]), "");
    expect((await store.graph(wiki.id, undefined, true)).revision).not.toBe(contentRevision);
    contentRevision = (await store.graph(wiki.id, undefined, true)).revision;
    await store.changeEntry(wiki.id, { action: "create-folder", path: "Empty" });
    expect((await store.graph(wiki.id, undefined, true)).revision).not.toBe(contentRevision);
    contentRevision = (await store.graph(wiki.id, undefined, true)).revision;
    await store.update(wiki.id, { name: "Renamed wiki" });
    expect((await store.graph(wiki.id, undefined, true)).revision).not.toBe(contentRevision);
    await writeFile(join(wiki.root, "B.md"), "# External edit");
    let external = await store.graph(wiki.id, first.revision);
    for (let attempt = 0; attempt < 30 && external.kind === "unchanged"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 20)); external = await store.graph(wiki.id, first.revision);
    }
    expect(external.kind).toBe("delta");
    if (external.kind !== "delta") throw new Error("Expected external change delta");
    expect(external.nodes.some((node) => node.title === "External edit")).toBe(true);
    await rm(join(wiki.root, "B.md"));
    // Explicit snapshots still reconcile immediately, even before a watcher event arrives.
    expect((await store.snapshot(wiki.id)).pages.some((page) => page.path === "B.md")).toBe(false);
    const removed = await store.graph(wiki.id, external.revision);
    if (removed.kind !== "delta") throw new Error("Expected removal delta");
    expect(removed.removedNodes).toContain("B.md"); expect(removed.removedEdges).toHaveLength(1);
  });

  test("file explorer creates empty nested folders and copies or moves complete folder contents", async () => {
    const { store } = await fixture(), wiki = await store.create({ name: "Explorer", template: "blank" });
    await store.changeEntry(wiki.id, { action: "create-folder", path: "Research/Empty" });
    expect((await store.snapshot(wiki.id)).folders).toContain("Research/Empty");
    const source = "---\nowner: Test\n---\n# Untouched\n";
    await store.write(wiki.id, "Research/Note.md", source, "");
    await store.write(wiki.id, "Research/Nested/Details.md", "# Details\n", "");
    const bytes = Buffer.from([0, 255, 12, 89]);
    await store.writeAsset(wiki.id, "Research/scan.png", bytes, "");
    const entry = await store.entry(wiki.id, "Research");
    await store.changeEntry(wiki.id, { action: "copy", path: entry.path, destination: "Research copy", baseRevision: entry.revision });
    expect((await store.read(wiki.id, "Research copy/Note.md")).content).toBe(source);
    expect((await store.read(wiki.id, "Research copy/Nested/Details.md")).content).toBe("# Details\n");
    expect(await store.readAsset(wiki.id, "Research copy/scan.png")).toEqual(bytes);
    expect((await store.snapshot(wiki.id)).folders).toContain("Research copy/Empty");
    await store.changeEntry(wiki.id, { action: "move", path: entry.path, destination: "Archive/Research", baseRevision: entry.revision });
    const snapshot = await store.snapshot(wiki.id);
    expect(snapshot.folders).toContain("Archive/Research/Empty");
    expect(snapshot.pages.some((page) => page.path === "Research/Note.md")).toBe(false);
    expect((await store.read(wiki.id, "Archive/Research/Note.md")).content).toBe(source);
    expect(await store.readAsset(wiki.id, "Archive/Research/scan.png")).toEqual(bytes);
    const file = await store.entry(wiki.id, "Archive/Research/Note.md");
    await store.changeEntry(wiki.id, { action: "copy", path: file.path, destination: "Note copy.md", baseRevision: file.revision });
    expect((await store.read(wiki.id, "Note copy.md")).content).toBe(source);
    await expect(store.changeEntry(wiki.id, { action: "copy", path: file.path, destination: "Note copy.md", baseRevision: file.revision })).rejects.toMatchObject({ code: "wiki_entry_exists" });
    expect((await store.read(wiki.id, "Note copy.md")).content).toBe(source);
  });

  test("folder actions reject stale revisions and occupied destinations without changing originals", async () => {
    const { store } = await fixture(), wiki = await store.create({ name: "Conflicts" });
    const page = await store.write(wiki.id, "Work/Note.md", "# Original\n", "");
    const original = await store.entry(wiki.id, "Work");
    await store.write(wiki.id, page.path, "# Newer\n", page.revision);
    await expect(store.changeEntry(wiki.id, { action: "trash", path: original.path, baseRevision: original.revision })).rejects.toMatchObject({ code: "wiki_revision_conflict" });
    await store.changeEntry(wiki.id, { action: "create-folder", path: "Occupied" });
    const fresh = await store.entry(wiki.id, "Work");
    await expect(store.changeEntry(wiki.id, { action: "copy", path: fresh.path, destination: "Occupied", baseRevision: fresh.revision })).rejects.toMatchObject({ status: 409, code: "wiki_entry_exists" });
    expect((await store.snapshot(wiki.id)).folders).toContain("Occupied");
    await expect(store.changeEntry(wiki.id, { action: "move", path: fresh.path, destination: "Occupied", baseRevision: fresh.revision })).rejects.toMatchObject({ status: 409, code: "wiki_entry_exists" });
    await expect(store.changeEntry(wiki.id, { action: "copy", path: fresh.path, destination: "Work/Nested", baseRevision: fresh.revision })).rejects.toMatchObject({ code: "invalid_wiki_destination" });
    expect((await store.read(wiki.id, page.path)).content).toBe("# Newer\n");
    expect(await store.trash(wiki.id)).toEqual([]);
  });

  test("trash and restore retain page bytes, binary assets and empty directories without overwriting newer files", async () => {
    const { store } = await fixture(), wiki = await store.create({ name: "Recover" });
    const page = await store.write(wiki.id, "Matter/Note.md", "# Kept verbatim\n", "");
    await store.writeAsset(wiki.id, "Matter/file.bin", Buffer.from([0, 255]), "");
    await store.changeEntry(wiki.id, { action: "create-folder", path: "Matter/Empty" });
    const entry = await store.entry(wiki.id, "Matter");
    await store.changeEntry(wiki.id, { action: "trash", path: entry.path, baseRevision: entry.revision });
    expect((await store.snapshot(wiki.id)).pages.some((item) => item.path === page.path)).toBe(false);
    expect((await store.files(wiki.id)).some((item) => item.path.includes("legalwork-trash"))).toBe(false);
    const [deleted] = await store.trash(wiki.id);
    expect(deleted?.path).toBe("Matter");
    await store.changeEntry(wiki.id, { action: "create-folder", path: "Matter" });
    await expect(store.changeEntry(wiki.id, { action: "restore", trashId: deleted.id })).rejects.toMatchObject({ status: 409, code: "wiki_entry_exists" });
    expect(await store.trash(wiki.id)).toHaveLength(1);
    await rm(join(wiki.root, "Matter"), { recursive: true });
    await store.changeEntry(wiki.id, { action: "restore", trashId: deleted.id });
    expect((await store.read(wiki.id, page.path)).content).toBe(page.content);
    expect(await store.readAsset(wiki.id, "Matter/file.bin")).toEqual(Buffer.from([0, 255]));
    expect((await store.snapshot(wiki.id)).folders).toContain("Matter/Empty");
    expect(await store.trash(wiki.id)).toEqual([]);
  });

  test("file actions reject traversal and symbolic links, including links inside folders", async () => {
    const { store, root } = await fixture(), wiki = await store.create({ name: "Safety" });
    const page = await store.write(wiki.id, "Work/Note.md", "# Original\n", "");
    const file = await store.entry(wiki.id, page.path);
    await expect(store.changeEntry(wiki.id, { action: "copy", path: page.path, destination: "../Outside.md", baseRevision: file.revision })).rejects.toMatchObject({ status: 400 });
    await symlink(root, join(wiki.root, "Work/Escape"), "dir");
    await expect(store.entry(wiki.id, "Work")).rejects.toMatchObject({ code: "unsafe_wiki_path" });
    await expect(store.changeEntry(wiki.id, { action: "create-folder", path: "Work/Escape/Created" })).rejects.toMatchObject({ code: "unsafe_wiki_path" });
    expect((await store.read(wiki.id, page.path)).content).toBe(page.content);
  });

  test("creates portable starter files, registers a wiki workspace, and forgets without deleting content", async () => {
    const { root, config, store } = await fixture();
    const wiki = await store.create({ name: "VC knowledge", root: join(root, "content"), template: "firm" });
    expect(config.workspaces.find((workspace) => workspace.id === wiki.workspaceId)?.path).toBe(wiki.root);
    const registry = await readFile(store.path, "utf8");
    expect(registry).toContain("wikis:");
    const configMarkdown = await readFile(join(wiki.root, "Wiki.md"), "utf8");
    expect(configMarkdown).toContain("VC knowledge");
    expect(configMarkdown).not.toContain("workspaceId");
    expect(configMarkdown).not.toContain(wiki.root);
    const snapshot = await store.snapshot(wiki.id);
    expect(snapshot.pages.some((page) => page.path === "Structure.md")).toBe(true);
    expect(snapshot.pages.some((page) => page.path === "Skills/wiki-capture/SKILL.md")).toBe(true);
    expect(snapshot.pages.some((page) => page.path === "Skills/wiki-setup/SKILL.md")).toBe(true);
    const original = await store.write(wiki.id, "Recover.md", "# Recover\n", "");
    await store.forget(wiki.id);
    expect(await store.list()).toEqual([]);
    expect(await readFile(join(wiki.root, "Structure.md"), "utf8")).toContain("How this wiki is organized");
    const reattached = await store.create({ name: "Reattached", root: wiki.root, attach: true });
    expect(reattached.id).toBe(wiki.id);
    expect((await store.history(reattached.id, original.path))).toHaveLength(1);
  });

  test("attaching to a shared folder preserves local originals and seeds no starter files", async () => {
    const { root, store } = await fixture();
    const folder = join(root, "existing");
    await mkdir(folder);
    await writeFile(join(folder, "Original.md"), "# Original\n");
    const wiki = await store.create({ name: "Shared", root: folder, attach: true, sync: { workspaceId: "project", connectionId: "team", path: "Knowledge" } });
    expect((await store.files(wiki.id)).map((file) => file.path)).toEqual(["Original.md"]);
    expect(await readFile(join(folder, "Original.md"), "utf8")).toBe("# Original\n");
  });

  test("project selection persists in the registry and wiki/project folder overlaps fail safely", async () => {
    const { root, config, store } = await fixture();
    const project = join(root, "project");
    await mkdir(project);
    config.workspaces.push({ id: "project", name: "Project", path: project, preset: "starter", workspaceType: "local" });
    await expect(store.create({ name: "Nested", root: join(project, "Wiki") })).rejects.toMatchObject({ status: 409, code: "wiki_workspace_overlap" });
    const wiki = await store.create({ name: "Independent", root: join(root, "independent") });
    await store.update(wiki.id, { projectWorkspaceIds: ["project"] });
    expect((await store.get(wiki.id)).projectWorkspaceIds).toEqual(["project"]);
    await store.update(wiki.id, { projectWorkspaceIds: [] });
    expect((await store.get(wiki.id)).projectWorkspaceIds).toEqual([]);
    await store.update(wiki.id, { projectWorkspaceIds: null });
    expect((await store.get(wiki.id)).projectWorkspaceIds).toBe(null);
    config.workspaces.push({ id: "bypass", name: "Bypass", path: wiki.root, preset: "starter", workspaceType: "local" });
    await expect(store.list()).rejects.toMatchObject({ status: 409, code: "wiki_workspace_overlap" });
  });

  test("indexes properties, body and property links, resolves aliases, and searches full content", async () => {
    const { store } = await fixture(), wiki = await store.create({ name: "Index" });
    const source = "---\ntype: process\nowner: '[[People/Ada.md]]'\npractice: venture\nreviewed: 2026-10-07\n---\n# Financing\n\nSee [[Partner]] and [Ada](../People/Ada.md).\n\nLiquidation preferences.\n";
    await store.write(wiki.id, "Processes/Financing.md", source, "");
    await store.write(wiki.id, "People/Ada.md", "---\naliases: [Partner]\ntype: person\n---\n# Ada\n", "");
    await store.write(wiki.id, "People/Other.md", "# Ada\n", "");
    const snapshot = await store.snapshot(wiki.id), page = snapshot.pages.find((item) => item.path === "Processes/Financing.md");
    expect(page?.properties.reviewed).toBe("2026-10-07");
    expect(page?.links).toHaveLength(3);
    expect(page?.links.every((link) => link.resolved && link.target === "People/Ada.md")).toBe(true);
    expect(page?.links.find((link) => link.property === "owner")).toBeDefined();
    expect((await store.search(wiki.id, "Liquidation", "process")).map((item) => item.path)).toEqual(["Processes/Financing.md"]);
    expect((await store.search(wiki.id, 'preferences" OR *', "process"))).toEqual([]);
    expect((await store.read(wiki.id, "Processes/Financing.md")).content).toBe(source);
    const imported = "\uFEFF---\r\ntype: deal\r\nstage: closing\r\n...\r\n# Imported deal\r\n";
    await store.write(wiki.id, "Imported.md", imported, "");
    expect((await store.snapshot(wiki.id)).pages.find((item) => item.path === "Imported.md")?.properties.stage).toBe("closing");
    expect((await store.read(wiki.id, "Imported.md")).content).toBe(imported);
  });

  test("serialized compare-and-save rejects stale edits and simultaneous creations", async () => {
    const { store } = await fixture(), wiki = await store.create({ name: "Concurrency" });
    const initial = await store.write(wiki.id, "Concurrent.md", "# Original\n", "");
    const writes = await Promise.allSettled([
      store.write(wiki.id, "Concurrent.md", "# First\n", initial.revision),
      store.write(wiki.id, "Concurrent.md", "# Second\n", initial.revision),
    ]);
    expect(writes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(writes.filter((item) => item.status === "rejected")).toHaveLength(1);
    await expect(store.write(wiki.id, "Concurrent.md", "# Overwrite\n", "")).rejects.toMatchObject({ status: 409 });
    await expect(store.remove(wiki.id, "Concurrent.md", initial.revision)).rejects.toMatchObject({ status: 409 });
    const creates = await Promise.allSettled([store.write(wiki.id, "New.md", "A", ""), store.write(wiki.id, "New.md", "B", "")]);
    expect(creates.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  });

  test("retired view definitions remain ordinary editable metadata without a snapshot projection", async () => {
    const { store } = await fixture(), wiki = await store.create({ name: "Views" });
    const source = "---\nviews:\n  - name: Deals\n    type: kanban\n    filter: { type: deal, practice: venture }\n    columns: [lead, closing, completed]\n    groupBy: stage\n---\n# My deal board\n";
    await store.write(wiki.id, "Views/Deals.md", source, "");
    const first = await store.snapshot(wiki.id);
    expect(first).not.toHaveProperty("views");
    expect((await store.read(wiki.id, "Views/Deals.md")).content).toBe(source);
    expect(first.pages.find(page => page.path === "Views/Deals.md")?.properties.views).toEqual([{ name: "Deals", type: "kanban", filter: { type: "deal", practice: "venture" }, columns: ["lead", "closing", "completed"], groupBy: "stage" }]);
    await writeFile(join(wiki.root, "Views/Deals.md"), source.replace("practice: venture", "practice: litigation"));
    const next = await store.snapshot(wiki.id);
    expect(next.pages.find(page => page.path === "Views/Deals.md")?.revision).not.toBe(first.pages.find(page => page.path === "Views/Deals.md")?.revision);
    expect((await store.read(wiki.id, "Views/Deals.md")).content).toBe(source.replace("practice: venture", "practice: litigation"));
  });

  test("records external edits and deletions, recovers deleted pages, and keeps history across restarts", async () => {
    const { store, config } = await fixture(), wiki = await store.create({ name: "History" });
    await store.write(wiki.id, "History.md", "# First\n", "");
    await writeFile(join(wiki.root, "History.md"), "# External edit\n");
    const external = await store.snapshot(wiki.id);
    expect(external.pages.find((page) => page.path === "History.md")?.title).toBe("External edit");
    await rm(join(wiki.root, "History.md"));
    expect((await store.snapshot(wiki.id)).pages.some((page) => page.path === "History.md")).toBe(false);
    const history = await store.history(wiki.id, "History.md");
    expect(history.map((revision) => revision.action)).toEqual(["delete", "write", "write"]);
    expect((await store.history(wiki.id)).some((revision) => revision.path === "History.md" && revision.action === "delete")).toBe(true);
    const first = history[history.length - 1];
    const restored = await store.restore(wiki.id, "History.md", first.id, "");
    expect(restored.content).toBe("# First\n");
    await store.close();
    const reopened = new WikiStore(config);
    stores.push(reopened);
    expect((await reopened.snapshot(wiki.id)).pages.find((page) => page.path === "History.md")?.title).toBe("First");
    expect((await reopened.history(wiki.id, "History.md"))[0].action).toBe("restore");
    const other = await reopened.create({ name: "Other" });
    await expect(reopened.restore(other.id, "History.md", first.id, "")).rejects.toMatchObject({ status: 404 });
  });

  test("rejects traversal, hidden paths and symlink escapes for pages and assets", async () => {
    const { root, store } = await fixture(), wiki = await store.create({ name: "Safety" });
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "Secret.md"), "secret");
    await symlink(outside, join(wiki.root, "Escape"), "dir");
    await symlink(join(outside, "Secret.md"), join(wiki.root, "Linked.md"));
    for (const path of ["../Secret.md", "/etc/passwd", "Folder/../../Secret.md", ".opencode/config.md", "Folder\\Secret.md"]) {
      await expect(store.readAsset(wiki.id, path)).rejects.toMatchObject({ status: 400 });
      await expect(store.write(wiki.id, path, "bad", "")).rejects.toMatchObject({ status: 400 });
    }
    await expect(store.read(wiki.id, "Escape/Secret.md")).rejects.toMatchObject({ status: 403 });
    await expect(store.write(wiki.id, "Escape/New.md", "bad", "")).rejects.toMatchObject({ status: 403 });
    await expect(store.read(wiki.id, "Linked.md")).rejects.toMatchObject({ status: 403 });
    expect((await store.snapshot(wiki.id)).warnings.join(" ")).toContain("symbolic links");
    expect(await readFile(join(outside, "Secret.md"), "utf8")).toBe("secret");
  });

  test("asset bytes round-trip with compare-and-save and malformed YAML stays editable", async () => {
    const { store } = await fixture(), wiki = await store.create({ name: "Assets" });
    const bytes = Buffer.from([0, 255, 137, 80, 78, 71]);
    await store.writeAsset(wiki.id, "Attachments/scan.png", bytes, "");
    expect(await store.readAsset(wiki.id, "Attachments/scan.png")).toEqual(bytes);
    await expect(store.writeAsset(wiki.id, "Attachments/scan.png", Buffer.from("overwrite"), "")).rejects.toMatchObject({ status: 409 });
    expect((await store.snapshot(wiki.id)).assets.find((asset) => asset.path === "Attachments/scan.png")?.size).toBe(bytes.length);
    const invalid = "---\ntype: [broken\n---\n# Still editable\n";
    await store.write(wiki.id, "Broken.md", invalid, "");
    expect((await store.read(wiki.id, "Broken.md")).content).toBe(invalid);
    expect((await store.snapshot(wiki.id)).warnings.some((warning) => warning.startsWith("Broken.md:"))).toBe(true);
  });
});

test("deleted wikis restore their files, history, identity and settings after restart", async () => {
  const { store, config } = await fixture();
  const wiki = await store.create({ name: "Restore me", template: "firm" });
  await store.write(wiki.id, "Note.md", "# Retained content", "");
  await store.writeAsset(wiki.id, "scan.pdf", Buffer.from([0, 1, 255]), "");
  await store.update(wiki.id, { allowInProjects: false });
  await store.archive(wiki.id);
  expect(await store.list()).toEqual([]);
  expect(config.workspaces.some(item => item.id === wiki.workspaceId)).toBe(false);
  await expect(store.read(wiki.id, "Note.md")).rejects.toMatchObject({ status: 404 });
  expect(await store.deleted()).toMatchObject([{ wiki: { id: wiki.id, allowInProjects: false } }]);
  await expect(store.create({ name: "Duplicate", root: wiki.root, attach: true })).rejects.toMatchObject({ status: 409 });
  const other = await store.create({ name: "Unrelated" });
  await store.forget(other.id);
  await store.close();
  const reopened = new WikiStore(config); stores.push(reopened);
  const restored = await reopened.restoreWiki(wiki.id);
  expect(restored.workspaceId).toBe(wiki.workspaceId);
  expect(restored.root).toBe(wiki.root);
  expect(restored.allowInProjects).toBe(false);
  expect((await reopened.read(wiki.id, "Note.md")).content).toBe("# Retained content");
  expect(await readFile(join(wiki.root, "scan.pdf"))).toEqual(Buffer.from([0, 1, 255]));
  expect((await reopened.history(wiki.id, "Note.md")).length).toBeGreaterThan(0);
  expect(await reopened.deleted()).toEqual([]);
});

test("full text search ranks titles, finds deep body passages, phrases, prefixes and Unicode without raw FTS injection", async () => {
  const { store } = await fixture(), wiki = await store.create({ name: "Search", template: "blank" });
  await store.write(wiki.id, "A.md", "# Notes\n\n" + "Background information. ".repeat(200) + "\nA fiduciary duty arises in this relationship. Übertragung prüfen.\n", "");
  await store.write(wiki.id, "B.md", "# Fiduciary duties\n\nPractical guidance for trustees.\n", "");
  await store.write(wiki.id, "C.md", "# Another note\n\nA duty about fiduciary responsibilities.\n", "");
  const ranked = await store.search(wiki.id, "fiduciar");
  expect(ranked[0].path).toBe("B.md");
  expect(ranked.find(page => page.path === "A.md")?.excerpt).toContain("fiduciary duty");
  expect(ranked.find(page => page.path === "A.md")?.excerpt.length).toBeLessThan(600);
  expect((await store.search(wiki.id, '"fiduciary duty"')).map(page => page.path)).toEqual(["A.md"]);
  expect((await store.search(wiki.id, "Übertragung")).map(page => page.path)).toEqual(["A.md"]);
  expect(await store.search(wiki.id, '" OR * NEAR( --')).toEqual([]);
  expect(await store.search(wiki.id, "!!!")).toEqual([]);
});
