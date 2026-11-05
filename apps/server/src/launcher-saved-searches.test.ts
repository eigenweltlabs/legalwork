import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SavedSearchStore, savedSearchCatalogEntries } from "./launcher-saved-searches.js";

test("saved searches keep their scope, deduplicate the same search and join the catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "saved-searches-"));
  try {
    const store = await SavedSearchStore.open(join(root, "runtime.sqlite"));
    const lease = store.create({ name: "Mietverträge Müller", query: "Mietvertrag", kind: "files", projectId: "mueller" }, 1000);
    expect(store.create({ name: "Again", query: "Mietvertrag", kind: "files", projectId: "mueller" }, 1001).id).toBe(lease.id);
    const filtered = store.create({ name: "Recent PDFs", query: "Mietvertrag", kind: "files", projectId: "mueller", fileTypes: ["pdf"], modifiedAfter: 1000 }, 999);
    expect(filtered.id).not.toBe(lease.id);
    expect(store.get(filtered.id)).toMatchObject({ fileTypes: ["pdf"], modifiedAfter: 1000 });
    const wiki = store.create({ name: "Wiki contracts", query: "Mietvertrag", kind: "files", projectId: null, sourceKind: "wiki" });
    const project = store.create({ name: "Project contracts", query: "Mietvertrag", kind: "files", projectId: null, sourceKind: "project" });
    expect(wiki.id).not.toBe(project.id);
    expect(store.get(wiki.id)?.sourceKind).toBe("wiki");
    expect(store.create({ name: "Again", query: "Mietvertrag", kind: "files", projectId: null, sourceKind: "wiki" }).id).toBe(wiki.id);
    store.remove(wiki.id); store.remove(project.id);
    store.remove(filtered.id);
    expect(() => store.create({ name: "Empty", query: "", kind: null, projectId: null })).toThrow("needs words");
    const open = store.create({ name: "Open tasks", query: "", kind: "tasks", projectId: null }, 1002);
    store.recordUse(open.id, 2000);
    expect(store.list().map(search => search.id)).toEqual([open.id, lease.id]);
    const catalog = savedSearchCatalogEntries(store.list(), id => (id === "mueller" ? "Müller ./. Huber" : null));
    expect(catalog[1]).toMatchObject({ id: `saved-search:${lease.id}`, kind: "navigation", source: "saved-search", workspaceId: "mueller", description: "files · Müller ./. Huber · “Mietvertrag”" });
    expect(catalog[0].description).toBe("tasks");
    store.remove(lease.id);
    expect(() => store.remove(lease.id)).toThrow("no longer exists");
  } finally { await rm(root, { recursive: true, force: true }); }
});
