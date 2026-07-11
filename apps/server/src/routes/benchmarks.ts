import { readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { ApiError } from "../errors.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { shortId } from "../utils.js";
import {
  benchmarksDataDir,
  buildCatalogItems,
  catalogVerticals,
  ensureHarveyDocuments,
  filterCatalogItems,
  getHarveyTask,
  hydrateHarveyTasks,
  hydrationStatus,
  loadHarveyIndex,
  startBackgroundHydration,
  type CatalogItem,
} from "../benchmarks/harvey-catalog.js";
import type { BenchmarkLatestResultRow, BenchmarkStore, BenchmarkTaskRow } from "../benchmarks/store.js";
import { removeTaskDocumentsScratchDir, stageTaskDocuments } from "../benchmarks/workdir.js";
import { buildTasksZip, MAX_ZIP_TASKS, parseTasksZip } from "../benchmarks/task-zip.js";
import { aggregateModelAnalytics } from "../benchmarks/analytics.js";
import type { BenchmarkRunner } from "../benchmarks/runner.js";
import {
  BENCHMARK_WORK_TYPES,
  isHarveyTaskKey,
  parseCustomTaskInput,
  parseStoredTaskJson,
  type BenchmarkWorkType,
} from "../benchmarks/task-schema.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;
type ParseOptionalBoolean = (value: string | null, name: string) => boolean | undefined;
type ParseOptionalPositiveInteger = (value: string | null, name: string) => number | undefined;
type ParseOptionalNonNegativeInteger = (value: string | null, name: string) => number | undefined;

export interface RegisterBenchmarkRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  parseOptionalBoolean: ParseOptionalBoolean;
  parseOptionalPositiveInteger: ParseOptionalPositiveInteger;
  parseOptionalNonNegativeInteger: ParseOptionalNonNegativeInteger;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  getStore: () => Promise<BenchmarkStore>;
  runner: BenchmarkRunner;
}

function parseListParam(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseWorkTypesParam(value: string | null): BenchmarkWorkType[] {
  const items = parseListParam(value);
  for (const item of items) {
    if (!(BENCHMARK_WORK_TYPES as readonly string[]).includes(item)) {
      throw new ApiError(400, "invalid_query", `workType must be one of ${BENCHMARK_WORK_TYPES.join(", ")}`);
    }
  }
  return items as BenchmarkWorkType[];
}

async function countFiles(dir: string | null): Promise<number> {
  if (!dir) return 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries.filter((entry) => entry.isFile()).length;
  } catch {
    return 0;
  }
}

async function serializeTask(
  row: BenchmarkTaskRow,
  latestResults: BenchmarkLatestResultRow[] = [],
): Promise<Record<string, unknown>> {
  const tags = (JSON.parse(row.tagsJson) as string[]) ?? [];
  const criteria = JSON.parse(row.criteriaJson) as unknown[];
  let docCount = 0;
  if (row.source === "harvey") {
    try {
      docCount = (JSON.parse(row.harveyDocumentsJson ?? "[]") as string[]).length;
    } catch {
      docCount = 0;
    }
  } else {
    docCount = await countFiles(row.documentsDir);
  }
  return {
    id: row.id,
    source: row.source,
    title: row.title,
    workType: row.workType,
    tags,
    instructions: row.instructions,
    deliverables: JSON.parse(row.deliverablesJson),
    criteria,
    criteriaCount: Array.isArray(criteria) ? criteria.length : 0,
    docCount,
    catalogRef: row.catalogRef,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    latestResults: latestResults.map((result) => ({
      providerID: result.providerID,
      modelID: result.modelID,
      status: result.status,
      score: result.score,
      nCriteria: result.nCriteria,
      nPassed: result.nPassed,
      itemId: result.itemId,
      runId: result.runId,
      runCreatedAt: result.runCreatedAt,
      finishedAt: result.finishedAt,
    })),
  };
}

type CustomDocumentInput = { name: string; contentBase64: string };

function parseDocumentsField(body: Record<string, unknown>): CustomDocumentInput[] | null {
  if (body.documents === undefined) return null;
  if (!Array.isArray(body.documents)) {
    throw new ApiError(400, "invalid_payload", "documents must be an array");
  }
  const documents: CustomDocumentInput[] = [];
  for (const item of body.documents) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Record<string, unknown>).name !== "string" ||
      typeof (item as Record<string, unknown>).contentBase64 !== "string"
    ) {
      throw new ApiError(400, "invalid_payload", "each document needs a name and contentBase64");
    }
    const name = basename(((item as Record<string, unknown>).name as string).trim());
    if (!name || name.startsWith(".")) {
      throw new ApiError(400, "invalid_payload", `invalid document name: ${name}`);
    }
    documents.push({ name, contentBase64: (item as Record<string, unknown>).contentBase64 as string });
  }
  return documents;
}

