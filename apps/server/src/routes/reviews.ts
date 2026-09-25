import { z } from "zod";
import { ApiError } from "../errors.js";
import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";
import { ReviewService } from "../reviews/service.js";
import { ReviewSessions } from "../reviews/sessions.js";
import { ReviewLibrary } from "../reviews/library.js";
import { ReviewSettingsSchema } from "../reviews/schema.js";

export function registerReviewRoutes(options: {
  routes: Route[]; config: ServerConfig; reviews: ReviewService; reviewSessions: ReviewSessions;
  jsonResponse: (data: unknown, status?: number) => Response;
  readJsonBodyLimited: (request: Request, maxBytes: number) => Promise<Record<string, unknown>>;
  ensureWritable: (config: ServerConfig) => void;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}) {
  const { reviews } = options, library = new ReviewLibrary(options.config);
  const body = (ctx: RequestContext) => options.readJsonBodyLimited(ctx.request, 2 * 1024 * 1024);
  const route = (method: string, path: string, action: (ctx: RequestContext, workspace: WorkspaceInfo) => Promise<unknown>, readOnly = method === "GET") => {
    addRoute(options.routes, method, `/workspace/:id/reviews${path}`, "client", async ctx => {
      options.requireClientScope(ctx, readOnly ? "viewer" : "collaborator");
      if (!readOnly) options.ensureWritable(options.config);
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
  route("DELETE", "/settings", (_ctx, workspace) => reviews.resetDefaults(workspace));
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
  route("GET", "/:review/updates", (ctx, workspace) => reviews.changes(workspace, ctx.params.review,
    ctx.url.searchParams.has("revision") ? z.coerce.number().int().nonnegative().parse(ctx.url.searchParams.get("revision")) : undefined));
  route("POST", "/:review/rows/query", async (ctx, workspace) => reviews.queryRows(workspace, ctx.params.review, await body(ctx)), true);
  route("DELETE", "/:review", async (ctx, workspace) => {
    const input = z.strictObject({ revision: z.number().int().nonnegative() }).parse(await body(ctx));
    await reviews.remove(workspace, ctx.params.review, input.revision);
    return { ok: true };
  });
  route("GET", "/:review/session", (ctx, workspace) => options.reviewSessions.get(workspace, ctx.params.review));
  route("POST", "/:review/session", (ctx, workspace) => options.reviewSessions.open(workspace, ctx.params.review));
  route("GET", "/:review/results", (ctx, workspace) => {
    const params = ctx.url.searchParams;
    const many = (name: string) => params.has(name) ? params.getAll(name) : undefined;
    const number = (name: string) => params.has(name) ? Number(params.get(name)) : undefined;
    return reviews.results(workspace, ctx.params.review, { revision: number("revision"), offset: number("offset"), limit: number("limit"),
      documentIds: many("documentId"), columnKeys: many("columnKey"), statuses: many("status"), values: many("value"), query: params.get("query") ?? undefined });
  });
  route("POST", "/:review/results/query", async (ctx, workspace) => reviews.queryResults(workspace, ctx.params.review, await body(ctx)), true);
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
