import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCatalogItems,
  catalogVerticals,
  ensureHarveyDocuments,
  filterCatalogItems,
  getHarveyTask,
  hydrateHarveyTasks,
  hydrationStatus,
  loadHarveyIndex,
} from "./harvey-catalog.js";
import { BenchmarkStore } from "./store.js";

const TASK_A = {
  title: "Draft Tax Memo",
  work_type: "draft",
  tags: ["Tax", "memo"],
  instructions: "Draft the memo. Output: `memo.docx`.",
  deliverables: { "memo.docx": "memo.docx" },
  criteria: [{ id: "C-001", title: "Has header", deliverables: ["memo.docx"], match_criteria: "PASS if header." }],
};

const TASK_B = {
  title: "Analyze NDA",
  work_type: "analyze",
  tags: ["Contracts"],
  instructions: "Analyze the NDA. Output: `analysis.md`.",
  deliverables: { "analysis.md": "analysis.md" },
  criteria: [{ id: "C-001", title: "Flags clause", deliverables: ["analysis.md"], match_criteria: "PASS if clause flagged." }],
};

let ghServer: ReturnType<typeof Bun.serve>;
let requestLog: string[] = [];
let dir: string;
let store: BenchmarkStore;
const HEAD_SHA = "shaaaaaa1111111111111111111111111111111a";
let sha = HEAD_SHA;

const TREE_PATHS = [
  "tax/draft-tax-memo/task.json",
  "tax/draft-tax-memo/documents/input.docx",
  "tax/draft-tax-memo/documents/nested/data.xlsx",
  "contracts/analyze-nda/task.json",
  "contracts/broken-task/task.json",
];

/** Verticals whose recursive tree listing the fake GitHub reports as truncated. */
let truncatedShas = new Set<string>();

const TASKS_SHA = "treeeeee2222222222222222222222222222222b";
/** Vertical directory shas, keyed by the vertical name under `tasks/`. */
const VERTICAL_SHAS: Record<string, string> = {
  tax: "treeeeee3333333333333333333333333333333c",
  contracts: "treeeeee4444444444444444444444444444444d",
};

/** Blobs under one subtree, as paths relative to it. */
function blobsUnder(prefix: string): string[] {
  if (!prefix) return TREE_PATHS;
  return TREE_PATHS.filter((path) => path.startsWith(`${prefix}/`)).map((path) =>
    path.slice(prefix.length + 1),
  );
}

/** The direct children of one subtree, git-tree style (one level only). */
function childrenOf(
  prefix: string,
  shas: Record<string, string>,
): Array<{ path: string; type: string; sha: string; mode?: string }> {
  const names = new Set(blobsUnder(prefix).map((path) => path.split("/")[0]!));
  return Array.from(names).map((name) =>
    shas[name]
      ? { path: name, type: "tree", sha: shas[name]! }
      : { path: name, type: "blob", sha: `blob-${prefix}-${name}`, mode: "100644" },
  );
}

beforeAll(() => {
  ghServer = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requestLog.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/repos/harveyai/harvey-labs/commits/main") {
        return Response.json({ sha });
      }
      // Repo root: only the `tasks` tree is walked from here.
      if (url.pathname === `/repos/harveyai/harvey-labs/git/trees/${sha}`) {
        return Response.json({
          truncated: false,
          tree: [
            { path: "README.md", type: "blob", sha: "blob-readme", mode: "100644" },
            { path: "tasks", type: "tree", sha: TASKS_SHA },
          ],
        });
      }
      if (url.pathname === `/repos/harveyai/harvey-labs/git/trees/${TASKS_SHA}`) {
        const recursive = url.searchParams.get("recursive") === "1";
        if (recursive && truncatedShas.has(TASKS_SHA)) {
          return Response.json({ truncated: true, tree: [] });
        }
        return recursive
          ? Response.json({
              truncated: false,
              tree: TREE_PATHS.map((path) => ({ path, type: "blob", sha: `blob-${path}`, mode: "100644" })),
            })
          : Response.json({ truncated: false, tree: childrenOf("", VERTICAL_SHAS) });
      }
      for (const [vertical, verticalSha] of Object.entries(VERTICAL_SHAS)) {
        if (url.pathname !== `/repos/harveyai/harvey-labs/git/trees/${verticalSha}`) continue;
        return Response.json({
          truncated: false,
          tree: blobsUnder(vertical).map((path) => ({
            path,
            type: "blob",
            sha: `blob-${vertical}-${path}`,
            mode: "100644",
          })),
        });
      }
      if (url.pathname === `/harveyai/harvey-labs/${sha}/tasks/tax/draft-tax-memo/task.json`) {
        return Response.json(TASK_A);
      }
      if (url.pathname === `/harveyai/harvey-labs/${sha}/tasks/contracts/analyze-nda/task.json`) {
        return Response.json(TASK_B);
      }
      if (url.pathname === `/harveyai/harvey-labs/${sha}/tasks/contracts/broken-task/task.json`) {
        return Response.json({ title: "broken", work_type: "unknown" });
      }
      if (url.pathname === `/harveyai/harvey-labs/${sha}/tasks/tax/draft-tax-memo/documents/input.docx`) {
        return new Response("DOCX-BYTES");
      }
      if (url.pathname === `/harveyai/harvey-labs/${sha}/tasks/tax/draft-tax-memo/documents/nested/data.xlsx`) {
        return new Response("XLSX-BYTES");
      }
      return new Response("not found", { status: 404 });
    },
  });
  const base = `http://127.0.0.1:${ghServer.port}`;
  process.env.LEGALWORK_GITHUB_API_BASE = base;
  process.env.LEGALWORK_GITHUB_RAW_BASE = base;
});

