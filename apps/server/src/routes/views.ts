import { workspaceContentPath } from "../project-storage-paths.js";
import { viewSaveSource, recordViewSaveSource } from "../views/save-source.js";
import { isAbsolute, relative, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { z } from "zod";
import { ViewSaveInputSchema } from "../views/schema.js";
import type { ApprovalRequest, ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { ApiError } from "../errors.js";
import { authenticateWikiAgentRequest } from "../wiki/agent-access.js";
import { ViewGenerationChunkSchema, viewGenerationStreams } from "../views/generation-stream.js";
import { ViewRepository, workspaceViewFiles } from "../views/repository.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

export function registerViewRoutes(options: {
  routes: Route[]; config: ServerConfig;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBodyLimited: (request: Request, limit: number) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  requireApproval: (ctx: RequestContext, input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">) => Promise<void>;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  isWikiWorkspace: (id: string) => Promise<boolean>;
}) {
  const generations = viewGenerationStreams();
  const generationScope = async (ctx: RequestContext, writing = false) => {
    options.requireClientScope(ctx, "viewer");
    const workspace = await options.resolveWorkspace(options.config, ctx.params.id);
    const agent = await authenticateWikiAgentRequest(options.config, ctx.request);
    if (writing && !agent) throw new ApiError(403, "view_generation_engine_only", "Only the connected agent can stream a view.");
    if (agent && (agent.sessionId !== ctx.params.sessionId || agent.directory !== await realpath(workspace.directory || workspace.path)))
      throw new ApiError(403, "view_generation_session_mismatch", "The preview belongs to another session.");
    return JSON.stringify([workspace.id, ctx.params.sessionId]);
  };
  addRoute(options.routes, "GET", "/workspace/:id/view-generations/:sessionId", "client", async ctx =>
    generations.subscribe(await generationScope(ctx), ctx.request.signal));
  addRoute(options.routes, "POST", "/workspace/:id/view-generations/:sessionId", "client", async ctx => {
    const key = await generationScope(ctx, true);
    const parsed = ViewGenerationChunkSchema.safeParse(await options.readJsonBodyLimited(ctx.request, 900_000));
    if (!parsed.success) throw new ApiError(400, "invalid_view_generation", "The view preview is invalid.");
    generations.publish(key, parsed.data);
    return options.jsonResponse({ ok: true });
  });
  const select = async (ctx: RequestContext, writing = false) => {
    options.requireClientScope(ctx, writing ? "collaborator" : "viewer");
    if (writing) options.ensureWritable(options.config);
    const workspace = await options.resolveWorkspace(options.config, ctx.params.id);
    if (await options.isWikiWorkspace(workspace.id)) throw new ApiError(403, "view_owner_mismatch", "Use this wiki's authorized view endpoint.");
    const agent = await authenticateWikiAgentRequest(options.config, ctx.request);
    if (agent) {
      const candidates = await Promise.all(options.config.workspaces.map(async candidate => {
        const root = await realpath(candidate.path).catch(() => null);
        if (!root) return null;
        const path = relative(root, agent.directory);
        return isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`) ? null : { id: candidate.id, root };
      }));
      const current = candidates.filter(candidate => candidate !== null).sort((a, b) => b.root.length - a.root.length)[0];
      if (current?.id !== workspace.id) throw new ApiError(403, "view_workspace_denied", "This report belongs to another workspace.");
    }
    return { workspace, repository: new ViewRepository({ kind: "workspace", id: workspace.id }, workspaceViewFiles(workspaceContentPath(workspace))) };
  };
  const authorize = async (ctx: RequestContext, workspace: WorkspaceInfo, path: string) => options.requireApproval(ctx, {
    workspaceId: workspace.id, action: "view.write", summary: "Save a report in this project", paths: [path],
  });
  addRoute(options.routes, "GET", "/workspace/:id/ui-views", "client", async ctx => {
    const { repository } = await select(ctx);
    return options.jsonResponse(await repository.list());
  });
  addRoute(options.routes, "GET", "/workspace/:id/ui-views/:viewId", "client", async ctx => {
    const { repository } = await select(ctx);
    return options.jsonResponse(await repository.read(ctx.params.viewId));
  });
  addRoute(options.routes, "POST", "/workspace/:id/ui-views", "client", async ctx => {
    if (ctx.request.headers.has("x-legalwork-wiki-agent-token")) throw new ApiError(403, "human_save_required", "Only the user can save a dashboard or report. Return a preview first.");
    const { workspace, repository } = await select(ctx, true);
    const parsed = ViewSaveInputSchema.safeParse(await options.readJsonBodyLimited(ctx.request, 2 * 1024 * 1024));
    if (!parsed.success) throw new ApiError(400, "invalid_view", "Check the report title, program and data.");
    const source = viewSaveSource(ctx.request);
    await authorize(ctx, workspace, parsed.data.mode === "report" ? "Reports" : "Dashboards");
    const result = await repository.create(parsed.data);
    await recordViewSaveSource(options.config, result, source);
    return options.jsonResponse(result, 201);
  });
  addRoute(options.routes, "PUT", "/workspace/:id/ui-views/:viewId", "client", async ctx => {
    if (ctx.request.headers.has("x-legalwork-wiki-agent-token")) throw new ApiError(403, "human_save_required", "Only the user can save a dashboard or report. Return a preview first.");
    const { workspace, repository } = await select(ctx, true);
    const parsed = z.object({ baseRevision: z.string().min(1).max(200), input: ViewSaveInputSchema }).strict().safeParse(await options.readJsonBodyLimited(ctx.request, 2 * 1024 * 1024));
    if (!parsed.success) throw new ApiError(400, "invalid_view", "Read the report before editing its definition.");
    const source = viewSaveSource(ctx.request);
    await authorize(ctx, workspace, await repository.location(ctx.params.viewId));
    const result = await repository.update(ctx.params.viewId, parsed.data.input, parsed.data.baseRevision);
    await recordViewSaveSource(options.config, result, source);
    return options.jsonResponse(result);
  });
}
