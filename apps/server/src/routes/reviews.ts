import { z } from "zod";
import { ApiError } from "../errors.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";
import { ReviewService } from "../reviews/service.js";
import { ReviewLibrary } from "../reviews/library.js";
import { ReviewSettingsSchema } from "../reviews/schema.js";

export function registerReviewRoutes(options: {
  routes: Route[]; config: ServerConfig; reviews: ReviewService;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}) {
  const { reviews } = options, library = new ReviewLibrary(options.config);
  const body = (ctx: RequestContext) => options.readJsonBodyLimited(ctx.request, 2 * 1024 * 1024);
  const route = (method: string, path: string, action: (ctx: RequestContext, workspace: WorkspaceInfo) => Promise<unknown>) => {
    addRoute(options.routes, method, `/workspace/:id/reviews${path}`, "client", async ctx => {
      options.requireClientScope(ctx, method === "GET" ? "viewer" : "collaborator");
      if (method !== "GET") options.ensureWritable(options.config);
      const workspace = await options.resolveWorkspace(options.config, ctx.params.id);
      try { return options.jsonResponse(await action(ctx, workspace)); }
      catch (error) {
        if (error instanceof z.ZodError) throw new ApiError(400, "review_input", "Check the review inputs.", { issues: error.issues.map(issue => ({ path: issue.path, message: issue.message })) });
        throw error;
      }
    });
  };
  route("GET", "/settings", (_ctx, workspace) => reviews.capabilities(workspace));
  route("PUT", "/settings", async (ctx, workspace) => reviews.saveSettings(workspace, await body(ctx)));
  route("GET", "/library", async ctx => {
    const query = (ctx.url.searchParams.get("query") ?? "").toLocaleLowerCase();
    const entries = await library.list(ctx.url.searchParams.get("language") === "de" ? "de" : "en");
    return { entries: entries.filter(entry => `${entry.name} ${entry.description} ${entry.tags.join(" ")} ${entry.columns.map(column => column.question).join(" ")}`.toLocaleLowerCase().includes(query)) };
  });
  route("POST", "/library", async ctx => library.save(await body(ctx)));
  route("DELETE", "/library/:entry", async ctx => { await library.remove(ctx.params.entry); return { ok: true }; });
  route("GET", "", async (_ctx, workspace) => ({ reviews: await reviews.list(workspace) }));
  route("POST", "", async (ctx, workspace) => reviews.create(workspace, await body(ctx)));
  route("GET", "/:review", (ctx, workspace) => reviews.get(workspace, ctx.params.review));
  route("PATCH", "/:review", async (ctx, workspace) => reviews.edit(workspace, ctx.params.review, await body(ctx)));
  route("GET", "/:review/settings", (ctx, workspace) => reviews.capabilities(workspace, ctx.params.review));
  route("PUT", "/:review/settings", async (ctx, workspace) => {
    const input = z.strictObject({ revision: z.number().int().nonnegative(), settings: ReviewSettingsSchema }).parse(await body(ctx));
    return reviews.saveSettings(workspace, input.settings, ctx.params.review, input.revision);
  });
  route("POST", "/:review/start", async (ctx, workspace) => reviews.start(workspace, ctx.params.review, await body(ctx)));
  route("POST", "/:review/cancel", (ctx, workspace) => reviews.cancel(workspace, ctx.params.review));
  route("GET", "/:review/source/:document", (ctx, workspace) => reviews.verifySource(workspace, ctx.params.review, ctx.params.document, ctx.url.searchParams.get("sourceHash") ?? undefined));
  route("GET", "/:review/source/:document/:column/:citation", (ctx, workspace) => reviews.citationPage(workspace, ctx.params.review, ctx.params.document, ctx.params.column,
    z.coerce.number().int().nonnegative().parse(ctx.params.citation), z.coerce.number().int().nonnegative().parse(ctx.url.searchParams.get("completedAt")), ctx.request.signal));
}
