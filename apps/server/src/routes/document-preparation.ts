import { z } from "zod";
import { readPreparedDocument } from "../document-preparation/read.js";
import { ApiError } from "../errors.js";
import { DocumentPreparation } from "../document-preparation/service.js";
import type { OcrManager } from "../ocr/manager.js";
import { PdfReader } from "../pdf-reader.js";
import { PDF_MAX_BYTES, pdfReadOptions } from "../pdf-read-schema.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

export function registerDocumentPreparationRoutes(options: {
  routes: Route[]; config: ServerConfig; preparation: DocumentPreparation; ocr: OcrManager;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}) {
  const { routes, config, preparation, jsonResponse } = options;
  const pdfReader = new PdfReader(options.ocr);
  // Bytes were obtained by the engine's permission-checked read or storage
  // checkout. This endpoint cannot open arbitrary paths on the server.
  addRoute(routes, "POST", "/workspace/:id/pdf/read", "client", async ctx => {
    options.requireClientScope(ctx, "collaborator");
    await options.resolveWorkspace(config, ctx.params.id);
    const input = pdfReadOptions.extend({ dataBase64: z.string().min(1).max(Math.ceil(PDF_MAX_BYTES / 3) * 4) })
      .parse(await options.readJsonBodyLimited(ctx.request, Math.ceil(PDF_MAX_BYTES / 3) * 4 + 64 * 1024));
    try { return jsonResponse(await pdfReader.read(new Uint8Array(Buffer.from(input.dataBase64, "base64")), input, ctx.request.signal)); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      if (ctx.request.signal.aborted) throw error;
      throw new ApiError(400, "pdf_unreadable", "Could not read this PDF. Check that it is valid and not password-protected. Repeating the same read will not repair it.");
    }
  });
  const base = "/workspace/:id/document-preparations";
  const route = (method: string, path: string, action: (ctx: RequestContext, workspace: string) => Promise<unknown>) => {
    addRoute(routes, method, path, "client", async ctx => {
      if (method !== "GET") { options.ensureWritable(config); options.requireClientScope(ctx, "collaborator"); }
      const workspace = await options.resolveWorkspace(config, ctx.params.id);
      try { return jsonResponse(await action(ctx, workspace.path)); }
      catch (error) {
        if (error instanceof z.ZodError) throw new ApiError(400, "preparation_input", "Provide up to 100 document paths and optional language hints.");
        if (error instanceof ApiError) throw error;
        throw new ApiError(400, "preparation_failed", "Could not start preparation. Check the document paths and OCR settings, then retry.");
      }
    });
  };
  route("POST", base, async (ctx, workspace) => preparation.start(workspace, await options.readJsonBodyLimited(ctx.request, 512 * 1024)));
  route("GET", `${base}/document`, async (ctx, workspace) => {
    const url = new URL(ctx.request.url);
    const query = z.object({ file: z.string().min(1).max(4096), preparationPath: z.string().min(1).max(4096),
      page: z.coerce.number().int().positive().max(1000).optional() }).parse({
        file: url.searchParams.get("file"), preparationPath: url.searchParams.get("preparationPath"),
        page: url.searchParams.get("page") ?? undefined,
      });
    const document = await readPreparedDocument(workspace, query.file, query.preparationPath);
    if (query.page !== undefined && query.page > document.pageCount) throw new ApiError(404, "preparation_page", "Page not found.");
    return { ...document, pages: query.page === undefined ? document.pages : document.pages.filter(page => page.page === query.page) };
  });
  route("GET", `${base}/:job`, (ctx, workspace) => preparation.status(workspace, ctx.params.job));
  route("DELETE", `${base}/:job`, (ctx, workspace) => preparation.cancel(workspace, ctx.params.job));
}
