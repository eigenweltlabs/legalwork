import { randomUUID } from "node:crypto";
import { setMaxListeners } from "node:events";
import type { DocumentPreparation } from "../document-preparation/service.js";
import { ApiError } from "../errors.js";
import type { WorkspaceInfo } from "../types.js";
import { incompatibleJevQuestion, reviewDecisionThreshold, ReviewColumnKindSchema, CreateReviewSchema, EditReviewSchema, RunReviewSchema, ReviewSettingsSchema, type ReviewCell, type ReviewDocument, type SavedReview, type ReviewSummary, type ReviewSettings, type ReviewCapabilities } from "./schema.js";
import { ReviewDefaults, ReviewStore, serialized } from "./storage.js";
import { prepareReviewEvidence, reviewSource, sourceHash } from "./evidence.js";
import { columnBackend, validateAvailableModels, validateReviewPolicy } from "./policy.js";
import type { ReviewExecutor } from "./executor.js";
import { reviewSourcePage } from "./source-page.js";
import { ReviewScheduler } from "./scheduler.js";
import { upgradeBuiltinReviewColumn } from "./builtin-fallback.js";
import { enforceReviewDecisionThreshold } from "./decision-threshold.js";
import { readReviewResults } from "./results.js";
import { ReviewResultQueries } from "./result-query-pages.js";
import { ReviewUpdates } from "./updates.js";
import { queryCells } from "./result-query.js";
import { QueryReviewResultsSchema } from "./schema.js";

