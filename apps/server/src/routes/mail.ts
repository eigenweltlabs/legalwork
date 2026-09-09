import { ApiError } from "../errors.js";
import { z } from "zod";
import { MailServiceError, type MailPageInput, type MailService } from "../mail/service-interface.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";
import { providerMessageLocatorSchema } from "../mail/model.js";
import { mailMessagePageSchema, mailPartPageSchema, mailContentReadSchema } from "../mail/read-view.js";

export function isMailLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1";
}
function pageInput(ctx: RequestContext, paginated: boolean): MailPageInput {
  const page: MailPageInput = {};
  for (const [key, value] of ctx.url.searchParams) {
    if (!paginated || !["limit", "after"].includes(key) || ctx.url.searchParams.getAll(key).length !== 1) throw new ApiError(400, "mail_invalid_request", "Invalid mail request");
    if (key === "limit") {
      if (!/^[1-9]\d{0,2}$/.test(value) || Number(value) > 100) throw new ApiError(400, "mail_invalid_request", "Invalid mail request");
      page.limit = Number(value);
    } else {
      if (!value.length || value.length > 4096) throw new ApiError(400, "mail_invalid_request", "Invalid mail request");
      page.after = value;
    }
  }
  return page;
}
function safeError(error: unknown): ApiError {
  if (error instanceof MailServiceError) {
    switch (error.code) {
      case "not_found": return new ApiError(404, "mail_not_found", "Mail resource not found");
      case "locked": return new ApiError(423, "mail_locked", "Mail storage is locked");
      case "too_large": return new ApiError(413, "mail_response_too_large", "Mail response exceeds the supported size");
      case "unsupported": return new ApiError(501, "mail_provider_unsupported", "Synchronization is not available for this provider");
      case "unavailable": break;
    }
  }
  // Server's generic exception handler logs raw exceptions. Convert all worker,
  // native and keychain failures here so paths/secrets cannot reach that logger.
  return new ApiError(503, "mail_unavailable", "Mail storage is unavailable");
}
async function readMailBody(request: Request, maxBytes = 0): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        for (let count = 0; count < maxBytes + 16; count++) {
          const part = await reader.read();
          if (part.done) return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
          size += part.value.byteLength;
          if (size > maxBytes) throw new ApiError(400, "mail_invalid_request", "Invalid mail request");
          chunks.push(part.value);
        }
        throw new ApiError(400, "mail_invalid_request", "Invalid mail request");
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ApiError(408, "mail_request_timeout", "Mail request timed out")), 2000); }),
    ]);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "mail_invalid_request", "Invalid mail request");
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* Pending read cancellation owns cleanup. */ }
  }
}
export function registerMailRoutes(routes: Route[], host: string, service?: MailService): void {
  if (!service || !isMailLoopback(host)) return;
  function route(method: string, path: string, paginated: boolean, handler: (ctx: RequestContext, page: MailPageInput) => unknown | Promise<unknown>) {
    addRoute(routes, method, `/mail/v1${path}`, "host-token", async ctx => {
      if (ctx.actor?.type !== "host") throw new ApiError(401, "unauthorized", "Invalid host token");
      await readMailBody(ctx.request);
      const page = pageInput(ctx, paginated);
      try {
        const result = await handler(ctx, page);
        return Response.json(result, { headers: { "Cache-Control": "no-store" } });
      } catch (error) { throw safeError(error); }
    });
  }
  route("GET", "/status", false, () => service.status());
  route("POST", "/unlock", false, async () => { await service.unlock(); return service.status(); });
  route("POST", "/lock", false, async () => { await service.lock(); return service.status(); });
  route("GET", "/accounts", true, (_, page) => service.listAccounts(page));
  route("GET", "/accounts/:accountId/folders", true, (ctx, page) => service.listFolders(ctx.params.accountId, page));
  const connectionInput = z.object({ provider: z.enum(["gmail", "graph"]), reconnectAccountId: z.string().min(1).max(4096).optional() }).strict();
  addRoute(routes, "POST", "/mail/v1/connections", "host-token", async ctx => {
    if (ctx.actor?.type !== "host") throw new ApiError(401, "unauthorized", "Invalid host token");
    pageInput(ctx, false);
    if (ctx.request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new ApiError(400, "mail_invalid_request", "Invalid mail request");
    const raw = await readMailBody(ctx.request, 8192);
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new ApiError(400, "mail_invalid_request", "Invalid mail request"); }
    const parsed = connectionInput.safeParse(value);
    if (!parsed.success) throw new ApiError(400, "mail_invalid_request", "Invalid mail request");
    try {
      const result = await service.beginConnection(parsed.data.provider, parsed.data.reconnectAccountId);
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (error) { throw safeError(error); }
  });
  route("GET", "/connections/:connectionId", false, ctx => service.connectionStatus(ctx.params.connectionId));
  route("POST", "/connections/:connectionId/cancel", false, async ctx => { await service.cancelConnection(ctx.params.connectionId); return { cancelled: true }; });
  route("POST", "/accounts/:accountId/disconnect", false, async ctx => { await service.disconnectAccount(ctx.params.accountId); return { disconnected: true }; });
  route("GET", "/accounts/:accountId/sync", false, ctx => service.syncStatus(ctx.params.accountId));
  route("POST", "/accounts/:accountId/sync/start", false, ctx => service.startSync(ctx.params.accountId));
  route("POST", "/accounts/:accountId/sync/pause", false, ctx => service.pauseSync(ctx.params.accountId));
  function query<T>(path: string, schema: z.ZodType<T>, handler: (accountId: string, input: T) => Promise<unknown>) {
    addRoute(routes, "POST", `/mail/v1/accounts/:accountId/messages/${path}`, "host-token", async ctx => {
      if (ctx.actor?.type !== "host") throw new ApiError(401, "unauthorized", "Invalid host token");
      pageInput(ctx, false);
      if (ctx.request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new ApiError(400, "mail_invalid_request", "Invalid mail request");
      const raw = await readMailBody(ctx.request, 32768);
      let value: unknown;
      try { value = JSON.parse(raw); } catch { throw new ApiError(400, "mail_invalid_request", "Invalid mail request"); }
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new ApiError(400, "mail_invalid_request", "Invalid mail request");
      try { return Response.json(await handler(ctx.params.accountId, parsed.data), { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }); }
      catch (error) { throw safeError(error); }
    });
  }
  query("query", mailMessagePageSchema, (accountId, input) => service.listMessages(accountId, input));
  query("read", z.object({ locator: providerMessageLocatorSchema }).strict(), (accountId, input) => service.readMessage(accountId, input.locator));
  query("parts", z.object({ locator: providerMessageLocatorSchema, page: mailPartPageSchema.default({ limit: 50 }) }).strict(), (accountId, input) => service.listParts(accountId, input.locator, input.page));
  query("content", z.object({ locator: providerMessageLocatorSchema, request: mailContentReadSchema }).strict(), (accountId, input) => service.readContent(accountId, input.locator, input.request));
}
