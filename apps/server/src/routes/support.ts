import { createEngineClient, getWorkspaceEngineSession } from "../engine-client.js";
import { ApiError } from "../errors.js";
import { summarizeChatDiagnostics } from "../support-chat-diagnostics.js";
import { readSupportContact, submitSupportTicket, supportTicketAvailable, supportTicketInput } from "../support-ticket.js";
import type { ServerConfig } from "../types.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

export function registerSupportRoutes({ routes, config, jsonResponse, readJsonBodyLimited }: {
  routes: Route[];
  config: ServerConfig;
  jsonResponse: (data: unknown) => Response;
  readJsonBodyLimited: (request: Request, limit: number) => Promise<unknown>;
}) {
  function chat(ctx: RequestContext) {
    const access = ctx.agentAccess;
    if (!access || access.reviewWorker) throw new ApiError(403, "support_chat_required", "Open this request in a LegalWork chat.");
    return access;
  }
  function canSend(ctx: RequestContext) {
    const access = chat(ctx);
    return access.actor.scope === "owner" && access.sessionId === access.originSessionId && !access.scheduledProjects;
  }

  addRoute(routes, "GET", "/support/contact", "host-token", async ctx => {
    if (ctx.agentAccess) throw new ApiError(403, "support_contact_denied", "Open the LegalWork Help menu to view support contacts.");
    const response = jsonResponse(await readSupportContact(config, ctx.request.signal));
    response.headers.set("Cache-Control", "no-store");
    return response;
  });

  addRoute(routes, "GET", "/agent/support/diagnostics", "client", async ctx => {
    const { sessionId, workspace } = chat(ctx);
    if (!workspace) throw new ApiError(404, "support_chat_unavailable", "This chat's technical history is unavailable.");
    const engine = createEngineClient(config, workspace, { fileReferences: true });
    await getWorkspaceEngineSession(engine, workspace, sessionId, ctx.request.signal);
    const messages = await engine.message.list({ sessionID: sessionId, limit: 40, order: "desc" }, { signal: ctx.request.signal });
    return jsonResponse(summarizeChatDiagnostics(messages.data, config.desktopSupport?.readChatLog(sessionId) ?? []));
  });

  addRoute(routes, "GET", "/agent/support/ticket", "client", async ctx =>
    jsonResponse({ available: canSend(ctx) && await supportTicketAvailable(config) }));

  let submitting = false;
  addRoute(routes, "POST", "/agent/support/ticket", "client", async ctx => {
    if (!canSend(ctx)) throw new ApiError(403, "support_ticket_denied", "Open a local interactive LegalWork chat to submit a ticket.");
    const input = supportTicketInput.safeParse(await readJsonBodyLimited(ctx.request, 16 * 1024));
    if (!input.success) throw new ApiError(400, "support_description_invalid", "Enter a short technical problem description.");
    if (submitting) throw new ApiError(409, "support_ticket_pending", "A support ticket confirmation is already open.");
    submitting = true;
    try { return jsonResponse(await submitSupportTicket(config, input.data, ctx.request.signal)); }
    finally { submitting = false; }
  });
}
