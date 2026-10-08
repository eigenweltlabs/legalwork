import { resolve } from "node:path";
import { z } from "zod";
import { AssistantAttentionRefSchema, AssistantAttentionReplySchema, AssistantAttentionPresentSchema } from "@legalwork/types/main-assistant";
import { ApiError } from "../errors.js";
import { isMainAssistant } from "../main-assistant.js";
import { readAssistantAttention, replyToAssistantAttention } from "../assistant-attention.js";
import { addRoute } from "./registry.js";
import type { registerMainAssistantRoutes } from "./main-assistant.js";

function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "attention_input", "Provide an exact request, its current revision, and a valid response.");
  return parsed.data;
}

export function registerAssistantAttentionRoutes(options: Parameters<typeof registerMainAssistantRoutes>[0]) {
  const { routes, config, delegations, jsonResponse } = options;
  const locks = new Set<string>();
  const tracked = async () => {
    const source = config.workspaces.find(isMainAssistant);
    if (!source) return [];
    await options.resolveWorkspace(config, source.id);
    return delegations.list(source.id);
  };
  const read = async (workspaceId: string, sessionId: string) => {
    const delegation = (await tracked()).find(item => item.workspaceId === workspaceId && item.sessionId === sessionId);
    if (!delegation) throw new ApiError(404, "attention_scope", "This chat was not delegated by your Assistant.");
    const workspace = await options.resolveWorkspace(config, workspaceId);
    const client = options.client(workspace);
    const session = await client.session.get({ sessionID: sessionId }, { throwOnError: true, signal: AbortSignal.timeout(10000) });
    if (!session.data || resolve(session.data.directory) !== resolve(workspace.path) || session.data.time.archived)
      throw new ApiError(404, "attention_session", "This project chat is no longer available.");
    const items = await readAssistantAttention(client, { workspaceId, sessionId, projectName: workspace.displayName || workspace.name, sessionTitle: session.data.title });
    const merged = new Map([...delegations.widgets(sessionId).filter(item => delegations.presentation(item).presentation), ...items].map(item => [item.id, item]));
    return { client, items: [...merged.values()].map(item => ({ ...item, ...delegations.presentation(item) })) };
  };
  addRoute(routes, "GET", "/assistant/attention", "client", async ctx => {
    options.requireClientScope(ctx, "viewer");
    const query = parseInput(z.object({ presented: z.enum(["true"]).optional(), cursor: z.string().optional(), workspaceId: z.string().optional(), sessionId: z.string().optional() }), Object.fromEntries(new URL(ctx.request.url).searchParams));
    const cards = query.presented ? delegations.cards() : [];
    const all = (await tracked()).filter(item => (!query.presented || cards.some(card => card.workspaceId === item.workspaceId && card.sessionId === item.sessionId)) && (!query.workspaceId || item.workspaceId === query.workspaceId) && (!query.sessionId || item.sessionId === query.sessionId));
    const index = query.cursor ? all.findIndex(item => item.sessionId === query.cursor) + 1 : 0;
    if (query.cursor && !index) throw new ApiError(400, "attention_cursor", "Refresh the request list.");
    const page = all.slice(index, index + 10);
    const results = await Promise.allSettled(page.map(item => read(item.workspaceId, item.sessionId)));
    return jsonResponse({ items: results.flatMap(result => result.status === "fulfilled" ? result.value.items.filter(item => !query.presented || item.presentation) : []),
      unavailable: results.flatMap((result, index) => result.status === "rejected" ? [page[index].sessionId] : []),
      nextCursor: index + page.length < all.length ? page.at(-1)?.sessionId ?? null : null });
  });
  const exact = async (input: z.infer<typeof AssistantAttentionRefSchema>) => {
    const result = await read(input.workspaceId, input.sessionId);
    const item = result.items.find(item => item.id === input.id);
    if (!item || item.revision !== input.revision) throw new ApiError(409, "attention_stale", "This request was answered or changed. Refresh the panel.");
    return { ...result, item };
  };
  addRoute(routes, "POST", "/assistant/attention/present", "client", async ctx => {
    options.ensureWritable(config); options.requireClientScope(ctx, "collaborator");
    const input = parseInput(AssistantAttentionPresentSchema, await options.readJsonBodyLimited(ctx.request, 4000));
    const { item } = await exact(input);
    delegations.saveWidget(item);
    delegations.present(input);
    options.changed();
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "POST", "/assistant/attention/visibility", "client", async ctx => {
    options.ensureWritable(config); options.requireClientScope(ctx, "collaborator");
    const input = parseInput(AssistantAttentionRefSchema.extend({ visible: z.boolean() }), await options.readJsonBodyLimited(ctx.request, 4000));
    await exact(input);
    if (!delegations.setCardVisibility(input, input.visible)) throw new ApiError(409, "attention_unpresented", "Your Assistant has not presented this card.");
    options.changed();
    return jsonResponse({ ok: true });
  });
  addRoute(routes, "POST", "/assistant/attention/reply", "client", async ctx => {
    options.ensureWritable(config); options.requireClientScope(ctx, "collaborator");
    const input = parseInput(AssistantAttentionReplySchema, await options.readJsonBodyLimited(ctx.request, 64000));
    if (locks.has(input.id)) throw new ApiError(409, "attention_busy", "This response is already being sent.");
    locks.add(input.id);
    try {
      const { client, item } = await exact(input);
      await replyToAssistantAttention(client, item, input);
      options.changed();
      return jsonResponse({ ok: true, workspaceId: item.workspaceId, sessionId: item.sessionId });
    } finally { locks.delete(input.id); }
  });
}
