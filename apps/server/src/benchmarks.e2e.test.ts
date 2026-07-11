import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetBenchmarkStoreCache } from "./benchmarks/store.js";
import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const stops: Array<() => void | Promise<void>> = [];
const roots: string[] = [];
const ENV_KEYS = [
  "LEGALWORK_BENCHMARKS_DB",
  "LEGALWORK_BENCHMARKS_DIR",
  "LEGALWORK_GITHUB_API_BASE",
  "LEGALWORK_GITHUB_RAW_BASE",
  "LEGALWORK_BENCHMARK_POLL_MS",
  "LEGALWORK_BENCHMARK_ITEM_TIMEOUT_MS",
] as const;
const previousEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]] as const));

const SHA = "e2e0000000000000000000000000000000000000";

const HARVEY_TASK = {
  title: "Draft Tax Memo",
  work_type: "draft",
  tags: ["Tax"],
  instructions: "Draft the memo. Output: `memo.docx`.",
  deliverables: { "memo.docx": "memo.docx" },
  criteria: [
    { id: "C-001", title: "Memo exists", deliverables: ["memo.docx"], match_criteria: "PASS if the memo exists." },
  ],
};

// ---- mock GitHub -------------------------------------------------------------

let githubServer: ReturnType<typeof Bun.serve>;

// ---- mock opencode engine ----------------------------------------------------

type MockSession = { directory: string; state: "idle" | "busy" };
let opencodeServer: ReturnType<typeof Bun.serve>;
const mockSessions = new Map<string, MockSession>();
let sessionCounter = 0;