afterAll(() => {
  ghServer.stop(true);
  delete process.env.LEGALWORK_GITHUB_API_BASE;
  delete process.env.LEGALWORK_GITHUB_RAW_BASE;
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "harvey-catalog-"));
  store = await BenchmarkStore.open(join(dir, "benchmarks.sqlite"));
  requestLog = [];
  truncatedShas = new Set();
  sha = HEAD_SHA;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("loadHarveyIndex", () => {
  test("builds and caches the index from the git tree", async () => {
    const index = await loadHarveyIndex(store);
    expect(index.ref).toBe(sha);
    expect(index.entries.map((entry) => entry.key)).toEqual([
      "tasks/contracts/analyze-nda",
      "tasks/contracts/broken-task",
      "tasks/tax/draft-tax-memo",
    ]);
    const memo = index.entries.find((entry) => entry.key === "tasks/tax/draft-tax-memo");
    expect(memo?.documents.sort()).toEqual(["input.docx", "nested/data.xlsx"]);
    expect(memo?.vertical).toBe("tax");

    // Second call is served entirely from the SQLite cache.
    const apiCalls = requestLog.length;
    const again = await loadHarveyIndex(store);
    expect(again.ref).toBe(sha);
    expect(requestLog.length).toBe(apiCalls);
  });

  test("falls back to a level-by-level walk when GitHub truncates the recursive tree", async () => {
    truncatedShas.add(TASKS_SHA);
    const index = await loadHarveyIndex(store);
    expect(index.entries.map((entry) => entry.key)).toEqual([
      "tasks/contracts/analyze-nda",
      "tasks/contracts/broken-task",
      "tasks/tax/draft-tax-memo",
    ]);
    const memo = index.entries.find((entry) => entry.key === "tasks/tax/draft-tax-memo");
    expect(memo?.documents.sort()).toEqual(["input.docx", "nested/data.xlsx"]);
    // The truncated recursive listing is retried shallowly, then per vertical.
    expect(requestLog).toContain(`/repos/harveyai/harvey-labs/git/trees/${TASKS_SHA}`);
    expect(requestLog).toContain(`/repos/harveyai/harvey-labs/git/trees/${VERTICAL_SHAS.tax}?recursive=1`);
  });

  test("reuses cached subtree listings across commits when the tree sha is unchanged", async () => {
    truncatedShas.add(TASKS_SHA);
    await loadHarveyIndex(store);

    // A new commit whose `tasks` tree is untouched: the walk hits the tree cache
    // and never refetches a vertical.
    sha = "shaaaaaa9999999999999999999999999999999z";
    requestLog = [];
    const index = await loadHarveyIndex(store, { refresh: true });
    expect(index.ref).toBe(sha);
    expect(index.entries).toHaveLength(3);
    expect(requestLog.filter((path) => path.includes(VERTICAL_SHAS.tax!))).toEqual([]);
  });

  test("refresh re-resolves head but reuses the index when the sha is unchanged", async () => {
    await loadHarveyIndex(store);
    requestLog = [];
    await loadHarveyIndex(store, { refresh: true });
    expect(requestLog).toEqual(["/repos/harveyai/harvey-labs/commits/main"]);
  });
});

