import { ApiError } from "../errors.js";
import { MailServiceError, type MailPageInput, type MailService } from "../mail/service-interface.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

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
      case "not_found": return new ApiError(404, "mail_not_found", "Mail account not found");
      case "locked": return new ApiError(423, "mail_locked", "Mail storage is locked");
      case "too_large": return new ApiError(413, "mail_response_too_large", "Mail response exceeds the supported size");
      case "unavailable": break;
    }
  }
  // Server's generic exception handler logs raw exceptions. Convert all worker,
  // native and keychain failures here so paths/secrets cannot reach that logger.
  return new ApiError(503, "mail_unavailable", "Mail storage is unavailable");
}
async function requireEmptyBody(request: Request): Promise<void> {
  if (!request.body) return;
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        for (let emptyChunks = 0; emptyChunks < 16; emptyChunks++) {
          const part = await reader.read();
          if (part.done) return;
          if (part.value.byteLength) throw new ApiError(400, "mail_invalid_request", "Invalid mail request");
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
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function registerMailRoutes(routes: Route[], host: string, service?: MailService): void {
  if (!service || !isMailLoopback(host)) return;
  function route(method: string, path: string, paginated: boolean, handler: (ctx: RequestContext, page: MailPageInput) => unknown | Promise<unknown>) {
    addRoute(routes, method, `/mail/v1${path}`, "host-token", async ctx => {
      if (ctx.actor?.type !== "host") throw new ApiError(401, "unauthorized", "Invalid host token");
      // Initial commands accept no body, credential or caller-selected owner.
      await requireEmptyBody(ctx.request);
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
}