function startMockOpencode() {
  return Bun.serve({
    port: 0,
    fetch: async (request) => {
      const url = new URL(request.url);
      const path = url.pathname;
      const directory = decodeURIComponent(request.headers.get("x-opencode-directory") ?? "");

      if (request.method === "GET" && path === "/provider") {
        return Response.json({
          all: [
            { id: "prov", name: "Prov", source: "config", env: [], options: {}, models: { "model-a": { name: "Model A" } } },
            {
              id: "deepseek",
              name: "DeepSeek",
              source: "api",
              env: [],
              options: {},
              models: { "deepseek-v4-flash": { name: "DeepSeek V4 Flash" } },
            },
          ],
          default: {},
          connected: ["prov", "deepseek"],
        });
      }
      if (request.method === "POST" && path === "/session") {
        const id = `ses-${++sessionCounter}`;
        mockSessions.set(id, { directory, state: "idle" });
        return Response.json({ id, slug: id, projectID: "p", directory, title: "t", version: "1", time: { created: 1, updated: 1 } });
      }
      if (request.method === "GET" && path === "/session/status") {
        const map: Record<string, { type: string }> = {};
        for (const [id, session] of mockSessions) map[id] = { type: session.state };
        return Response.json(map);
      }
      const promptAsync = path.match(/^\/session\/([^/]+)\/prompt_async$/);
      if (request.method === "POST" && promptAsync) {
        const session = mockSessions.get(promptAsync[1]!)!;
        session.state = "busy";
        setTimeout(() => {
          writeFileSync(join(session.directory, "memo.docx"), "the memo");
          session.state = "idle";
        }, 30);
        return new Response(null, { status: 204 });
      }
      const message = path.match(/^\/session\/([^/]+)\/message$/);
      if (request.method === "GET" && message) {
        return Response.json([
          {
            info: { id: "msg-1", sessionID: message[1], role: "assistant", cost: 0.02, tokens: { input: 10, output: 5 } },
            parts: [],
          },
        ]);
      }
      if (request.method === "POST" && message) {
        const body = (await request.json()) as Record<string, unknown>;
        if (body.format) {
          // batched judge call → structured verdicts for every listed criterion
          const promptText = String(
            (body.parts as Array<{ text?: string }> | undefined)?.[0]?.text ?? "",
          );
          const criterionIds = Array.from(
            new Set(Array.from(promptText.matchAll(/### (C-\d+):/g), (match) => match[1]!)),
          );
          return Response.json({
            info: {
              id: "msg-judge",
              sessionID: message[1],
              role: "assistant",
              structured: {
                verdicts: criterionIds.map((id) => ({
                  id,
                  verdict: "pass",
                  reasoning: "deliverable satisfies the criterion",
                })),
              },
            },
            parts: [],
          });
        }
        return Response.json({ info: { id: "msg-x", sessionID: message[1], role: "assistant" }, parts: [] });
      }
      if (request.method === "POST" && /^\/session\/[^/]+\/abort$/.test(path)) {
        return Response.json(true);
      }
      if (request.method === "DELETE" && /^\/session\/[^/]+$/.test(path)) {
        return Response.json(true);
      }
      return new Response(`mock opencode: unhandled ${request.method} ${path}`, { status: 404 });
    },
  });
}

beforeAll(() => {
  githubServer = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/repos/harveyai/harvey-labs/commits/main") {
        return Response.json({ sha: SHA });
      }
      if (url.pathname === `/repos/harveyai/harvey-labs/git/trees/${SHA}`) {
        return Response.json({
          truncated: false,
          tree: [
            { path: "tasks/tax/draft-tax-memo/task.json", type: "blob", mode: "100644" },
            { path: "tasks/tax/draft-tax-memo/documents/input.docx", type: "blob", mode: "100644" },
          ],
        });
      }
      if (url.pathname === `/harveyai/harvey-labs/${SHA}/tasks/tax/draft-tax-memo/task.json`) {
        return Response.json(HARVEY_TASK);
      }
      if (url.pathname === `/harveyai/harvey-labs/${SHA}/tasks/tax/draft-tax-memo/documents/input.docx`) {
        return new Response("INPUT-DOC");
      }
      return new Response("not found", { status: 404 });
    },
  });
  opencodeServer = startMockOpencode();
  process.env.LEGALWORK_GITHUB_API_BASE = `http://127.0.0.1:${githubServer.port}`;
  process.env.LEGALWORK_GITHUB_RAW_BASE = `http://127.0.0.1:${githubServer.port}`;
  process.env.LEGALWORK_BENCHMARK_POLL_MS = "10";
  process.env.LEGALWORK_BENCHMARK_ITEM_TIMEOUT_MS = "10000";
});

afterAll(() => {
  githubServer.stop(true);
  opencodeServer.stop(true);
});

afterEach(async () => {
  while (stops.length) await stops.pop()?.();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
  for (const [key, value] of previousEnv) {
    if (["LEGALWORK_GITHUB_API_BASE", "LEGALWORK_GITHUB_RAW_BASE", "LEGALWORK_BENCHMARK_POLL_MS", "LEGALWORK_BENCHMARK_ITEM_TIMEOUT_MS"].includes(key)) continue;
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetBenchmarkStoreCache();
});

async function startLegalworkServer() {
  const root = await mkdtemp(join(tmpdir(), "legalwork-benchmarks-e2e-"));
  roots.push(root);
  process.env.LEGALWORK_BENCHMARKS_DB = join(root, "benchmarks.sqlite");
  process.env.LEGALWORK_BENCHMARKS_DIR = join(root, "benchmarks-data");
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  resetBenchmarkStoreCache();
  const workspaceRoot = join(root, "workspace");
  await Bun.write(join(workspaceRoot, ".keep"), "");
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 0,
    token: "owt_test_token",
    hostToken: "owt_host_token",
    approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"],
    workspaces: [
      {
        id: "ws_1",
        name: "Workspace",
        path: workspaceRoot,
        preset: "starter",
        workspaceType: "local",
        baseUrl: `http://127.0.0.1:${opencodeServer.port}`,
      },
    ],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
  };
  const server = await startServer(config);
  stops.push(() => server.stop());
  return { base: `http://127.0.0.1:${server.port}`, token: config.token, workspaceRoot };
}

