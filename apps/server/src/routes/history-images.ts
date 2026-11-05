import { requireSessionImageOrigin, recheckSessionImageOrigin } from "../session-image-authority.js";
import { ApiError } from "../errors.js";
import { createEngineClient } from "../engine-client.js";
import { historyImageListInput, historyImageReference } from "../session-history-image-schema.js";
import { listHistoryImages, nativeHistoryImageSource, readHistoryImage } from "../session-history-images.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

export function registerHistoryImageRoutes(options: {
  routes: Route[]; config: ServerConfig;
  resolveWorkspace: (config: ServerConfig, id: string) => Promise<WorkspaceInfo>;
  jsonResponse: (input: unknown, status?: number) => Response;
}) {
  const { routes, config, resolveWorkspace, jsonResponse } = options;
  async function respond(ctx: RequestContext, read: boolean) {
    const before = await requireSessionImageOrigin(config, ctx.request, ctx.params.sessionId);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const source = nativeHistoryImageSource(createEngineClient(config, workspace));
    const result = await (async () => {
      if (read) {
        const parsed = historyImageReference.safeParse(await ctx.request.json().catch(() => null));
        if (!parsed.success) throw new ApiError(400, "invalid_history_image_request", "Use an exact stored image reference from the history image list.");
        return readHistoryImage(source, workspace, before.sessionId, parsed.data, ctx.request.signal);
      }
      const parsed = historyImageListInput.safeParse(Object.fromEntries(ctx.url.searchParams));
      if (!parsed.success) throw new ApiError(400, "invalid_history_image_request", "Use a chat ID and the native history cursor, when provided.");
      return listHistoryImages(source, workspace, before.sessionId, parsed.data.sessionID ?? before.sessionId, parsed.data.cursor, ctx.request.signal);
    })();
    await recheckSessionImageOrigin(config, ctx.request, before);
    return jsonResponse(result);
  }
  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/history-images", "client", ctx => respond(ctx, false));
  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/history-images/read", "client", ctx => respond(ctx, true));
}
