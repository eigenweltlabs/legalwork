import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import type { WordToolExecutionResult, WordToolRelay } from "../word-tools.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

interface RegisterWordToolRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  wordTools: WordToolRelay;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}

/**
 * Word task pane tool relay endpoints.
 *
 * - The OpenCode plugin executes tools via POST .../execute and gets the
 *   pane's answer back in the same response.
 * - The pane long-polls .../poll and posts results to .../requests/:id/result.
 *
 * Document edits are mutations, so everything below requires at least a
 * collaborator-scoped token (viewer tokens are read-only by convention).
 */
export function registerWordToolRoutes(options: RegisterWordToolRoutesOptions): void {
  const { routes, config, wordTools, jsonResponse, readJsonBody, requireClientScope, resolveWorkspace } = options;

  addRoute(routes, "GET", "/workspace/:id/word-tools/status", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse({ connected: wordTools.clientConnected(workspace.id) });
  });

  addRoute(routes, "POST", "/workspace/:id/word-tools/execute", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const tool = typeof body.tool === "string" ? body.tool.trim() : "";
    if (!tool) {
      return jsonResponse({ ok: false, error: "Missing tool name" }, 400);
    }
    const args =
      body.args && typeof body.args === "object" && !Array.isArray(body.args)
        ? (body.args as Record<string, unknown>)
        : {};
    const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : undefined;
    const result = await wordTools.execute(workspace.id, tool, args, timeoutMs);
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/workspace/:id/word-tools/poll", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const waitRaw = Number(ctx.url.searchParams.get("wait") ?? "25");
    const waitMs = Number.isFinite(waitRaw) ? waitRaw * 1000 : 25_000;
    const requests = await wordTools.poll(workspace.id, waitMs);
    return jsonResponse({ requests });
  });

  addRoute(routes, "POST", "/workspace/:id/word-tools/requests/:requestId/result", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const result: WordToolExecutionResult =
      body.ok === true
        ? { ok: true, result: body.result }
        : { ok: false, error: typeof body.error === "string" && body.error ? body.error : "Word tool failed" };
    const accepted = wordTools.complete(ctx.params.requestId, result);
    return jsonResponse({ accepted });
  });
}