function auth(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function json(response: Response, expected = 200) {
  const body = await response.json();
  expect(response.status).toBe(expected);
  return body as any;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("benchmark API end-to-end", () => {
  test("catalog, custom tasks, run lifecycle, results, delete", async () => {
    const { base, token, workspaceRoot } = await startLegalworkServer();

    // -- catalog
    const catalog = await json(await fetch(`${base}/workspace/ws_1/benchmarks/catalog`, { headers: auth(token) }));
    expect(catalog.ref).toBe(SHA);
    expect(catalog.items).toHaveLength(1);
    expect(catalog.verticals).toEqual([{ id: "tax", label: expect.any(String), count: 1 }]);
    expect(catalog.hydration.total).toBe(1);

    const taskPreview = await json(
      await fetch(
        `${base}/workspace/ws_1/benchmarks/catalog/task?key=${encodeURIComponent("tasks/tax/draft-tax-memo")}`,
        { headers: auth(token) },
      ),
    );
    expect(taskPreview.task.title).toBe("Draft Tax Memo");
    expect(taskPreview.task.workType).toBe("draft");

    // -- import the Harvey task into the workspace task table
    const imported = await json(
      await fetch(`${base}/workspace/ws_1/benchmarks/tasks/import`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({ keys: ["tasks/tax/draft-tax-memo", "tasks/nope/missing"] }),
      }),
    );
    expect(imported.items).toHaveLength(1);
    expect(imported.items[0]).toMatchObject({
      id: "tasks/tax/draft-tax-memo",
      source: "harvey",
      workType: "draft",
      docCount: 1,
    });
    expect(imported.failed).toHaveLength(1);

    // -- custom task with an uploaded document
    const customTask = await json(
      await fetch(`${base}/workspace/ws_1/benchmarks/tasks`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({
          title: "Review NDA",
          workType: "review",
          tags: ["Contracts"],
          instructions: "Review the NDA and write memo.docx.",
          deliverables: ["memo.docx"],
          criteria: [{ title: "Flags clause", matchCriteria: "PASS if the clause is flagged." }],
          documents: [{ name: "nda.txt", contentBase64: Buffer.from("the nda text").toString("base64") }],
        }),
      }),
      201,
    );
    expect(customTask.item.docCount).toBe(1);
    expect(customTask.item.criteria).toHaveLength(1);
    const customTaskId = customTask.item.id as string;

    const taskList = await json(await fetch(`${base}/workspace/ws_1/benchmarks/tasks`, { headers: auth(token) }));
    expect(taskList.items).toHaveLength(2);
    expect(taskList.items.every((item: { latestResults: unknown[] }) => item.latestResults.length === 0)).toBe(true);

    // -- task documents stage into the workspace so the file viewer can open them
    const harveyDocs = await json(
      await fetch(
        `${base}/workspace/ws_1/benchmarks/tasks/${encodeURIComponent("tasks/tax/draft-tax-memo")}/documents`,
        { headers: auth(token) },
      ),
    );
    expect(harveyDocs.items).toHaveLength(1);
    expect(harveyDocs.items[0]).toMatchObject({ name: "input.docx" });
    expect(existsSync(join(workspaceRoot, harveyDocs.items[0].relativePath))).toBe(true);

    const customDocs = await json(
      await fetch(`${base}/workspace/ws_1/benchmarks/tasks/${encodeURIComponent(customTaskId)}/documents`, {
        headers: auth(token),
      }),
    );
    expect(customDocs.items).toHaveLength(1);
    expect(customDocs.items[0]).toMatchObject({ name: "nda.txt" });

    // -- create a run: 2 tasks × 1 model, judge defaults to deepseek-v4-flash
    const created = await json(
      await fetch(`${base}/workspace/ws_1/benchmarks/runs`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({
          title: "E2E run",
          tasks: ["tasks/tax/draft-tax-memo", customTaskId],
          models: [{ providerID: "prov", modelID: "model-a" }],
          concurrency: 2,
        }),
      }),
      201,
    );
    const runId = created.run.id as string;
    expect(created.run.judgeModel).toEqual({ providerID: "deepseek", modelID: "deepseek-v4-flash" });
    expect(created.run.progress).toEqual({ completed: 0, total: 2 });

    // -- runs list contains it
    const list = await json(await fetch(`${base}/workspace/ws_1/benchmarks/runs`, { headers: auth(token) }));
    expect(list.items.map((item: { id: string }) => item.id)).toContain(runId);

    // -- poll progress until completed
    await waitFor(async () => {
      const progress = await json(
        await fetch(`${base}/workspace/ws_1/benchmarks/runs/${runId}/progress`, { headers: auth(token) }),
      );
      return progress.status === "completed";
    });

    // -- detail: both items passed, scores aggregated
    const detail = await json(await fetch(`${base}/workspace/ws_1/benchmarks/runs/${runId}`, { headers: auth(token) }));
    expect(detail.run.status).toBe("completed");
    expect(detail.run.aggregateScore).toBe(1);
    expect(detail.items).toHaveLength(2);
    for (const item of detail.items) {
      expect(item.status).toBe("passed");
      expect(item.nPassed).toBe(1);
      expect(item.sessionId).toBeTruthy();
    }
    const byModel = detail.run.scoreByModel as Array<{ providerID: string; passed: number }>;
    expect(byModel[0]).toMatchObject({ providerID: "prov", passed: 2 });

    // -- item detail with judge verdicts and deliverables
    const itemDetail = await json(
      await fetch(`${base}/workspace/ws_1/benchmarks/runs/${runId}/items/${detail.items[0].id}`, {
        headers: auth(token),
      }),
    );
    expect(itemDetail.verdicts).toHaveLength(1);
    expect(itemDetail.verdicts[0]).toMatchObject({ verdict: "pass", reasoning: expect.stringContaining("criterion") });
    expect(itemDetail.deliverables.deliverables[0].relativePath).toBe("memo.docx");
    expect(itemDetail.task.title).toBeTruthy();

    // scratch dirs live inside the workspace and are git-ignored
    expect(existsSync(join(workspaceRoot, ".legalwork", "benchmarks", ".gitignore"))).toBe(true);

    // -- the task table now reports these as the latest results per model
    const tasksAfterRun = await json(await fetch(`${base}/workspace/ws_1/benchmarks/tasks`, { headers: auth(token) }));
    for (const taskItem of tasksAfterRun.items) {
      expect(taskItem.latestResults).toHaveLength(1);
      expect(taskItem.latestResults[0]).toMatchObject({
        providerID: "prov",
        modelID: "model-a",
        status: "passed",
        runId,
      });
    }

    // -- delete cleans up
    await json(
      await fetch(`${base}/workspace/ws_1/benchmarks/runs/${runId}`, { method: "DELETE", headers: auth(token) }),
    );
    const gone = await fetch(`${base}/workspace/ws_1/benchmarks/runs/${runId}`, { headers: auth(token) });
    expect(gone.status).toBe(404);
    expect(existsSync(join(workspaceRoot, ".legalwork", "benchmarks", runId))).toBe(false);
  });

  test("rejects runs with unavailable models", async () => {
    const { base, token } = await startLegalworkServer();
    await json(
      await fetch(`${base}/workspace/ws_1/benchmarks/tasks/import`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({ keys: ["tasks/tax/draft-tax-memo"] }),
      }),
    );
    const response = await fetch(`${base}/workspace/ws_1/benchmarks/runs`, {
      method: "POST",
      headers: auth(token),
      body: JSON.stringify({
        tasks: ["tasks/tax/draft-tax-memo"],
        models: [{ providerID: "prov", modelID: "no-such-model" }],
      }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("benchmark_model_unavailable");
  });
});
