import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { createConfiguredOcrService } from "../ocr/index.js";
import { OcrManager } from "../ocr/manager.js";
import { languageSchema, OcrError } from "../ocr/types.js";
import type { OcrEngineInfo } from "../ocr/types.js";
import type { OcrService } from "../ocr/service.js";
import { openDocument, type RenderedDocument } from "./render.js";

import { pageSchema, preparedSchema, type PreparedDocument } from "./schema.js";
export { preparedSchema, type PreparedDocument } from "./schema.js";

const VERSION = "review-preparation-1";
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
export const prepareInput = z.strictObject({
  files: z.array(z.string().min(1).max(4096)).min(1).max(100),
  languages: z.array(languageSchema).max(32).default([]),
  force: z.boolean().default(false),
});

type Entry = { file: string; status: "queued" | "running" | "complete" | "needs-review" | "error"; completedPages: number; pageCount: number; preparationPath?: string; error?: string };
type Job = { id: string; workspace: string; engine: OcrEngineInfo; status: "queued" | "running" | "complete" | "needs-review" | "cancelled"; documents: Entry[]; controller: AbortController; createdAt: number };
type Snapshot = { service: OcrService; fingerprint: string };
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const within = (root: string, path: string) => { const part = relative(root, path); return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); };

/** Resolve symlinks before reading; source documents must belong to this workspace. */
export async function documentPath(workspace: string, input: string) {
  const root = await realpath(workspace);
  const requested = resolve(root, input);
  if (!within(root, requested)) throw new ApiError(403, "document_path", "Document is outside this workspace.");
  const path = await realpath(requested);
  if (!within(root, path)) throw new ApiError(403, "document_path", "Document is outside this workspace.");
  const suffix = extname(path).toLowerCase();
  if (![".pdf", ".png", ".jpg", ".jpeg", ".webp"].includes(suffix)) throw new ApiError(400, "document_format", "Use PDF, PNG, JPEG or WebP files. Read DOCX with the Word document reader.");
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new ApiError(400, "document_size", "Documents must be files of at most 64 MiB.");
  return { root, path, file: relative(root, path).split(sep).join("/"), kind: suffix === ".pdf" ? "pdf" as const : "image" as const };
}

async function snapshot(ocr: OcrManager): Promise<Snapshot> {
  const settings = await ocr.store.read();
  const engine = settings.engines.find(engine => engine.id === settings.defaultEngineId);
  if (!engine) throw new ApiError(400, "ocr_not_ready", "Choose an OCR model in Settings → AI Providers.");
  if (engine.kind === "local" && (ocr.runtime.busy || !await ocr.runtime.ready(engine.model)))
    throw new ApiError(400, "ocr_not_ready", "Download the selected OCR model in Settings → AI Providers, then retry the review.");
  const key = engine.kind !== "local" && engine.apiKeyRef !== null ? await ocr.vault.get(engine.apiKeyRef) : undefined;
  if (engine.kind !== "local" && engine.apiKeyRef !== null && !key)
    throw new ApiError(400, "ocr_key_required", "Add the selected model's API key in Settings → AI Providers, then retry.");
  return {
    service: createConfiguredOcrService({ ...settings, engines: [engine] }, { localRuntime: ocr.runtime.local, resolveApiKey: async () => key }),
    fingerprint: digest(JSON.stringify(engine)),
  };
}