describe("hydrateHarveyTasks", () => {
  test("fetches, normalizes and caches task.json; reports failures", async () => {
    const index = await loadHarveyIndex(store);
    const result = await hydrateHarveyTasks(store, index.ref, [
      "tasks/tax/draft-tax-memo",
      "tasks/contracts/broken-task",
      "tasks/missing/task",
    ]);
    expect(result.tasks.get("tasks/tax/draft-tax-memo")?.workType).toBe("draft");
    expect(result.failed).toHaveLength(2);
    expect(hydrationStatus(store, index)).toEqual({ hydrated: 1, total: 3 });

    // Cached on second hydrate — no new raw fetches.
    requestLog = [];
    const second = await hydrateHarveyTasks(store, index.ref, ["tasks/tax/draft-tax-memo"]);
    expect(second.tasks.size).toBe(1);
    expect(requestLog).toHaveLength(0);
  });

  test("getHarveyTask throws a 404 ApiError for unloadable tasks", async () => {
    const index = await loadHarveyIndex(store);
    await expect(getHarveyTask(store, index.ref, "tasks/missing/task")).rejects.toThrow(
      /Could not load benchmark task/,
    );
  });
});

describe("ensureHarveyDocuments", () => {
  test("downloads documents into the pinned cache and skips existing files", async () => {
    const index = await loadHarveyIndex(store);
    const entry = index.entries.find((item) => item.key === "tasks/tax/draft-tax-memo")!;
    const config = { configPath: join(dir, "config.json") };

    const docsDir = await ensureHarveyDocuments(config, index.ref, entry);
    expect(docsDir).toBeTruthy();
    expect(readFileSync(join(docsDir!, "input.docx"), "utf8")).toBe("DOCX-BYTES");
    expect(readFileSync(join(docsDir!, "nested", "data.xlsx"), "utf8")).toBe("XLSX-BYTES");

    requestLog = [];
    await ensureHarveyDocuments(config, index.ref, entry);
    expect(requestLog).toHaveLength(0);

    const noDocs = index.entries.find((item) => item.key === "tasks/contracts/analyze-nda")!;
    expect(await ensureHarveyDocuments(config, index.ref, noDocs)).toBeNull();
  });

  test("rejects unsafe document paths", async () => {
    const config = { configPath: join(dir, "config.json") };
    const entry = { key: "tasks/tax/evil", vertical: "tax", name: "evil", documents: ["../../escape.txt"] };
    await expect(ensureHarveyDocuments(config, sha, entry)).rejects.toThrow(/Unsafe document path/);
    expect(existsSync(join(dir, "escape.txt"))).toBe(false);
  });
});

describe("catalog items and filters", () => {
  test("buildCatalogItems merges hydration state and labels", async () => {
    const index = await loadHarveyIndex(store);
    await hydrateHarveyTasks(store, index.ref, ["tasks/tax/draft-tax-memo"]);
    const cached = new Map([["tasks/tax/draft-tax-memo", (await getHarveyTask(store, index.ref, "tasks/tax/draft-tax-memo"))]]);
    const items = buildCatalogItems(index, cached);

    const memo = items.find((item) => item.key === "tasks/tax/draft-tax-memo")!;
    expect(memo.hydrated).toBe(true);
    expect(memo.title).toBe("Draft Tax Memo");
    expect(memo.workType).toBe("draft");
    expect(memo.verticalLabel).toBe("Tax");
    expect(memo.docCount).toBe(2);

    const nda = items.find((item) => item.key === "tasks/contracts/analyze-nda")!;
    expect(nda.hydrated).toBe(false);
    expect(nda.title).toBeUndefined();
    expect(nda.verticalLabel).toBe("Contracts");
  });

  test("filterCatalogItems facets and search", async () => {
    const index = await loadHarveyIndex(store);
    await hydrateHarveyTasks(store, index.ref, ["tasks/tax/draft-tax-memo", "tasks/contracts/analyze-nda"]);
    const cached = new Map(
      store.listCachedTasks(index.ref).map(({ taskKey, taskJson }) => [taskKey, JSON.parse(taskJson)]),
    );
    const items = buildCatalogItems(index, cached);

    expect(filterCatalogItems(items, { verticals: ["tax"] })).toHaveLength(1);
    expect(filterCatalogItems(items, { workTypes: ["analyze"] }).map((item) => item.key)).toEqual([
      "tasks/contracts/analyze-nda",
    ]);
    // workType filter excludes unhydrated items (broken-task never hydrated)
    expect(filterCatalogItems(items, { workTypes: ["draft", "analyze"] })).toHaveLength(2);
    expect(filterCatalogItems(items, { search: "tax memo" })).toHaveLength(1);
    expect(filterCatalogItems(items, { search: "ZZZ" })).toHaveLength(0);
    expect(filterCatalogItems(items, {})).toHaveLength(3);

    const verticals = catalogVerticals(items);
    expect(verticals).toEqual([
      { id: "contracts", label: "Contracts", count: 2 },
      { id: "tax", label: "Tax", count: 1 },
    ]);
  });
});
