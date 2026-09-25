import { randomUUID } from "node:crypto";
import type { DocumentPreparation } from "../document-preparation/service.js";
import { ApiError } from "../errors.js";
import type { WorkspaceInfo } from "../types.js";
import { CreateReviewSchema, EditReviewSchema, RunReviewSchema, ReviewSettingsSchema, type ReviewCell, type ReviewDocument, type SavedReview, type ReviewSummary, type ReviewSettings, type ReviewCapabilities } from "./schema.js";
import { ReviewStore, serialized } from "./storage.js";
import { prepareReviewEvidence, reviewSource, sourceHash } from "./evidence.js";
import { validateAvailableModels, validateReviewPolicy } from "./policy.js";
import type { ReviewExecutor } from "./executor.js";
import { reviewSourcePage } from "./source-page.js";

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
  private active = new Map<string, AbortController>();
  constructor(private executor: Dependencies, private preparation: DocumentPreparation) {}
  private key(workspace: WorkspaceInfo, id: string) { return `${workspace.path}\0${id}`; }
  async capabilities(workspace: WorkspaceInfo, id?: string): Promise<ReviewCapabilities> {
    const available = await this.executor.models(workspace);
    const settings = id ? (await this.get(workspace, id)).settings : await new ReviewStore(workspace.path).settings(available.settings);
    return { ...available, settings, allowedKinds: settings.mode === "jev" ? ["yes_no", "classification"] : ["yes_no", "classification", "text"] };
  }
  async saveSettings(workspace: WorkspaceInfo, raw: unknown, id?: string, revision?: number) {
    const settings = ReviewSettingsSchema.parse(raw), store = new ReviewStore(workspace.path);
    if (id) {
      const before = await this.get(workspace, id); this.editable(before); await store.archive(before);
      return store.update(id, review => {
      this.editable(review); validateReviewPolicy(settings, review.columns);
      review.settings = settings;
      for (const cell of review.cells) if (cell.result) cell.status = "stale";
      review.status = "draft";
    }, revision);
    }
    return store.saveSettings(settings);
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
    return store.create({ id: input.requestId, name: input.name, revision: 0, createdAt: now, updatedAt: now, settings, documents, columns: input.columns,
      cells: cellsFor(documents, { columns: input.columns, cells: [] }), status: "draft", runId: null, error: null });
  }
  async get(workspace: WorkspaceInfo, id: string) {
    const store = new ReviewStore(workspace.path), review = await store.read(id);
    if (review.status === "running" && !this.active.has(this.key(workspace, id))) return store.update(id, current => {
      if (current.status !== "running" || this.active.has(this.key(workspace, id))) return;
      current.status = "interrupted"; current.error = "The review was interrupted. Resume to keep completed cells and retry unfinished work.";
      for (const cell of current.cells) if (cell.status === "running") cell.status = "pending";
    });
    return review;
  }
  async list(workspace: WorkspaceInfo) {
    const rows = await new ReviewStore(workspace.path).list();
    return Promise.all(rows.sort((a, b) => b.updatedAt - a.updatedAt).map(async row => summary(await this.get(workspace, row.id))));
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
        validateReviewPolicy(review.settings, input.columns);
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
    return serialized(`${key}:start`, async () => {
      if (this.active.has(key)) return this.get(workspace, id);
      const review = await this.get(workspace, id);
      if (!review.columns.length) throw new ApiError(400, "review_no_columns", "Add a column before starting the review.");
      if (input.columnKeys?.some(key => !review.columns.some(column => column.key === key)) || input.documentIds?.some(id => !review.documents.some(document => document.id === id)))
        throw new ApiError(400, "review_selection", "The selected cells do not belong to this review.");
      validateAvailableModels(await this.capabilities(workspace, id), review.settings, review.columns);
      if (this.active.size >= 2) throw new ApiError(429, "review_busy", "Two reviews are already running. Wait for one to finish.");
      await store.archive(review);
      const controller = new AbortController(); this.active.set(key, controller);
      let started: SavedReview;
      try {
        started = await store.update(id, current => {
          current.runId = randomUUID(); current.status = "running"; current.error = null;
          for (const cell of current.cells) {
            const selected = (!input.columnKeys || input.columnKeys.includes(cell.columnKey)) && (!input.documentIds || input.documentIds.includes(cell.documentId));
            if (selected && (input.rerun || input.reprocess || cell.status !== "complete")) { cell.status = "pending"; cell.error = null; }
          }
        }, input.revision);
      } catch (error) { this.active.delete(key); throw error; }
      void this.run(workspace, started, input, controller).catch(async () => {
        if (controller.signal.aborted) return;
        await store.update(id, current => { current.status = "interrupted"; current.error = "The review could not save its progress. Retry to continue."; }).catch(() => undefined);
      }).finally(() => this.active.delete(key));
      return started;
    });
  }
  private async run(workspace: WorkspaceInfo, snapshot: SavedReview, input: ReturnType<typeof RunReviewSchema.parse>, controller: AbortController) {
    const store = new ReviewStore(workspace.path), signal = controller.signal;
    let preparationJobId: string | undefined, preparationError: unknown;
    const cancelPreparation = () => { if (preparationJobId) void this.preparation.cancel(workspace.path, preparationJobId).catch(() => undefined); };
    signal.addEventListener("abort", cancelPreparation, { once: true });
    try {
      // One preparation job pins the chosen OCR engine for every source in this review run.
      const files = snapshot.documents.filter(document => /\.(pdf|png|jpe?g|webp)$/i.test(document.path)
        && (!input.documentIds || input.documentIds.includes(document.id))).map(document => document.path);
      if (files.length) {
        try { preparationJobId = (await this.preparation.start(workspace.path, { files, force: input.reprocess })).id; }
        catch (error) { preparationError = error; }
      }
      if (signal.aborted) cancelPreparation();
      for (const document of snapshot.documents) {
        signal.throwIfAborted();
        if (input.documentIds && !input.documentIds.includes(document.id)) continue;
        let current = await store.read(snapshot.id);
        const selected = (cell: ReviewCell) => cell.documentId === document.id && (!input.columnKeys || input.columnKeys.includes(cell.columnKey));
        try {
          const { hash } = await sourceHash(workspace.path, document.path);
          if (document.sourceHash && document.sourceHash !== hash) current = await store.update(snapshot.id, review => {
            for (const cell of review.cells.filter(cell => cell.documentId === document.id)) cell.status = selected(cell) ? "pending" : "stale";
          });
          if (!current.cells.some(cell => selected(cell) && cell.status === "pending")) continue;
          if (preparationError && /\.(pdf|png|jpe?g|webp)$/i.test(document.path)) throw preparationError;
          await store.update(snapshot.id, review => { const item = review.documents.find(item => item.id === document.id)!; item.status = "preparing"; item.error = null; });
          const evidence = await prepareReviewEvidence({ workspace: workspace.path, path: document.path, preparation: this.preparation, preparationJobId, signal, force: input.reprocess,
            onProgress: async progress => { await store.update(snapshot.id, review => { const item = review.documents.find(item => item.id === document.id)!; item.completedPages = progress.completedPages; item.pageCount = progress.pageCount; }); },
          });
          await store.update(snapshot.id, review => {
            const item = review.documents.find(item => item.id === document.id)!;
            item.status = evidence.complete ? "ready" : "needs_review"; item.sourceHash = evidence.hash; item.preparationPath = evidence.preparationPath;
          });
          for (const column of snapshot.columns) {
            signal.throwIfAborted();
            if (input.columnKeys && !input.columnKeys.includes(column.key)) continue;
            const predicate = (cell: ReviewCell) => cell.documentId === document.id && cell.columnKey === column.key;
            if ((await store.read(snapshot.id)).cells.find(predicate)?.status !== "pending") continue;
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
          }
        } catch (error) {
          if (signal.aborted) throw error;
          await store.update(snapshot.id, review => {
            const message = error instanceof Error ? error.message : "Could not prepare this document.";
            const item = review.documents.find(item => item.id === document.id)!; item.status = "error"; item.error = message;
            for (const cell of review.cells.filter(selected)) if (cell.status !== "complete") { cell.status = "error"; cell.error = message; }
          });
        }
      }
    } finally {
      signal.removeEventListener("abort", cancelPreparation);
      const settled = await store.update(snapshot.id, review => {
        for (const cell of review.cells) if (cell.status === "running") cell.status = "pending";
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
  stop() { for (const controller of this.active.values()) controller.abort(); }
}