function cellsFor(documents: ReviewDocument[], review: Pick<SavedReview, "columns" | "cells">): ReviewCell[] {
  return documents.flatMap(document => review.columns.map(column => review.cells.find(cell => cell.documentId === document.id && cell.columnKey === column.key)
    ?? { documentId: document.id, columnKey: column.key, status: "pending", result: null, error: null }));
}
function summary(review: SavedReview): ReviewSummary {
  return { id: review.id, name: review.name, revision: review.revision, status: review.status, createdAt: review.createdAt, updatedAt: review.updatedAt, settings: review.settings, error: review.error,
    documents: review.documents.length, columns: review.columns.length, total: review.cells.length, completed: review.cells.filter(cell => cell.status === "complete").length };
}
type Dependencies = Pick<ReviewExecutor, "models" | "execute">;
export class ReviewService {
  private resultQueries = new ReviewResultQueries();
  private updates = new ReviewUpdates();
  private active = new Map<string, AbortController>();
  private runs = new Map<string, Promise<void>>();
  constructor(private executor: Dependencies, private preparation: DocumentPreparation, private defaults: ReviewDefaults, private scheduler = new ReviewScheduler()) {}
  private key(workspace: WorkspaceInfo, id: string) { return `${workspace.path}\0${id}`; }
  async capabilities(workspace: WorkspaceInfo, id?: string): Promise<ReviewCapabilities> {
    const available = await this.executor.models(workspace);
    const settings = id ? (await this.get(workspace, id)).settings : await this.defaults.settings(available.settings);
    return { ...available, settings, allowedKinds: settings.mode === "jev" ? ["yes_no", "classification"] : ReviewColumnKindSchema.options };
  }
  async saveSettings(workspace: WorkspaceInfo, raw: unknown, id?: string, revision?: number) {
    const settings = ReviewSettingsSchema.parse(raw), store = new ReviewStore(workspace.path);
    if (id) {
      const before = await this.get(workspace, id); this.editable(before); await store.archive(before);
      return store.update(id, review => {
      this.editable(review);
      for (const cell of review.cells) {
        const column = review.columns.find(column => column.key === cell.columnKey)!;
        // Existing LLM columns stay readable but cannot execute in Only JEV.
        if (settings.mode === "jev" && incompatibleJevQuestion(column)) continue;
        if (cell.blockedBy === "jev_mode") {
          cell.blockedBy = undefined;
          cell.status = cell.result ? "stale" : "pending";
        }
        if (!cell.result) continue;
        const previousMode = review.settings.mode === "jev" && incompatibleJevQuestion(column) ? "mixed" : review.settings.mode;
        const previousBackend = columnBackend(previousMode, column), nextBackend = columnBackend(settings.mode, column);
        const previousModel = previousBackend === "systemone" ? review.settings.jev : review.settings.llm;
        const nextModel = nextBackend === "systemone" ? settings.jev : settings.llm;
        if (previousBackend !== nextBackend || JSON.stringify(previousModel) !== JSON.stringify(nextModel)
          || (nextBackend === "systemone" && reviewDecisionThreshold(review.settings) !== reviewDecisionThreshold(settings))) cell.status = "stale";
      }
      review.settings = settings;
      review.status = "draft";
    }, revision);
    }
    return this.defaults.saveSettings(settings);
  }
  async resetDefaults(workspace: WorkspaceInfo) {
    await this.defaults.reset();
    return this.capabilities(workspace);
  }
  private editable(review: SavedReview) {
    if (review.status === "running") throw new ApiError(409, "review_running", "Stop the review before changing its columns, sources or settings.");
  }
  private async documents(workspace: WorkspaceInfo, paths: string[], previous: ReviewDocument[] = []) {
    const sources = await Promise.all(paths.map(path => reviewSource(workspace.path, path)));
    if (new Set(sources.map(source => source.path)).size !== sources.length) throw new ApiError(400, "review_duplicate_source", "Choose each document only once.");
    return sources.map(source => previous.find(document => document.path === source.path) ?? {
      id: randomUUID(), path: source.path, name: source.name, sourceHash: null, status: "pending", completedPages: 0, pageCount: 0, error: null,
    } satisfies ReviewDocument);
  }
  async create(workspace: WorkspaceInfo, raw: unknown) {
    const input = CreateReviewSchema.parse(raw), store = new ReviewStore(workspace.path);
    const existing = (await store.list()).find(review => review.id === input.requestId);
    if (existing) return existing;
    const { settings } = await this.capabilities(workspace);
    validateReviewPolicy(settings, input.columns);
    const documents = await this.documents(workspace, input.files);
    const now = Date.now();
    return store.create({ sessionId: input.sessionId ?? null, id: input.requestId, name: input.name, revision: 0, createdAt: now, updatedAt: now, settings, documents, columns: input.columns,
      cells: cellsFor(documents, { columns: input.columns, cells: [] }), status: "draft", runId: null, error: null });
  }
  async get(workspace: WorkspaceInfo, id: string) {
    const store = new ReviewStore(workspace.path), review = await store.read(id);
    if (review.status === "running" && !this.active.has(this.key(workspace, id))) return store.update(id, current => {
      if (current.status !== "running" || this.active.has(this.key(workspace, id))) return;
      current.status = "interrupted"; current.error = "The review was interrupted. Resume to keep completed cells and retry unfinished work.";
      for (const cell of current.cells) if (cell.status === "running" || cell.status === "queued") cell.status = "pending";
      for (const document of current.documents) if (document.status === "preparing") document.status = "pending";
    });
    if (review.status === "running") return review;
    if (review.columns.every(column => upgradeBuiltinReviewColumn(column) === column)
      && review.cells.every(cell => !cell.result || enforceReviewDecisionThreshold(cell.result, review.settings) === cell.result)) return review;
    return serialized(`${this.key(workspace, id)}:builtin-upgrade`, async () => {
      const latest = await store.read(id);
      const columns = latest.columns.map(upgradeBuiltinReviewColumn);
      const columnsChanged = columns.some((column, index) => column !== latest.columns[index]);
      const results = latest.cells.map(cell => cell.result ? enforceReviewDecisionThreshold(cell.result, latest.settings) : null);
      if (latest.status === "running" || (!columnsChanged && results.every((result, index) => result === latest.cells[index].result))) return latest;
      await store.archive(latest);
      try {
        return await store.update(id, current => {
          current.columns = columns;
          for (const [index, cell] of current.cells.entries()) {
            if (results[index] !== latest.cells[index].result) {
              cell.result = results[index];
              if (cell.status !== "stale") cell.status = "needs_review";
            }
            if (columns.some((column, index) => column.key === cell.columnKey && column !== latest.columns[index])) {
              cell.status = cell.result ? "stale" : "pending"; cell.error = null; cell.blockedBy = undefined;
            }
          }
          current.status = columnsChanged ? "draft" : "needs_review";
        }, latest.revision);
      } catch (error) {
        if (error instanceof ApiError && error.code === "review_conflict") return store.read(id);
        throw error;
      }
    });
  }
  async list(workspace: WorkspaceInfo) {
    const rows = await new ReviewStore(workspace.path).list();
    const summaries = await Promise.all(rows.sort((a, b) => b.updatedAt - a.updatedAt).map(async row => {
      try { return summary(await this.get(workspace, row.id)); }
      catch (error) { if (error instanceof ApiError && error.code === "review_not_found") return null; throw error; }
    }));
    return summaries.filter(row => row !== null);
  }
  async remove(workspace: WorkspaceInfo, id: string, revision: number) {
    const key = this.key(workspace, id);
    return serialized(`${key}:start`, async () => {
      const current = await this.get(workspace, id);
      if (current.status === "running") throw new ApiError(409, "review_delete_running", "Stop the review before deleting it.");
      await this.runs.get(key); // Let a completed/cancelled run finish writing its history.
      await new ReviewStore(workspace.path).remove(id, revision);
      this.resultQueries.forget(workspace.path, id);
      this.updates.forget(workspace.path, id);
    });
  }
  async results(workspace: WorkspaceInfo, id: string, input: unknown) {
    return readReviewResults(await this.get(workspace, id), input);
  }
  async queryResults(workspace: WorkspaceInfo, id: string, input: unknown) {
    return this.resultQueries.read(workspace.path, id, input, () => this.get(workspace, id));
  }
  async changes(workspace: WorkspaceInfo, id: string, revision?: number) {
    return this.updates.read(workspace.path, await this.get(workspace, id), revision);
  }
  async queryRows(workspace: WorkspaceInfo, id: string, raw: unknown) {
    const input = QueryReviewResultsSchema.omit({ cursor: true, limit: true, view: true }).parse(raw);
    const review = await this.get(workspace, id);
    const { cells } = queryCells(review, input);
    const hasResultFilter = input.columnKeys || input.statuses || input.evidence || input.values;
    const documentIds = review.columns.length || hasResultFilter ? [...new Set(cells.map(cell => cell.documentId))]
      : review.documents.filter(document => (!input.documentIds || input.documentIds.includes(document.id))
          && (!input.query || ((!input.searchIn || input.searchIn.includes("document")) && document.name.toLowerCase().includes(input.query.toLowerCase()))))
        .sort((a, b) => a.name.localeCompare(b.name) * (input.sort?.direction === "desc" ? -1 : 1)).map(document => document.id);
    return { revision: review.revision, documentIds };
  }
  async edit(workspace: WorkspaceInfo, id: string, raw: unknown) {
    const input = EditReviewSchema.parse(raw), store = new ReviewStore(workspace.path);
    const before = await this.get(workspace, id);
    this.editable(before);
    const documents = input.files ? await this.documents(workspace, input.files, before.documents) : undefined;
    await store.archive(before);
    return store.update(id, review => {
      this.editable(review);
      if (input.name !== undefined) review.name = input.name;
      if (input.columns) {
        // Reordering/removing retained columns is allowed; new or changed prompts
        // still have to comply with the saved mode, including agent edits.
        validateReviewPolicy(review.settings, input.columns.filter(column => JSON.stringify(column) !== JSON.stringify(review.columns.find(previous => previous.key === column.key))));
        for (const cell of review.cells) {
          const old = review.columns.find(column => column.key === cell.columnKey);
          const next = input.columns.find(column => column.key === cell.columnKey);
          if (JSON.stringify(old) !== JSON.stringify(next)) { cell.status = cell.result ? "stale" : "pending"; cell.error = null; }
        }
        review.columns = input.columns;
      }
      if (documents) review.documents = documents;
      review.cells = cellsFor(review.documents, review);
      if (input.columns || input.files) review.status = "draft";
    }, input.revision);
  }
  async start(workspace: WorkspaceInfo, id: string, raw: unknown) {
    const input = RunReviewSchema.parse(raw), key = this.key(workspace, id), store = new ReviewStore(workspace.path);
    if (input.retryFailed && (input.rerun || input.reprocess)) throw new ApiError(400, "review_retry_options", "Retry failed cells cannot be combined with rerun or reprocess.");
    return serialized(`${key}:start`, async () => {
      if (this.active.has(key)) {
        const current = await this.get(workspace, id);
        if (current.status === "running") return current;
        await this.runs.get(key); // Finish archival before admitting a new run for this review.
      }
      const review = await this.get(workspace, id);
      if (!review.documents.length) throw new ApiError(400, "review_no_documents", "Add a document before starting the review.");
      if (!review.columns.length) throw new ApiError(400, "review_no_columns", "Add a column before starting the review.");
      if (input.columnKeys?.some(key => !review.columns.some(column => column.key === key)) || input.documentIds?.some(id => !review.documents.some(document => document.id === id)))
        throw new ApiError(400, "review_selection", "The selected cells do not belong to this review.");
      const blocked = validateAvailableModels(await this.capabilities(workspace, id), review.settings,
        review.columns.filter(column => !input.columnKeys || input.columnKeys.includes(column.key)));
      await store.archive(review);
      const controller = new AbortController(); this.active.set(key, controller);
      // Every bounded document/cell job subscribes to this run's cancellation.
      setMaxListeners(0, controller.signal);
      let started: SavedReview;
      try {
        started = await store.update(id, current => {
          if (!current.sessionId && input.sessionId) { current.sessionId = input.sessionId; current.sessionCreatedForReview = false; }
          current.runId = randomUUID(); current.status = "running"; current.error = null;
          for (const cell of current.cells) {
            const selected = (!input.columnKeys || input.columnKeys.includes(cell.columnKey)) && (!input.documentIds || input.documentIds.includes(cell.documentId));
            if (selected && (input.retryFailed ? cell.status === "error" : input.rerun || input.reprocess || !["complete", "needs_review"].includes(cell.status))) {
              cell.blockedBy = blocked.get(cell.columnKey); cell.error = null;
              cell.status = cell.blockedBy ? "blocked" : "queued";
              if (!cell.blockedBy) cell.result = null;
            }
          }
          for (const document of current.documents) {
            if (current.cells.some(cell => cell.documentId === document.id && cell.status === "queued"
              && (!input.documentIds || input.documentIds.includes(document.id)) && (!input.columnKeys || input.columnKeys.includes(cell.columnKey)))) {
              document.status = "pending"; document.error = null;
            }
          }
        }, input.revision);
      } catch (error) { this.active.delete(key); throw error; }
      const run = this.run(workspace, started, input, controller, blocked).catch(async () => {
        if (controller.signal.aborted) return;
        await store.update(id, current => { current.status = "interrupted"; current.error = "The review could not save its progress. Retry to continue."; }).catch(() => undefined);
      }).finally(() => { this.active.delete(key); this.runs.delete(key); });
      this.runs.set(key, run);
      return started;
    });
  }
  private async run(workspace: WorkspaceInfo, snapshot: SavedReview, input: ReturnType<typeof RunReviewSchema.parse>, controller: AbortController, blocked: Map<string, NonNullable<ReviewCell["blockedBy"]>>) {
    const store = new ReviewStore(workspace.path), signal = controller.signal, group = this.key(workspace, snapshot.id);
    let preparationJobId: string | undefined, preparationJob: Promise<string> | undefined;
    const cancelPreparation = () => { if (preparationJobId) void this.preparation.cancel(workspace.path, preparationJobId).catch(() => undefined); };
    signal.addEventListener("abort", cancelPreparation, { once: true });
    // Lazily pin one OCR configuration when this review first reaches a document worker.
    // Queued documents hold paths only; extracted evidence is bounded by document workers.
    const prepare = () => preparationJob ??= (async () => {
      signal.throwIfAborted();
      const files = snapshot.documents.filter(document => /\.(pdf|png|jpe?g|webp)$/i.test(document.path)
        && snapshot.cells.some(cell => cell.documentId === document.id && cell.status === "queued")).map(document => document.path);
      preparationJobId = (await this.preparation.start(workspace.path, { files, force: input.reprocess })).id;
      if (signal.aborted) cancelPreparation();
      signal.throwIfAborted();
      return preparationJobId;
    })();
    try {
      const jobs = snapshot.documents.filter(document => (!input.documentIds || input.documentIds.includes(document.id))
        && (!input.retryFailed || snapshot.cells.some(cell => cell.documentId === document.id && cell.status === "queued"))).map(document => this.scheduler.documents.run(group, "documents", signal, async () => {
        signal.throwIfAborted();
        let current = await store.read(snapshot.id);
        const selected = (cell: ReviewCell) => cell.documentId === document.id && (!input.columnKeys || input.columnKeys.includes(cell.columnKey))
          && (!input.retryFailed || snapshot.cells.some(target => target.documentId === cell.documentId && target.columnKey === cell.columnKey && target.status === "queued"));
        try {
          const { hash } = await sourceHash(workspace.path, document.path);
          if (document.sourceHash && document.sourceHash !== hash) current = await store.update(snapshot.id, review => {
            for (const cell of review.cells.filter(cell => cell.documentId === document.id)) {
              cell.blockedBy = selected(cell) ? blocked.get(cell.columnKey) : undefined;
              cell.status = selected(cell) ? cell.blockedBy ? "blocked" : "queued" : "stale";
              if (cell.status === "queued") cell.result = null;
            }
          });
          if (!current.cells.some(cell => selected(cell) && cell.status === "queued")) return;
          await store.update(snapshot.id, review => { const item = review.documents.find(item => item.id === document.id)!; item.status = "preparing"; item.error = null; });
          const jobId = /\.(pdf|png|jpe?g|webp)$/i.test(document.path) ? await prepare() : undefined;
          const evidence = await prepareReviewEvidence({ workspace: workspace.path, path: document.path, preparation: this.preparation, preparationJobId: jobId, signal, force: input.reprocess,
            onProgress: async progress => { await store.update(snapshot.id, review => { const item = review.documents.find(item => item.id === document.id)!; item.completedPages = progress.completedPages; item.pageCount = progress.pageCount; }); },
          });
          await store.update(snapshot.id, review => {
            const item = review.documents.find(item => item.id === document.id)!;
            item.status = evidence.complete ? "ready" : "needs_review"; item.sourceHash = evidence.hash; item.preparationPath = evidence.preparationPath;
          });
          const cells = snapshot.columns.filter(column => !blocked.has(column.key) && (!input.columnKeys || input.columnKeys.includes(column.key))).map(column => {
            const backend = columnBackend(snapshot.settings.mode, column);
            const provider = backend === "systemone" ? snapshot.settings.jev : snapshot.settings.llm;
            return this.scheduler.cells.run(group, `${backend}:${provider!.providerId}`, signal, async () => {
              signal.throwIfAborted();
              const predicate = (cell: ReviewCell) => cell.documentId === document.id && cell.columnKey === column.key;
              if ((await store.read(snapshot.id)).cells.find(predicate)?.status !== "queued") return;
              await store.update(snapshot.id, review => { review.cells.find(predicate)!.status = "running"; });
              try {
                const result = await this.executor.execute(workspace, snapshot, column, evidence, AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]));
                signal.throwIfAborted();
                if ((await sourceHash(workspace.path, document.path)).hash !== evidence.hash) throw new Error("The source changed during review. Run this document again.");
                await store.update(snapshot.id, review => { const cell = review.cells.find(predicate)!; cell.result = result; cell.error = null; cell.status = result.evidence === "uncertain" ? "needs_review" : "complete"; });
              } catch (error) {
                if (signal.aborted) throw error;
                await store.update(snapshot.id, review => { const cell = review.cells.find(predicate)!; cell.status = "error"; cell.error = error instanceof Error ? error.message : "Review failed."; });
              }
            });
          });
          // Wait for every worker before finalizing or releasing this document's evidence.
          const results = await Promise.allSettled(cells);
          const failed = results.find(result => result.status === "rejected");
          if (failed?.status === "rejected") throw failed.reason;
        } catch (error) {
          if (signal.aborted) throw error;
          await store.update(snapshot.id, review => {
            const message = error instanceof Error ? error.message : "Could not prepare this document.";
            const item = review.documents.find(item => item.id === document.id)!; item.status = "error"; item.error = message;
            for (const cell of review.cells.filter(selected)) if (cell.status === "queued" || cell.status === "running") { cell.status = "error"; cell.error = message; }
          });
        }
      }));
      const results = await Promise.allSettled(jobs);
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } finally {
      signal.removeEventListener("abort", cancelPreparation);
      const settled = await store.update(snapshot.id, review => {
        for (const cell of review.cells) if (cell.status === "running" || cell.status === "queued") cell.status = "pending";
        for (const document of review.documents) if (document.status === "preparing") document.status = "pending";
        review.status = signal.aborted ? "cancelled" : review.cells.every(cell => cell.status === "complete") ? "complete" : "needs_review";
      });
      await store.archive(settled);
    }
  }
  async cancel(workspace: WorkspaceInfo, id: string) {
    const review = await this.get(workspace, id);
    this.active.get(this.key(workspace, id))?.abort();
    return review;
  }
  async verifySource(workspace: WorkspaceInfo, id: string, documentId: string, expectedHash?: string) {
    const review = await this.get(workspace, id), document = review.documents.find(document => document.id === documentId);
    if (!document) throw new ApiError(404, "review_document_not_found", "Document not found in this review.");
    const { hash } = await sourceHash(workspace.path, document.path);
    if (document.sourceHash !== hash || (expectedHash && expectedHash !== hash)) {
      if (review.status !== "running") await new ReviewStore(workspace.path).update(id, current => { for (const cell of current.cells.filter(cell => cell.documentId === documentId)) cell.status = "stale"; current.status = "needs_review"; });
      throw new ApiError(409, "review_source_changed", "The source has changed since this review. Rerun it before using the old evidence.");
    }
    return { path: document.path, sourceHash: hash };
  }
  async citationPage(workspace: WorkspaceInfo, id: string, documentId: string, columnKey: string, citationIndex: number, completedAt: number, signal: AbortSignal) {
    const review = await this.get(workspace, id);
    const cell = review.cells.find(cell => cell.documentId === documentId && cell.columnKey === columnKey);
    if (!cell?.result || cell.result.completedAt !== completedAt) throw new ApiError(409, "review_conflict", "This answer has changed. Open its current source citation.");
    const source = await this.verifySource(workspace, id, documentId, cell.result.sourceHash);
    return reviewSourcePage(workspace.path, source.path, cell.result, citationIndex, signal);
  }
  async stop() { for (const controller of this.active.values()) controller.abort(); await Promise.allSettled(this.runs.values()); }
}
