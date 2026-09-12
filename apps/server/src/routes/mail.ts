import {mailUploadSchema} from "../mail/local-view.js";
import {savedSearchInputSchema} from '../mail/saved-search-view.js';
import {imapConnectionSchema} from '../mail/providers/imap-config.js';
import {extractionRequestSchema,extractionReadSchema} from "../mail/extraction-view.js";
import { mailActionCancelSchema, mailActionReadSchema, mailDraftAttachmentSchema, mailDraftDeleteSchema, mailDraftReadSchema, mailDraftSaveSchema, mailEventQuerySchema, mailLocalPageSchema, mailMutationSchema, mailSubmissionSchema } from "../mail/local-view.js";
import { mailSearchInputSchema, mailSearchRebuildInputSchema } from "../mail/search-view.js";
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
      case "conflict": return new ApiError(409,"mail_conflict","Mail state changed; reload before retrying");
      case "invalid_input": return new ApiError(400,"mail_invalid_request","Invalid mail request");
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
  for (const operation of ["search", "search/rebuild"]) addRoute(routes,"POST",`/mail/v1/${operation}`,"host-token",async ctx=>{
    if(ctx.actor?.type!=="host")throw new ApiError(401,"unauthorized","Invalid host token");
    pageInput(ctx,false);
    if(ctx.request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()!=="application/json")throw new ApiError(400,"mail_invalid_request","Invalid mail request");
    const raw=await readMailBody(ctx.request,16384);let value:unknown;
    try{value=JSON.parse(raw);}catch{throw new ApiError(400,"mail_invalid_request","Invalid mail request");}
    const parsed=operation==="search"?mailSearchInputSchema.safeParse(value):mailSearchRebuildInputSchema.safeParse(value);
    if(!parsed.success)throw new ApiError(400,"mail_invalid_request","Invalid mail request");
    try{
      const result=operation==="search"?await service.search(mailSearchInputSchema.parse(value)):await service.rebuildSearch(mailSearchRebuildInputSchema.parse(value));
      return Response.json(result,{headers:{"Cache-Control":"no-store"}});
    }catch(error){throw safeError(error);}
  });
  addRoute(routes,'POST','/mail/v1/search/saved','host-token',async ctx=>{
    if(ctx.actor?.type!=='host')throw new ApiError(401,'unauthorized','Invalid host token');pageInput(ctx,false);
    if(ctx.request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json')throw new ApiError(400,'mail_invalid_request','Invalid mail request');
    let value:unknown;try{value=JSON.parse(await readMailBody(ctx.request,16384));}catch{throw new ApiError(400,'mail_invalid_request','Invalid mail request');}
    const input=savedSearchInputSchema.safeParse(value);if(!input.success)throw new ApiError(400,'mail_invalid_request','Invalid mail request');
    try{return Response.json(await service.savedSearch(input.data),{headers:{'Cache-Control':'no-store'}});}catch(error){throw safeError(error);}
  });
  route("GET", "/status", false, () => service.status());
  route("POST", "/unlock", false, async () => { await service.unlock(); return service.status(); });
  route("POST", "/lock", false, async () => { await service.lock(); return service.status(); });
  if (service.maintain) {
    const operations: Array<"rotate" | "backup" | "restore"> = ["rotate", "backup", "restore"];
    for (const operation of operations) {
      addRoute(routes, "POST", `/mail/v1/security/${operation}`, "host-token", async ctx => {
        if (ctx.actor?.type !== "host") throw new ApiError(401, "unauthorized", "Invalid host token");
        pageInput(ctx, false);
        let passphrase: string | undefined;
        if (operation === "rotate") await readMailBody(ctx.request);
        else {
          let value: unknown;
          try { value = JSON.parse(await readMailBody(ctx.request, 8192)); } catch { throw new ApiError(400, "mail_invalid_request", "Invalid mail request"); }
          const parsed = z.object({ passphrase: z.string().min(16).max(1024) }).strict().safeParse(value);
          if (!parsed.success || Buffer.byteLength(parsed.data.passphrase) > 1024) throw new ApiError(400, "mail_invalid_request", "Invalid mail request");
          passphrase = parsed.data.passphrase;
        }
        try { await service.maintain?.(operation, passphrase); return Response.json({ completed: true, state: "locked" }, { headers: { "Cache-Control": "no-store" } }); }
        catch (error) { throw safeError(error); }
      });
    }
  }
  route("GET", "/accounts", true, (_, page) => service.listAccounts(page));
  route("GET", "/accounts/:accountId/folders", true, (ctx, page) => service.listFolders(ctx.params.accountId, page));
  addRoute(routes,'POST','/mail/v1/imap/connections','host-token',async ctx=>{
    if(ctx.actor?.type!=='host')throw new ApiError(401,'unauthorized','Invalid host token');pageInput(ctx,false);
    if(ctx.request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json')throw new ApiError(400,'mail_invalid_request','Invalid mail request');
    const body=await readMailBody(ctx.request,60*1024);let value:unknown;try{value=JSON.parse(body);}catch{throw new ApiError(400,'mail_invalid_request','Invalid mail request');}
    const parsed=imapConnectionSchema.extend({requestId:z.uuid().optional()}).safeParse(value);if(!parsed.success)throw new ApiError(400,'mail_invalid_request','Invalid mail request');
    const {requestId,...connection}=parsed.data;
    try{return Response.json(await service.connectImap(connection,requestId),{headers:{'Cache-Control':'no-store'}});}catch(error){throw safeError(error);}
  });
  route('POST','/imap/connections/:connectionId/cancel',false,async ctx=>{if(!z.uuid().safeParse(ctx.params.connectionId).success)throw new ApiError(400,'mail_invalid_request','Invalid mail request');await service.cancelImapConnection(ctx.params.connectionId);return {cancelled:true};});
  route('GET','/accounts/:accountId/imap',true,(ctx,page)=>service.imapDiscovery(ctx.params.accountId,page.after));
  const connectionInput = z.object({ provider: z.enum(["gmail", "graph"]), personal: z.boolean().optional(), reconnectAccountId: z.string().min(1).max(4096).optional() }).strict();
  addRoute(routes, "POST", "/mail/v1/connections", "host-token", async ctx => {
    if (ctx.actor?.type !== "host") throw new ApiError(401, "unauthorized", "Invalid host token");
    pageInput(ctx, false);
    if (ctx.request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new ApiError(400, "mail_invalid_request", "Invalid mail request");
    const raw = await readMailBody(ctx.request, 8192);
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new ApiError(400, "mail_invalid_request", "Invalid mail request"); }
    const parsed = connectionInput.safeParse(value);
    if (!parsed.success || (parsed.data.provider !== "graph" && parsed.data.personal !== undefined)) throw new ApiError(400, "mail_invalid_request", "Invalid mail request");
    try {
      const result = await service.beginConnection(parsed.data.provider, parsed.data.reconnectAccountId, parsed.data.personal);
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
    addRoute(routes, "POST", `/mail/v1/accounts/:accountId/${path}`, "host-token", async ctx => {
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
  query('attachments/extraction/status',extractionRequestSchema,(accountId,input)=>service.extractionStatus(accountId,input));
  query('attachments/extraction/read',extractionReadSchema,(accountId,input)=>service.extractionRead(accountId,input));
  query('attachments/extraction/reset',extractionRequestSchema,(accountId,input)=>service.extractionReset(accountId,input));
  query("messages/query", mailMessagePageSchema, (accountId, input) => service.listMessages(accountId, input));
  query("messages/read", z.object({ locator: providerMessageLocatorSchema }).strict(), (accountId, input) => service.readMessage(accountId, input.locator));
  query("messages/parts", z.object({ locator: providerMessageLocatorSchema, page: mailPartPageSchema.default({ limit: 50 }) }).strict(), (accountId, input) => service.listParts(accountId, input.locator, input.page));
  query("messages/content", z.object({ locator: providerMessageLocatorSchema, request: mailContentReadSchema }).strict(), (accountId, input) => service.readContent(accountId, input.locator, input.request));
  query("drafts/upload",mailUploadSchema,(accountId,input)=>service.uploadDraft(accountId,input));
  query("drafts/save", mailDraftSaveSchema, (accountId,input)=>service.saveDraft(accountId,input));
  query("drafts/read", mailDraftReadSchema, (accountId,input)=>service.readDraft(accountId,input));
  query("drafts/delete", mailDraftDeleteSchema, (accountId,input)=>service.deleteDraft(accountId,input));
  query("drafts/attachment", mailDraftAttachmentSchema, (accountId,input)=>service.readDraftAttachment(accountId,input));
  query("drafts/query", mailLocalPageSchema, (accountId,input)=>service.listDrafts(accountId,input));
  query("actions/submission", mailSubmissionSchema, (accountId,input)=>service.enqueueSubmission(accountId,input));
  query("actions/mutation", mailMutationSchema, (accountId,input)=>service.enqueueMutation(accountId,input));
  query("actions/read", mailActionReadSchema, (accountId,input)=>service.readAction(accountId,input.actionId));
  query("actions/query", mailLocalPageSchema, (accountId,input)=>service.listActions(accountId,input));
  query("actions/cancel", mailActionCancelSchema, (accountId,input)=>service.cancelAction(accountId,input));
  query("events/query", mailEventQuerySchema, (accountId,input)=>service.listEvents(accountId,input));

}
