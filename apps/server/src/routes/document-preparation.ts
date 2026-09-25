import { z } from "zod";
import { ApiError } from "../errors.js";
import { DocumentPreparation } from "../document-preparation/service.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

export function registerDocumentPreparationRoutes(options: {
  routes: Route[]; config: ServerConfig; preparation: DocumentPreparation;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}) {
  const { routes, config, preparation, jsonResponse } = options;
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
  route("GET", `${base}/:job`, (ctx, workspace) => preparation.status(workspace, ctx.params.job));
  route("DELETE", `${base}/:job`, (ctx, workspace) => preparation.cancel(workspace, ctx.params.job));
}
