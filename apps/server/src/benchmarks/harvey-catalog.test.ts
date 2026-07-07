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
let sha = "shaaaaaa1111111111111111111111111111111a";

const TREE_PATHS = [
  "README.md",
  "tasks/tax/draft-tax-memo/task.json",
  "tasks/tax/draft-tax-memo/documents/input.docx",
  "tasks/tax/draft-tax-memo/documents/nested/data.xlsx",
  "tasks/contracts/analyze-nda/task.json",
  "tasks/contracts/broken-task/task.json",
];

beforeAll(() => {
  ghServer = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requestLog.push(url.pathname);
      if (url.pathname === "/repos/harveyai/harvey-labs/commits/main") {
        return Response.json({ sha });
      }
      if (url.pathname === `/repos/harveyai/harvey-labs/git/trees/${sha}`) {
        return Response.json({
          truncated: false,
          tree: TREE_PATHS.map((path) => ({ path, type: "blob", mode: "100644" })),
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
