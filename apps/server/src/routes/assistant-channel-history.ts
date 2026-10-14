import { z } from "zod";
import { ApiError } from "../errors.js";
import { addRoute, type Route, type RequestContext } from "./registry.js";
import type { AssistantChannelHistory } from "../assistant-channel-history.js";
import type { TokenScope } from "../types.js";

export function registerAssistantChannelHistoryRoutes(options: { routes: Route[]; history: AssistantChannelHistory;
  requireClientScope: (ctx: RequestContext, scope: TokenScope) => void; json: (value: unknown) => Response }) {
  addRoute(options.routes, "GET", "/assistant/channel-history", "client", async ctx => {
    options.requireClientScope(ctx, "viewer");
    const date = new URL(ctx.request.url).searchParams.get("date") ?? undefined;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, "invalid_date", "Use a calendar date.");
    return options.json(await options.history.history(date));
  });
  addRoute(options.routes, "GET", "/assistant/channel-context", "client", async ctx => {
    options.requireClientScope(ctx, "viewer");
    const sessionId = z.string().min(1).max(200).parse(new URL(ctx.request.url).searchParams.get("sessionId"));
    return options.json({ text: await options.history.context(sessionId) });
  });
  addRoute(options.routes, "GET", "/assistant/channel-days", "client", async ctx => {
    options.requireClientScope(ctx, "viewer");
    const params = new URL(ctx.request.url).searchParams;
    const before = params.get("before") ?? undefined;
    if (before && !/^\d{4}-\d{2}-\d{2}$/.test(before)) throw new ApiError(400, "invalid_date", "Use a calendar date.");
    const limit = z.coerce.number().int().min(1).max(30).parse(params.get("limit") ?? 14);
    return options.json(await options.history.days(before, limit));
  });
}
