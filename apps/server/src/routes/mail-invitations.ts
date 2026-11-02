import { z } from "zod";
import type { ServerConfig } from "../types.js";
import { ApiError } from "../errors.js";
import { MailServiceError, type MailService } from "../mail/service-interface.js";
import { InvitationReplyError, invitationReplyPreviewInputSchema, invitationReplyConfirmInputSchema } from "../mail/invitation-reply-view.js";
import { MailInvitationReplies } from "../mail/invitations/replies.js";
import { invitationCalendars, openInvitationCalendar } from "../mail/invitations/calendar.js";
import { isMailLoopback, readMailBody } from "./mail.js";
import { addRoute, type Route } from "./registry.js";

export function registerMailInvitationReplyRoutes(routes: Route[], config: ServerConfig, mail?: MailService, replies?: MailInvitationReplies) {
  if (!mail || !isMailLoopback(config.host)) return;
  const service = replies ?? new MailInvitationReplies(mail, (selection, signal, identity) => openInvitationCalendar(config, selection, signal, identity), signal => invitationCalendars(config, signal));
  function route<T>(method: "GET" | "POST", path: string, schema: z.ZodType<T>, handler: (accountId: string, input: T) => Promise<unknown>) {
    addRoute(routes, method, `/mail/v1${path}`, "host-token", async context => {
      if (context.actor?.type !== "host") throw new ApiError(401, "unauthorized", "Invalid host token");
      if (context.url.search) throw new ApiError(400, "mail_invalid_request", "Invalid mail request");
      if (method === "POST" && context.request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new ApiError(400, "mail_invalid_request", "Invalid mail request");
      let raw: unknown;
      try { const body = await readMailBody(context.request, method === "GET" ? 0 : 32768); raw = method === "GET" ? {} : JSON.parse(body); }
      catch { throw new ApiError(400, "mail_invalid_request", "Invalid mail request"); }
      const input = schema.safeParse(raw);
      if (!input.success) throw new ApiError(400, "mail_invalid_request", "Invalid mail request");
      try { return Response.json(await handler(context.params.accountId, input.data), { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }
      catch (error) {
        if (error instanceof InvitationReplyError) throw new ApiError(error.code === "permission" ? 403 : error.code === "not_found" ? 404 : error.code === "unavailable" ? 503 : 409, `mail_invitation_${error.code}`, "Invitation reply unavailable");
        if (error instanceof MailServiceError) throw new ApiError(error.code === "locked" ? 423 : error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 503, `mail_${error.code}`, "Mail is unavailable");
        throw new ApiError(503, "mail_invitation_unavailable", "Invitation reply unavailable");
      }
    });
  }
  route("GET", "/invitations/calendars", z.object({}).strict(), () => service.calendars());
  route("POST", "/accounts/:accountId/messages/invitations/preview", invitationReplyPreviewInputSchema, (accountId, input) => service.preview(accountId, input));
  route("POST", "/accounts/:accountId/messages/invitations/respond", invitationReplyConfirmInputSchema, (accountId, input) => service.respond(accountId, input.token));
  return service;
}