/** Shared document preparation for review tools. Jobs and page OCR are serialized across runs. */
export class DocumentPreparation {
  private readonly jobs = new Map<string, Job>();
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly ocr: OcrManager, private readonly options: {
    snapshot?: () => Promise<Snapshot>;
    open?: (bytes: Uint8Array, kind: "pdf" | "image") => Promise<RenderedDocument>;
  } = {}) {}

  async start(workspace: string, raw: unknown) {
    const input = prepareInput.parse(raw);
    const root = await realpath(workspace);
    // Bound jobs without ever evicting running work.
    for (const [id, job] of this.jobs) if (!["running", "queued"].includes(job.status) && Date.now() - job.createdAt > 24 * 60 * 60 * 1000) this.jobs.delete(id);
    if (this.jobs.size >= 100) {
      for (const [id, job] of this.jobs) {
        if (!["running", "queued"].includes(job.status)) { this.jobs.delete(id); break; }
      }
      if (this.jobs.size >= 100) throw new ApiError(429, "preparation_limit", "Wait for current document preparation runs to finish.");
    }
    const sources = await Promise.all(input.files.map(file => documentPath(root, file)));
    if (new Set(sources.map(source => source.path)).size !== sources.length) throw new ApiError(400, "duplicate_document", "Each document should appear once in a review run.");
    const selected = await (this.options.snapshot ? this.options.snapshot() : snapshot(this.ocr));
    const engine = selected.service.listEngines()[0];
    if (!engine) throw new Error("Missing OCR engine");
    const job: Job = { id: randomUUID(), workspace: root, engine, status: "queued", documents: sources.map(source => ({ file: source.file, status: "queued", completedPages: 0, pageCount: 0 })), controller: new AbortController(), createdAt: Date.now() };
    this.jobs.set(job.id, job);
    this.pending = this.pending.catch(() => undefined).then(async () => {
      if (job.controller.signal.aborted) return;
      job.status = "running";
      for (let index = 0; index < sources.length; index++) {
        if (job.controller.signal.aborted) break;
        const entry = job.documents[index]!;
        entry.status = "running";
        try {
          // Revalidate paths at execution time, after any time spent queued.
          const source = await documentPath(root, sources[index]!.file);
          const bytes = await readFile(source.path);
          if (bytes.length > MAX_FILE_BYTES) throw new Error("Document is too large.");
          const sourceSha256 = digest(bytes);
          const key = digest(JSON.stringify([VERSION, source.file, sourceSha256, selected.fingerprint, input.languages]));
          const target = await this.outputPath(root, key);
          const prior = input.force ? undefined : await this.cached(target, key);
          const doc: PreparedDocument = prior ?? { version: VERSION, key, file: source.file, fileAbs: source.path, sourceSha256, engine, pageCount: 0, pages: [], status: "needs-review" };
          entry.preparationPath = relative(root, target).split(sep).join("/");
          if (prior && prior.pages.length === prior.pageCount && prior.pages.every(page => page.status !== "error")) {
            entry.completedPages = prior.pageCount; entry.pageCount = prior.pageCount; entry.status = prior.status; continue;
          }
          let rendered: RenderedDocument | undefined;
          try {
            rendered = await (this.options.open ?? openDocument)(bytes, source.kind);
            doc.pageCount = rendered.pageCount; entry.pageCount = doc.pageCount;
            let evidenceBytes = doc.pages.reduce((total, page) => total + Buffer.byteLength(JSON.stringify(page)), 0);
            for (let page = 1; page <= doc.pageCount; page++) {
              job.controller.signal.throwIfAborted();
              const existing = doc.pages.find(item => item.page === page);
              if (existing && existing.status !== "error") { entry.completedPages++; continue; }
              let nativeText = "", width = 0, height = 0;
              let result: z.infer<typeof pageSchema>;
              try {
                const renderedPage = await rendered.page(page, job.controller.signal);
                nativeText = renderedPage.nativeText; width = renderedPage.image.width; height = renderedPage.image.height;
                const recognized = await selected.service.extract({ sourceId: sourceSha256, pages: [renderedPage.image], languages: input.languages, signal: job.controller.signal });
                const ocr = recognized.pages[0]!;
                const uncertain = !ocr.text.trim() || ocr.truncated || /\[illegible\]/i.test(ocr.text) || ocr.regions.some(region => region.confidence !== undefined && region.confidence < 0.5);
                result = { page, nativeText, width, height, ocr: { text: ocr.text, regions: ocr.regions, truncated: ocr.truncated }, status: uncertain ? "needs-review" : "complete" };
              } catch (error) {
                if (job.controller.signal.aborted) throw error;
                result = { page, nativeText, width, height, ocr: null, status: "error", error: error instanceof OcrError ? error.message : "Could not read this page. Retry preparation or choose another OCR model." };
              }
              evidenceBytes += Buffer.byteLength(JSON.stringify(result)) - (existing ? Buffer.byteLength(JSON.stringify(existing)) : 0);
              if (evidenceBytes > MAX_EVIDENCE_BYTES) throw new ApiError(400, "document_size", "Extracted evidence exceeds 64 MiB. Split this document into smaller files and retry.");
              doc.pages = [...doc.pages.filter(item => item.page !== page), result].sort((a, b) => a.page - b.page);
              doc.status = "needs-review";
              await this.save(root, key, doc);
              entry.completedPages++;
            }
            doc.status = doc.pages.every(page => page.status === "complete") ? "complete" : "needs-review";
          } catch (error) {
            doc.status = "error"; doc.error = error instanceof ApiError ? error.message : job.controller.signal.aborted ? "Preparation was cancelled. Retry to resume completed pages." : "Could not prepare this document. Check that it is readable and not password-protected, then retry.";
          } finally { await rendered?.close(); }
          await this.save(root, key, doc);
          entry.status = doc.status; entry.error = doc.error;
        } catch (error) {
          entry.status = "error"; entry.error = error instanceof ApiError ? error.message : "Could not prepare this document. Retry the review.";
        }
      }
      job.status = job.controller.signal.aborted ? "cancelled" : job.documents.every(item => item.status === "complete") ? "complete" : "needs-review";
    });
    return this.status(root, job.id);
  }

  private async outputPath(root: string, key: string) {
    let directory = root;
    for (const segment of [".opencode", "legalwork", "prepared-documents"]) {
      directory = join(directory, segment);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if (!within(root, await realpath(directory))) throw new ApiError(403, "document_path", "Preparation output is outside this workspace.");
    }
    return join(directory, `${key}.json`);
  }
  private async save(root: string, key: string, doc: PreparedDocument) {
    const target = await this.outputPath(root, key), temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(doc, null, 2), { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
  }
  private async cached(path: string, key: string) {
    try {
      // Do not follow a replacement symlink to a file outside the cache directory.
      if (await realpath(path) !== path || (await stat(path)).size > 128 * 1024 * 1024) return;
      const doc = preparedSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (doc.key === key && doc.pageCount > 0 && doc.status !== "error") return doc;
      if (doc.key === key && doc.pages.length > 0) return { ...doc, error: undefined };
    } catch { /* Missing/stale cache is recomputed. */ }
  }
  private async job(workspace: string, id: string) {
    const job = this.jobs.get(id);
    if (!job || job.workspace !== await realpath(workspace)) throw new ApiError(404, "preparation_not_found", "Preparation run not found. Start a new run to reuse previously completed pages.");
    return job;
  }
  async status(workspace: string, id: string) {
    const job = await this.job(workspace, id);
    return { id: job.id, engine: job.engine, status: job.status, documents: job.documents.map(document => ({ ...document })) };
  }
  async cancel(workspace: string, id: string) {
    const job = await this.job(workspace, id);
    job.controller.abort(); job.status = "cancelled";
    return this.status(workspace, id);
  }
  stop() { for (const job of this.jobs.values()) job.controller.abort(); }
}
