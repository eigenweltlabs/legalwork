import type { ServerConfig, TokenScope, WorkspaceInfo } from "../types.js";
import type { OfficeToolExecutionResult, OfficeToolRelay } from "../office-tools.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
type ReadJsonBody = (request: Request) => Promise<Record<string, unknown>>;

interface RegisterOfficeToolRoutesOptions {
  routes: Route[];
  config: ServerConfig;
  officeTools: OfficeToolRelay;
  jsonResponse: JsonResponse;
  readJsonBody: ReadJsonBody;
  requireClientScope: (ctx: RequestContext, required: TokenScope) => void;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
}

/**
 * Office task pane (Word/Excel) tool relay endpoints.
 *
 * - The OpenCode plugin executes tools via POST .../execute and gets the
 *   pane's answer back in the same response.
 * - The pane long-polls .../poll and posts results to .../requests/:id/result.
 *
 * Document edits are mutations, so everything below requires at least a
 * collaborator-scoped token (viewer tokens are read-only by convention).
 */
export function registerOfficeToolRoutes(options: RegisterOfficeToolRoutesOptions): void {
  const { routes, config, officeTools, jsonResponse, readJsonBody, requireClientScope, resolveWorkspace } = options;

  addRoute(routes, "GET", "/workspace/:id/office-tools/status", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const panes = officeTools.connectedPanes(workspace.id);
    return jsonResponse({
      connected: panes.length > 0,
      // One entry per connected pane — Word and Excel can be open at once.
      hosts: panes,
      // Legacy single-pane fields for older consumers.
      documentUrl: panes[0]?.documentUrl ?? null,
      host: panes[0]?.host ?? null,
    });
  });

  addRoute(routes, "POST", "/workspace/:id/office-tools/execute", "client", async (ctx) => {
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
    const result = await officeTools.execute(workspace.id, tool, args, timeoutMs);
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/workspace/:id/office-tools/poll", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const waitRaw = Number(ctx.url.searchParams.get("wait") ?? "25");
    const waitMs = Number.isFinite(waitRaw) ? waitRaw * 1000 : 25_000;
    const documentUrl = ctx.url.searchParams.get("document") ?? undefined;
    const host = ctx.url.searchParams.get("host") ?? undefined;
    const requests = await officeTools.poll(workspace.id, waitMs, documentUrl, host);
    return jsonResponse({ requests });
  });

  addRoute(routes, "POST", "/workspace/:id/office-tools/requests/:requestId/result", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const result: OfficeToolExecutionResult =
      body.ok === true
        ? { ok: true, result: body.result }
        : { ok: false, error: typeof body.error === "string" && body.error ? body.error : "Office tool failed" };
    const accepted = officeTools.complete(ctx.params.requestId, result);
    return jsonResponse({ accepted });
  });
}
