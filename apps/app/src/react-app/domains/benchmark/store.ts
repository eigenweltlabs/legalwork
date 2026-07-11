import { create } from "zustand";
import type { LegalworkServerClient } from "../../../app/lib/legalwork-server";
import type {
  BenchmarkAnalytics,
  BenchmarkCatalogItem,
  BenchmarkCustomTaskInput,
  BenchmarkItemDetail,
  BenchmarkModelRef,
  BenchmarkRunCreateInput,
  BenchmarkRunDetail,
  BenchmarkRunSummary,
  BenchmarkTaskDefinition,
  BenchmarkTaskDocument,
  BenchmarkTaskItem,
} from "../../../app/lib/benchmark-types";
import { DEFAULT_JUDGE_MODEL } from "../../../app/lib/benchmark-types";
import { isRunActive } from "./format";
import {
  EMPTY_TABLE_FILTERS,
  EMPTY_TASK_FILTERS,
  type BenchmarkTaskFilters,
  type TaskTableFilters,
} from "./filter-tasks";

/**
 * The server is the source of truth — nothing here persists to localStorage.
 * The non-serializable client + workspace context stays out of zustand state
 * (same precedent as sessionGroupSyncHandler in session-management-store.ts).
 */
let benchmarkClient: LegalworkServerClient | null = null;
let benchmarkWorkspaceId = "";

export function attachBenchmarkContext(client: LegalworkServerClient | null, workspaceId: string): void {
  // Reset only when the workspace actually changes. The parent shell recreates
  // the client object on unrelated re-renders; treating that as a context change
  // would wipe loaded runs/tasks mid-view (blanking the screen). We still adopt
  // the latest client reference for subsequent API calls.
  const workspaceChanged = benchmarkWorkspaceId !== workspaceId;
  benchmarkClient = client;
  benchmarkWorkspaceId = workspaceId;
  if (workspaceChanged) {
    useBenchmarkStore.getState().reset();
  }
}

function context(): { client: LegalworkServerClient; workspaceId: string } | null {
  if (!benchmarkClient || !benchmarkWorkspaceId.trim()) return null;
  return { client: benchmarkClient, workspaceId: benchmarkWorkspaceId.trim() };
}

