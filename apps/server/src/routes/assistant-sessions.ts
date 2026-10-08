import { resolve } from "node:path";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { isMainAssistant } from "../main-assistant.js";
import { readAssistantAttention } from "../assistant-attention.js";
import { addRoute } from "./registry.js";
import type { registerMainAssistantRoutes } from "./main-assistant.js";

export function registerAssistantSessionRoutes(options: Parameters<typeof registerMainAssistantRoutes>[0]) {
  const { config, routes, sessionQueue, jsonResponse } = options;
  const targetSchema = z.object({ workspaceId: z.string().min(1), sessionId: z.string().min(1) });
  const promptSchema = z.string().trim().min(1).max(12000);
  const requestIdSchema = z.string().min(1).max(200).optional();
  const parse = <T>(schema: z.ZodType<T>, raw: unknown) => {
    const result = schema.safeParse(raw);
    if (!result.success) throw new ApiError(400, "assistant_session_input", "Provide a valid chat, action and the required message fields.");
    return result.data;
  };
  const target = async (input: z.infer<typeof targetSchema>) => {
    const workspace = await options.resolveWorkspace(config, input.workspaceId);
    if (workspace.workspaceType === "remote" || isMainAssistant(workspace)) throw new ApiError(400, "assistant_session_target", "Choose a local project chat, not the Assistant itself.");
    const client = options.client(workspace);
    const { data: session } = await client.session.get({ sessionID: input.sessionId }, { throwOnError: true, signal: AbortSignal.timeout(10000) });
    if (!session || session.time.archived || resolve(session.directory) !== resolve(workspace.path)) throw new ApiError(404, "assistant_session_target", "This chat is not available in the selected project.");
    return { workspace, client, session };
  };
  addRoute(routes, "POST", "/assistant/follow-up", "client", async ctx => {
    options.ensureWritable(config); options.requireClientScope(ctx, "collaborator");
    const input = parse(targetSchema.extend({ prompt: promptSchema, requestId: requestIdSchema }), await options.readJsonBodyLimited(ctx.request, 20000));
    const source = config.workspaces.find(isMainAssistant);
    if (!source) throw new ApiError(404, "assistant_missing", "The Assistant is unavailable.");
    await options.resolveWorkspace(config, source.id);
    if (!options.delegations.list(source.id).some(item => item.workspaceId === input.workspaceId && item.sessionId === input.sessionId))
      throw new ApiError(404, "attention_scope", "This chat was not delegated by your Assistant.");
    const { workspace, client, session } = await target(input);
    const pending = await readAssistantAttention(client, { ...input, projectName: workspace.name, sessionTitle: session.title });
    if (pending.some(item => item.kind !== "widget")) throw new ApiError(409, "attention_pending", "Answer the pending question or approval through its exact card first.");
    const message = await sessionQueue.submit({ workspaceId: input.workspaceId, sessionId: input.sessionId }, input.prompt, input.requestId);
    options.changed();
    return jsonResponse({ ok: true, sessionId: input.sessionId, status: message.state, message });
  });
  addRoute(routes, "POST", "/assistant/session-control", "client", async ctx => {
    options.ensureWritable(config); options.requireClientScope(ctx, "collaborator");
    const input = parse(targetSchema.extend({ sourceSessionId: z.string().min(1), requestId: requestIdSchema,
      action: z.enum(["stop", "send", "redirect", "list_queue", "edit_queued", "cancel_queued", "resume_queued"]),
      prompt: promptSchema.optional(), messageId: z.string().min(1).optional(),
    }), await options.readJsonBodyLimited(ctx.request, 20000));
    const source = config.workspaces.find(isMainAssistant);
    if (!source) throw new ApiError(404, "assistant_missing", "The Assistant is unavailable.");
    await options.resolveWorkspace(config, source.id);
    const sourceSession = await options.client(source).session.get({ sessionID: input.sourceSessionId }, { throwOnError: true, signal: AbortSignal.timeout(10000) });
    if (!sourceSession.data || sourceSession.data.time.archived || resolve(sourceSession.data.directory) !== resolve(source.path))
      throw new ApiError(404, "assistant_session_source", "Use session controls from an available Assistant chat.");
    const { session } = await target(input);
    const destination = { workspaceId: input.workspaceId, sessionId: input.sessionId };
    if (input.action === "list_queue") return jsonResponse({ messages: sessionQueue.list(destination) });
    if (input.action === "stop") return jsonResponse({ ok: true, ...await sessionQueue.stop(destination) });
    if (input.action === "send" || input.action === "redirect") {
      if (!input.prompt) throw new ApiError(400, "assistant_session_prompt", "Provide the user's instruction before sending or redirecting.");
      const receipt = sessionQueue.receipt(destination, input.prompt, input.requestId);
      if (receipt) return jsonResponse({ ok: true, status: receipt.state, message: receipt });
      if (input.action === "redirect") await sessionQueue.stop(destination);
      options.delegations.track({ ...destination, sourceWorkspaceId: source.id, sourceSessionId: input.sourceSessionId,
        title: session.title, scope: input.prompt, model: null });
      const message = await sessionQueue.submit(destination, input.prompt, input.requestId);
      options.changed();
      return jsonResponse({ ok: true, status: message.state, message });
    }
    if (!input.messageId || input.action === "edit_queued" && !input.prompt) throw new ApiError(400, "assistant_queue_input", "Provide the queued message ID and the replacement text when editing.");
    const action = input.action === "cancel_queued" ? "cancel" : input.action === "edit_queued" ? "edit" : "resume";
    return jsonResponse({ ok: true, message: await sessionQueue.update(destination, input.messageId, action, input.prompt) });
  });
}