async function writeCustomTaskDocuments(
  config: ServerConfig,
  taskId: string,
  documents: CustomDocumentInput[],
): Promise<string | null> {
  const documentsDir = join(benchmarksDataDir(config), "custom-tasks", taskId, "documents");
  await rm(documentsDir, { recursive: true, force: true });
  if (!documents.length) return null;
  await mkdir(documentsDir, { recursive: true });
  for (const document of documents) {
    await writeFile(join(documentsDir, document.name), Buffer.from(document.contentBase64, "base64"));
  }
  return documentsDir;
}

export function registerBenchmarkRoutes(options: RegisterBenchmarkRoutesOptions): void {
  const {
    routes,
    config,
    jsonResponse,
    readJsonBody,
    parseOptionalBoolean,
    parseOptionalPositiveInteger,
    parseOptionalNonNegativeInteger,
    ensureWritable,
    requireClientScope,
    resolveWorkspace,
    getStore,
    runner,
  } = options;

  // ---- Harvey catalog -------------------------------------------------------

  addRoute(routes, "GET", "/workspace/:id/benchmarks/catalog", "client", async (ctx) => {
    await resolveWorkspace(config, ctx.params.id);
    const store = await getStore();
    const refresh = parseOptionalBoolean(ctx.url.searchParams.get("refresh"), "refresh") ?? false;
    const index = await loadHarveyIndex(store, { refresh });
    startBackgroundHydration(store, index);

    const cachedTasks = new Map(
      store
        .listCachedTasks(index.ref)
        .flatMap(({ taskKey, taskJson }) => {
          const task = parseStoredTaskJson(taskJson);
          return task ? [[taskKey, task] as const] : [];
        }),
    );
    const items = buildCatalogItems(index, cachedTasks);
    const filtered = filterCatalogItems(items, {
      verticals: parseListParam(ctx.url.searchParams.get("vertical")),
      workTypes: parseWorkTypesParam(ctx.url.searchParams.get("workType")),
      search: ctx.url.searchParams.get("search") ?? undefined,
    });
    return jsonResponse({
      ref: index.ref,
      verticals: catalogVerticals(items),
      items: filtered,
      hydration: hydrationStatus(store, index),
    });
  });

  addRoute(routes, "GET", "/workspace/:id/benchmarks/catalog/task", "client", async (ctx) => {
    await resolveWorkspace(config, ctx.params.id);
    const key = (ctx.url.searchParams.get("key") ?? "").trim();
    if (!isHarveyTaskKey(key)) {
      throw new ApiError(400, "invalid_query", "key must look like tasks/<vertical>/<task-name>");
    }
    const store = await getStore();
    const index = await loadHarveyIndex(store);
    const task = await getHarveyTask(store, index.ref, key);
    return jsonResponse({ key, ref: index.ref, task });
  });

  // ---- Task table (imported Harvey tasks + custom tasks) ---------------------

  addRoute(routes, "GET", "/workspace/:id/benchmarks/tasks", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const store = await getStore();
    const resultsByTask = new Map<string, BenchmarkLatestResultRow[]>();
    for (const result of store.latestResults(workspace.id)) {
      const list = resultsByTask.get(result.taskKey) ?? [];
      list.push(result);
      resultsByTask.set(result.taskKey, list);
    }
    const items = await Promise.all(
      store.listTasks(workspace.id).map((row) => serializeTask(row, resultsByTask.get(row.id) ?? [])),
    );
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/benchmarks/analytics", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const store = await getStore();
    const tags = parseListParam(ctx.url.searchParams.get("tags"));
    return jsonResponse(aggregateModelAnalytics(store.modelAnalyticsRows(workspace.id), tags));
  });

  addRoute(routes, "POST", "/workspace/:id/benchmarks/tasks/import", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const keys = Array.isArray(body.keys)
      ? body.keys.filter((key): key is string => typeof key === "string" && isHarveyTaskKey(key.trim()))
      : [];
    if (!keys.length || keys.length > 2000) {
      throw new ApiError(400, "invalid_payload", "keys must be 1–2000 Harvey task keys");
    }
    const store = await getStore();
    const index = await loadHarveyIndex(store);
    const entriesByKey = new Map(index.entries.map((entry) => [entry.key, entry]));
    const unknown = keys.filter((key) => !entriesByKey.has(key));
    const { tasks, failed } = await hydrateHarveyTasks(
      store,
      index.ref,
      keys.filter((key) => entriesByKey.has(key)),
    );
    const now = Date.now();
    const imported: BenchmarkTaskRow[] = [];
    for (const [key, task] of tasks) {
      const entry = entriesByKey.get(key)!;
      const row: BenchmarkTaskRow = {
        workspaceId: workspace.id,
        id: key,
        source: "harvey",
        title: task.title,
        workType: task.workType,
        tagsJson: JSON.stringify(task.tags),
        instructions: task.instructions,
        deliverablesJson: JSON.stringify(task.deliverables),
        criteriaJson: JSON.stringify(task.criteria),
        harveyDocumentsJson: JSON.stringify(entry.documents),
        catalogRef: index.ref,
        documentsDir: null,
        createdAt: now,
        updatedAt: now,
      };
      store.upsertTask(row);
      imported.push(row);
    }
    const items = await Promise.all(imported.map((row) => serializeTask(row)));
    return jsonResponse({
      items,
      failed: [...failed, ...unknown.map((key) => ({ key, error: "unknown task key" }))],
    });
  });

  addRoute(routes, "POST", "/workspace/:id/benchmarks/tasks", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const parsed = parseCustomTaskInput(body);
    if (!parsed.ok) {
      throw new ApiError(400, "invalid_payload", parsed.error);
    }
    const documents = parseDocumentsField(body) ?? [];
    const store = await getStore();
    const id = `ct_${Date.now().toString(36)}_${shortId().slice(0, 8)}`;
    const documentsDir = await writeCustomTaskDocuments(config, id, documents);
    const now = Date.now();
    store.upsertTask({
      workspaceId: workspace.id,
      id,
      source: "custom",
      title: parsed.task.title,
      workType: parsed.task.workType,
      tagsJson: JSON.stringify(parsed.task.tags),
      instructions: parsed.task.instructions,
      deliverablesJson: JSON.stringify(parsed.task.deliverables),
      criteriaJson: JSON.stringify(parsed.task.criteria),
      harveyDocumentsJson: null,
      catalogRef: null,
      documentsDir,
      createdAt: now,
      updatedAt: now,
    });
    const row = store.getTask(workspace.id, id);
    return jsonResponse({ item: row ? await serializeTask(row) : null }, 201);
  });

  addRoute(routes, "PUT", "/workspace/:id/benchmarks/tasks/:taskId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const store = await getStore();
    const taskId = (ctx.params.taskId ?? "").trim();
    const existing = store.getTask(workspace.id, taskId);
    if (!existing) {
      throw new ApiError(404, "benchmark_task_not_found", "Benchmark task not found");
    }
    if (existing.source !== "custom") {
      throw new ApiError(400, "benchmark_task_readonly", "Imported Legal Agent Benchmark tasks cannot be edited");
    }
    const body = await readJsonBody(ctx.request);
    const parsed = parseCustomTaskInput(body);
    if (!parsed.ok) {
      throw new ApiError(400, "invalid_payload", parsed.error);
    }
    const documents = parseDocumentsField(body);
    let documentsDir = existing.documentsDir;
    if (documents !== null) {
      documentsDir = await writeCustomTaskDocuments(config, taskId, documents);
    }
    store.upsertTask({
      ...existing,
      title: parsed.task.title,
      workType: parsed.task.workType,
      tagsJson: JSON.stringify(parsed.task.tags),
      instructions: parsed.task.instructions,
      deliverablesJson: JSON.stringify(parsed.task.deliverables),
      criteriaJson: JSON.stringify(parsed.task.criteria),
      documentsDir,
      updatedAt: Date.now(),
    });
    const row = store.getTask(workspace.id, taskId);
    return jsonResponse({ item: row ? await serializeTask(row) : null });
  });

  addRoute(routes, "GET", "/workspace/:id/benchmarks/tasks/:taskId/documents", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const store = await getStore();
    const taskId = (ctx.params.taskId ?? "").trim();
    const row = store.getTask(workspace.id, taskId);
    if (!row) {
      throw new ApiError(404, "benchmark_task_not_found", "Benchmark task not found");
    }
    let sourceDir: string | null = null;
    if (row.source === "custom") {
      sourceDir = row.documentsDir;
    } else if (row.catalogRef) {
      let documents: string[] = [];
      try {
        documents = JSON.parse(row.harveyDocumentsJson ?? "[]");
      } catch {
        documents = [];
      }
      if (documents.length) {
        sourceDir = await ensureHarveyDocuments(config, row.catalogRef, {
          key: row.id,
          vertical: row.id.split("/")[1] ?? "",
          name: row.id.split("/")[2] ?? row.id,
          documents,
        });
      }
    }
    const items = await stageTaskDocuments(workspace.path, row.id, sourceDir);
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/benchmarks/tasks/:taskId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const store = await getStore();
    const taskId = (ctx.params.taskId ?? "").trim();
    const existing = store.getTask(workspace.id, taskId);
    if (!existing) {
      throw new ApiError(404, "benchmark_task_not_found", "Benchmark task not found");
    }
    store.deleteTask(workspace.id, taskId);
    await removeTaskDocumentsScratchDir(workspace.path, taskId);
    if (existing.source === "custom") {
      await rm(join(benchmarksDataDir(config), "custom-tasks", taskId), { recursive: true, force: true });
    }
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "POST", "/workspace/:id/benchmarks/tasks/export", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const ids = Array.isArray(body.taskIds)
      ? body.taskIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      : [];
    if (!ids.length || ids.length > MAX_ZIP_TASKS) {
      throw new ApiError(400, "invalid_payload", `taskIds must be 1–${MAX_ZIP_TASKS} task ids`);
    }
    const store = await getStore();
    const rows: BenchmarkTaskRow[] = [];
    for (const id of ids) {
      const row = store.getTask(workspace.id, id.trim());
      if (row) rows.push(row);
    }
    if (!rows.length) {
      throw new ApiError(404, "benchmark_task_not_found", "None of the requested tasks exist.");
    }
    const zip = await buildTasksZip(config, rows);
    const filename = rows.length === 1 ? `${rows[0].id.split("/").pop() ?? "task"}.zip` : "benchmark-tasks.zip";
    return new Response(Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength) as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
        "Content-Length": String(zip.byteLength),
      },
    });
  });

  addRoute(routes, "POST", "/workspace/:id/benchmarks/tasks/import-zip", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    if (typeof body.zipBase64 !== "string" || !body.zipBase64.trim()) {
      throw new ApiError(400, "invalid_payload", "zipBase64 is required");
    }
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(Buffer.from(body.zipBase64, "base64"));
    } catch {
      throw new ApiError(400, "invalid_payload", "zipBase64 is not valid base64");
    }
    const { tasks, failed } = parseTasksZip(bytes);
    const store = await getStore();
    const imported: BenchmarkTaskRow[] = [];
    for (const parsed of tasks) {
      const id = `ct_${Date.now().toString(36)}_${shortId().slice(0, 8)}`;
      const documents: CustomDocumentInput[] = parsed.documents.map((document) => ({
        name: document.name,
        contentBase64: Buffer.from(document.bytes).toString("base64"),
      }));
      const documentsDir = await writeCustomTaskDocuments(config, id, documents);
      const now = Date.now();
      store.upsertTask({
        workspaceId: workspace.id,
        id,
        source: "custom",
        title: parsed.definition.title,
        workType: parsed.definition.workType,
        tagsJson: JSON.stringify(parsed.definition.tags),
        instructions: parsed.definition.instructions,
        deliverablesJson: JSON.stringify(parsed.definition.deliverables),
        criteriaJson: JSON.stringify(parsed.definition.criteria),
        harveyDocumentsJson: null,
        catalogRef: null,
        documentsDir,
        createdAt: now,
        updatedAt: now,
      });
      const row = store.getTask(workspace.id, id);
      if (row) imported.push(row);
    }
    const items = await Promise.all(imported.map((row) => serializeTask(row)));
    return jsonResponse({ items, failed });
  });

  // ---- Runs -----------------------------------------------------------------

  addRoute(routes, "POST", "/workspace/:id/benchmarks/runs", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const run = await runner.createRun(workspace, body);
    return jsonResponse({ run }, 201);
  });

  addRoute(routes, "GET", "/workspace/:id/benchmarks/runs", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await runner.listRuns(workspace, {
      limit: parseOptionalPositiveInteger(ctx.url.searchParams.get("limit"), "limit"),
      start: parseOptionalNonNegativeInteger(ctx.url.searchParams.get("start"), "start"),
    });
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/benchmarks/runs/:runId", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const detail = await runner.getRunDetail(workspace, (ctx.params.runId ?? "").trim());
    return jsonResponse(detail);
  });

  addRoute(routes, "GET", "/workspace/:id/benchmarks/runs/:runId/progress", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const progress = await runner.getRunProgress(workspace, (ctx.params.runId ?? "").trim());
    return jsonResponse(progress);
  });

  addRoute(routes, "GET", "/workspace/:id/benchmarks/runs/:runId/items/:itemId", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const item = await runner.getItemDetail(workspace, (ctx.params.runId ?? "").trim(), (ctx.params.itemId ?? "").trim());
    return jsonResponse(item);
  });

  addRoute(routes, "POST", "/workspace/:id/benchmarks/runs/:runId/abort", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const run = await runner.abortRun(workspace, (ctx.params.runId ?? "").trim());
    return jsonResponse({ run });
  });

  addRoute(routes, "POST", "/workspace/:id/benchmarks/runs/:runId/resume", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const run = await runner.resumeRun(workspace, (ctx.params.runId ?? "").trim());
    return jsonResponse({ run });
  });

  addRoute(routes, "DELETE", "/workspace/:id/benchmarks/runs/:runId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    await runner.deleteRun(workspace, (ctx.params.runId ?? "").trim());
    return jsonResponse({ ok: true });
  });
}

export type { CatalogItem };