/** For components (e.g. the document viewer) that need direct client access outside store actions. */
export function getBenchmarkContext(): { client: LegalworkServerClient; workspaceId: string } | null {
  return context();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Save downloaded bytes to disk via a synthetic anchor (browser/Electron renderer). */
function triggerDownload(data: ArrayBuffer, filename: string): void {
  if (typeof document === "undefined") return;
  const url = URL.createObjectURL(new Blob([data], { type: "application/zip" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

const RUNS_POLL_MS = 5_000;
const DETAIL_POLL_MS = 2_500;
const CATALOG_POLL_MS = 3_000;

let runsPollHandle: ReturnType<typeof setInterval> | null = null;
let detailPollHandle: ReturnType<typeof setInterval> | null = null;
let catalogPollHandle: ReturnType<typeof setInterval> | null = null;
let runsPollInFlight = false;
let detailPollInFlight = false;
let catalogPollInFlight = false;

type LoadStatus = "idle" | "loading" | "ready" | "error";

type BenchmarkState = {
  // task table
  tasks: BenchmarkTaskItem[];
  tasksStatus: LoadStatus;
  tasksError: string | null;
  selectedTaskIds: string[];
  filters: TaskTableFilters;
  taskDocuments: Record<string, BenchmarkTaskDocument[]>;
  taskDocumentsLoading: string | null;
  exporting: boolean;
  exportError: string | null;

  // runs
  runs: BenchmarkRunSummary[];
  runsStatus: LoadStatus;
  runsError: string | null;
  activeRun: BenchmarkRunDetail | null;
  activeRunStatus: LoadStatus;
  activeRunError: string | null;
  itemDetails: Record<string, BenchmarkItemDetail>;
  itemDetailLoading: string | null;

  // cross-run model analytics (Models tab)
  analytics: BenchmarkAnalytics | null;
  analyticsStatus: LoadStatus;
  analyticsError: string | null;
  analyticsTags: string[];

  // Legal Agent Benchmark catalog (import modal)
  catalogRef: string | null;
  catalogItems: BenchmarkCatalogItem[];
  catalogVerticals: Array<{ id: string; label: string; count: number }>;
  catalogHydration: { hydrated: number; total: number } | null;
  catalogStatus: LoadStatus;
  catalogError: string | null;
  importFilters: BenchmarkTaskFilters;
  importSelection: string[];
  importing: boolean;
  importError: string | null;
  catalogPreviews: Record<string, BenchmarkTaskDefinition>;
  catalogPreviewLoading: string | null;

  // start-run draft
  draft: { name: string; models: BenchmarkModelRef[]; judge: BenchmarkModelRef | null };
  creating: boolean;
  createError: string | null;
};

type BenchmarkActions = {
  reset(): void;

  refreshTasks(): Promise<void>;
  setFilters(patch: Partial<TaskTableFilters>): void;
  toggleTaskSelection(taskId: string): void;
  setTaskSelection(taskIds: string[]): void;
  clearTaskSelection(): void;
  loadTaskDocuments(taskId: string): Promise<void>;
  createTask(input: BenchmarkCustomTaskInput): Promise<BenchmarkTaskItem | null>;
  updateTask(taskId: string, input: BenchmarkCustomTaskInput): Promise<BenchmarkTaskItem | null>;
  deleteTask(taskId: string): Promise<void>;
  deleteTasks(taskIds: string[]): Promise<void>;
  exportTasks(taskIds: string[]): Promise<boolean>;
  importTasksZip(zipBase64: string): Promise<number>;

  refreshRuns(): Promise<void>;
  startRunsPolling(): void;
  stopRunsPolling(): void;
  loadRun(runId: string): Promise<void>;
  clearActiveRun(): void;
  startDetailPolling(runId: string): void;
  stopDetailPolling(): void;
  abortRun(runId: string): Promise<void>;
  resumeRun(runId: string): Promise<void>;
  deleteRun(runId: string): Promise<void>;
  loadItemDetail(runId: string, itemId: string): Promise<void>;

  loadAnalytics(): Promise<void>;
  setAnalyticsTags(tags: string[]): void;

  ensureCatalog(): Promise<void>;
  refreshCatalog(): Promise<void>;
  startCatalogPolling(): void;
  stopCatalogPolling(): void;
  setImportFilters(patch: Partial<BenchmarkTaskFilters>): void;
  toggleImportSelection(key: string): void;
  setImportSelection(keys: string[]): void;
  importSelected(): Promise<number>;
  loadCatalogPreview(key: string): Promise<void>;

  toggleModel(ref: BenchmarkModelRef): void;
  setJudge(ref: BenchmarkModelRef | null): void;
  setDraftName(name: string): void;
  resetDraft(): void;
  createRun(): Promise<BenchmarkRunSummary | null>;
};

const INITIAL_STATE: BenchmarkState = {
  tasks: [],
  tasksStatus: "idle",
  tasksError: null,
  selectedTaskIds: [],
  filters: EMPTY_TABLE_FILTERS,
  taskDocuments: {},
  taskDocumentsLoading: null,
  exporting: false,
  exportError: null,
  runs: [],
  runsStatus: "idle",
  runsError: null,
  activeRun: null,
  activeRunStatus: "idle",
  activeRunError: null,
  itemDetails: {},
  itemDetailLoading: null,
  analytics: null,
  analyticsStatus: "idle",
  analyticsError: null,
  analyticsTags: [],
  catalogRef: null,
  catalogItems: [],
  catalogVerticals: [],
  catalogHydration: null,
  catalogStatus: "idle",
  catalogError: null,
  importFilters: EMPTY_TASK_FILTERS,
  importSelection: [],
  importing: false,
  importError: null,
  catalogPreviews: {},
  catalogPreviewLoading: null,
  draft: { name: "", models: [], judge: null },
  creating: false,
  createError: null,
};

function sameModel(a: BenchmarkModelRef, b: BenchmarkModelRef): boolean {
  return a.providerID === b.providerID && a.modelID === b.modelID;
}

export const useBenchmarkStore = create<BenchmarkState & BenchmarkActions>()((set, get) => ({
  ...INITIAL_STATE,

  reset() {
    get().stopRunsPolling();
    get().stopDetailPolling();
    get().stopCatalogPolling();
    set(INITIAL_STATE);
  },

  // ---- task table -----------------------------------------------------------

  async refreshTasks() {
    const ctx = context();
    if (!ctx) return;
    if (get().tasksStatus === "idle") set({ tasksStatus: "loading" });
    try {
      const { items } = await ctx.client.benchmarkListTasks(ctx.workspaceId);
      const knownIds = new Set(items.map((item) => item.id));
      set((state) => ({
        tasks: items,
        tasksStatus: "ready",
        tasksError: null,
        selectedTaskIds: state.selectedTaskIds.filter((id) => knownIds.has(id)),
      }));
    } catch (error) {
      set({ tasksStatus: "error", tasksError: errorMessage(error) });
    }
  },

  setFilters(patch) {
    set((state) => ({ filters: { ...state.filters, ...patch } }));
  },

  toggleTaskSelection(taskId) {
    set((state) => ({
      selectedTaskIds: state.selectedTaskIds.includes(taskId)
        ? state.selectedTaskIds.filter((id) => id !== taskId)
        : [...state.selectedTaskIds, taskId],
    }));
  },

  setTaskSelection(taskIds) {
    set({ selectedTaskIds: Array.from(new Set(taskIds)) });
  },

  clearTaskSelection() {
    set({ selectedTaskIds: [] });
  },

  async loadTaskDocuments(taskId) {
    const ctx = context();
    if (!ctx || get().taskDocuments[taskId]) return;
    set({ taskDocumentsLoading: taskId });
    try {
      const { items } = await ctx.client.benchmarkGetTaskDocuments(ctx.workspaceId, taskId);
      set((state) => ({
        taskDocuments: { ...state.taskDocuments, [taskId]: items },
        taskDocumentsLoading: null,
      }));
    } catch {
      set({ taskDocumentsLoading: null });
    }
  },

  async createTask(input) {
    const ctx = context();
    if (!ctx) return null;
    try {
      const { item } = await ctx.client.benchmarkCreateTask(ctx.workspaceId, input);
      set((state) => ({ tasks: [item, ...state.tasks], tasksError: null }));
      return item;
    } catch (error) {
      set({ tasksError: errorMessage(error) });
      return null;
    }
  },

  async updateTask(taskId, input) {
    const ctx = context();
    if (!ctx) return null;
    try {
      const { item } = await ctx.client.benchmarkUpdateTask(ctx.workspaceId, taskId, input);
      set((state) => ({ tasks: state.tasks.map((task) => (task.id === taskId ? item : task)) }));
      return item;
    } catch (error) {
      set({ tasksError: errorMessage(error) });
      return null;
    }
  },

  async deleteTask(taskId) {
    const ctx = context();
    if (!ctx) return;
    try {
      await ctx.client.benchmarkDeleteTask(ctx.workspaceId, taskId);
      set((state) => ({
        tasks: state.tasks.filter((task) => task.id !== taskId),
        selectedTaskIds: state.selectedTaskIds.filter((id) => id !== taskId),
      }));
    } catch (error) {
      set({ tasksError: errorMessage(error) });
    }
  },

  async deleteTasks(taskIds) {
    const ctx = context();
    const ids = Array.from(new Set(taskIds));
    if (!ctx || !ids.length) return;
    try {
      await Promise.all(ids.map((id) => ctx.client.benchmarkDeleteTask(ctx.workspaceId, id)));
      const removed = new Set(ids);
      set((state) => ({
        tasks: state.tasks.filter((task) => !removed.has(task.id)),
        selectedTaskIds: state.selectedTaskIds.filter((id) => !removed.has(id)),
      }));
    } catch (error) {
      // A partial failure may have deleted some — reconcile against the server.
      set({ tasksError: errorMessage(error) });
      await get().refreshTasks();
    }
  },

  async exportTasks(taskIds) {
    const ctx = context();
    if (!ctx || !taskIds.length) return false;
    set({ exporting: true, exportError: null });
    try {
      const { data, filename } = await ctx.client.benchmarkExportTasks(ctx.workspaceId, taskIds);
      triggerDownload(data, filename ?? "benchmark-tasks.zip");
      set({ exporting: false });
      return true;
    } catch (error) {
      set({ exporting: false, exportError: errorMessage(error) });
      return false;
    }
  },

  async importTasksZip(zipBase64) {
    const ctx = context();
    if (!ctx) return 0;
    set({ importing: true, importError: null });
    try {
      const result = await ctx.client.benchmarkImportZip(ctx.workspaceId, zipBase64);
      set({ importing: false });
      if (result.failed.length) {
        set({ importError: result.failed.map((entry) => `${entry.path}: ${entry.error}`).join("; ") });
      }
      await get().refreshTasks();
      return result.items.length;
    } catch (error) {
      set({ importing: false, importError: errorMessage(error) });
      return 0;
    }
  },

  // ---- runs -----------------------------------------------------------------

  async refreshRuns() {
    const ctx = context();
    if (!ctx) return;
    if (get().runsStatus === "idle") set({ runsStatus: "loading" });
    try {
      const { items } = await ctx.client.benchmarkListRuns(ctx.workspaceId);
      const hadActive = get().runs.some((run) => isRunActive(run.status));
      const hasActive = items.some((run) => isRunActive(run.status));
      set({ runs: items, runsStatus: "ready", runsError: null });
      // A run just finished — the task table's "latest results" changed.
      if (hadActive && !hasActive) void get().refreshTasks();
    } catch (error) {
      set({ runsStatus: "error", runsError: errorMessage(error) });
    }
  },

  startRunsPolling() {
    if (runsPollHandle !== null) return;
    runsPollHandle = setInterval(() => {
      if (runsPollInFlight) return;
      if (!get().runs.some((run) => isRunActive(run.status))) return;
      runsPollInFlight = true;
      void get()
        .refreshRuns()
        .finally(() => {
          runsPollInFlight = false;
        });
    }, RUNS_POLL_MS);
  },

  stopRunsPolling() {
    if (runsPollHandle !== null) {
      clearInterval(runsPollHandle);
      runsPollHandle = null;
    }
  },

  async loadRun(runId: string) {
    const ctx = context();
    if (!ctx) return;
    if (get().activeRun?.run.id !== runId) {
      set({ activeRun: null, activeRunStatus: "loading", activeRunError: null, itemDetails: {} });
    }
    try {
      const detail = await ctx.client.benchmarkGetRun(ctx.workspaceId, runId);
      const wasActive = get().activeRun ? isRunActive(get().activeRun!.run.status) : false;
      set({ activeRun: detail, activeRunStatus: "ready", activeRunError: null });
      if (wasActive && !isRunActive(detail.run.status)) void get().refreshTasks();
    } catch (error) {
      set({ activeRunStatus: "error", activeRunError: errorMessage(error) });
    }
  },

  clearActiveRun() {
    get().stopDetailPolling();
    set({ activeRun: null, activeRunStatus: "idle", activeRunError: null, itemDetails: {} });
  },

  startDetailPolling(runId: string) {
    get().stopDetailPolling();
    detailPollHandle = setInterval(() => {
      if (detailPollInFlight) return;
      const active = get().activeRun;
      if (active && !isRunActive(active.run.status)) {
        get().stopDetailPolling();
        return;
      }
      detailPollInFlight = true;
      void get()
        .loadRun(runId)
        .finally(() => {
          detailPollInFlight = false;
        });
    }, DETAIL_POLL_MS);
  },

  stopDetailPolling() {
    if (detailPollHandle !== null) {
      clearInterval(detailPollHandle);
      detailPollHandle = null;
    }
  },

  async abortRun(runId: string) {
    const ctx = context();
    if (!ctx) return;
    try {
      await ctx.client.benchmarkAbortRun(ctx.workspaceId, runId);
      await Promise.all([get().refreshRuns(), get().activeRun?.run.id === runId ? get().loadRun(runId) : null]);
    } catch (error) {
      set({ activeRunError: errorMessage(error) });
    }
  },

  async resumeRun(runId: string) {
    const ctx = context();
    if (!ctx) return;
    try {
      await ctx.client.benchmarkResumeRun(ctx.workspaceId, runId);
      await get().loadRun(runId);
      get().startDetailPolling(runId);
      await get().refreshRuns();
    } catch (error) {
      set({ activeRunError: errorMessage(error) });
    }
  },

  async deleteRun(runId: string) {
    const ctx = context();
    if (!ctx) return;
    try {
      await ctx.client.benchmarkDeleteRun(ctx.workspaceId, runId);
      if (get().activeRun?.run.id === runId) get().clearActiveRun();
      await Promise.all([get().refreshRuns(), get().refreshTasks()]);
    } catch (error) {
      set({ runsError: errorMessage(error) });
    }
  },

  async loadItemDetail(runId: string, itemId: string) {
    const ctx = context();
    if (!ctx) return;
    set({ itemDetailLoading: itemId });
    try {
      const detail = await ctx.client.benchmarkGetRunItem(ctx.workspaceId, runId, itemId);
      set((state) => ({ itemDetails: { ...state.itemDetails, [itemId]: detail }, itemDetailLoading: null }));
    } catch {
      set({ itemDetailLoading: null });
    }
  },

  async loadAnalytics() {
    const ctx = context();
    if (!ctx) return;
    if (get().analyticsStatus === "idle") set({ analyticsStatus: "loading" });
    const tags = get().analyticsTags;
    try {
      const analytics = await ctx.client.benchmarkGetAnalytics(ctx.workspaceId, tags.length ? { tags } : undefined);
      set({ analytics, analyticsStatus: "ready", analyticsError: null });
    } catch (error) {
      set({ analyticsStatus: "error", analyticsError: errorMessage(error) });
    }
  },

  setAnalyticsTags(tags) {
    set({ analyticsTags: tags });
    void get().loadAnalytics();
  },

  // ---- Legal Agent Benchmark catalog (import) --------------------------------

  async ensureCatalog() {
    if (get().catalogStatus === "loading" || get().catalogStatus === "ready") return;
    await get().refreshCatalog();
  },

  async refreshCatalog() {
    const ctx = context();
    if (!ctx) return;
    if (get().catalogStatus === "idle") set({ catalogStatus: "loading" });
    try {
      const catalog = await ctx.client.benchmarkGetCatalog(ctx.workspaceId);
      set({
        catalogRef: catalog.ref,
        catalogItems: catalog.items,
        catalogVerticals: catalog.verticals,
        catalogHydration: catalog.hydration,
        catalogStatus: "ready",
        catalogError: null,
      });
    } catch (error) {
      set({ catalogStatus: "error", catalogError: errorMessage(error) });
    }
  },

  startCatalogPolling() {
    if (catalogPollHandle !== null) return;
    catalogPollHandle = setInterval(() => {
      if (catalogPollInFlight) return;
      const hydration = get().catalogHydration;
      if (!hydration || hydration.hydrated >= hydration.total) {
        get().stopCatalogPolling();
        return;
      }
      catalogPollInFlight = true;
      void get()
        .refreshCatalog()
        .finally(() => {
          catalogPollInFlight = false;
        });
    }, CATALOG_POLL_MS);
  },

  stopCatalogPolling() {
    if (catalogPollHandle !== null) {
      clearInterval(catalogPollHandle);
      catalogPollHandle = null;
    }
  },

  setImportFilters(patch) {
    set((state) => ({ importFilters: { ...state.importFilters, ...patch } }));
  },

  toggleImportSelection(key) {
    set((state) => ({
      importSelection: state.importSelection.includes(key)
        ? state.importSelection.filter((entry) => entry !== key)
        : [...state.importSelection, key],
    }));
  },

  setImportSelection(keys) {
    set({ importSelection: Array.from(new Set(keys)) });
  },

  async loadCatalogPreview(key) {
    const ctx = context();
    if (!ctx || get().catalogPreviews[key]) return;
    set({ catalogPreviewLoading: key });
    try {
      const { task } = await ctx.client.benchmarkGetCatalogTask(ctx.workspaceId, key);
      set((state) => ({
        catalogPreviews: { ...state.catalogPreviews, [key]: task },
        catalogPreviewLoading: null,
      }));
    } catch {
      set({ catalogPreviewLoading: null });
    }
  },

  async importSelected() {
    const ctx = context();
    const keys = get().importSelection;
    if (!ctx || !keys.length) return 0;
    set({ importing: true, importError: null });
    try {
      const result = await ctx.client.benchmarkImportTasks(ctx.workspaceId, keys);
      set({ importing: false, importSelection: [] });
      if (result.failed.length) {
        set({ importError: result.failed.map((entry) => `${entry.key}: ${entry.error}`).join("; ") });
      }
      await get().refreshTasks();
      return result.items.length;
    } catch (error) {
      set({ importing: false, importError: errorMessage(error) });
      return 0;
    }
  },

  // ---- start run --------------------------------------------------------------

  toggleModel(ref) {
    set((state) => {
      const existing = state.draft.models.find((model) => sameModel(model, ref));
      return {
        draft: {
          ...state.draft,
          models: existing
            ? state.draft.models.filter((model) => !sameModel(model, ref))
            : [...state.draft.models, ref],
        },
      };
    });
  },

  setJudge(ref) {
    set((state) => ({ draft: { ...state.draft, judge: ref } }));
  },

  setDraftName(name) {
    set((state) => ({ draft: { ...state.draft, name } }));
  },

  resetDraft() {
    set({ draft: { name: "", models: [], judge: null }, createError: null });
  },

  async createRun() {
    const ctx = context();
    const { draft, selectedTaskIds } = get();
    if (!ctx || !selectedTaskIds.length || !draft.models.length) return null;
    set({ creating: true, createError: null });
    try {
      const payload: BenchmarkRunCreateInput = {
        ...(draft.name.trim() ? { title: draft.name.trim() } : {}),
        tasks: selectedTaskIds,
        models: draft.models,
        judgeModel: draft.judge ?? DEFAULT_JUDGE_MODEL,
      };
      const { run } = await ctx.client.benchmarkCreateRun(ctx.workspaceId, payload);
      set((state) => ({ creating: false, runs: [run, ...state.runs.filter((entry) => entry.id !== run.id)] }));
      get().resetDraft();
      get().clearTaskSelection();
      return run;
    } catch (error) {
      set({ creating: false, createError: errorMessage(error) });
      return null;
    }
  },
}));

export type { BenchmarkState, BenchmarkActions };
