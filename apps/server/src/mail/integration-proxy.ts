import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import { savedConnectorConnections } from "../connectors/broker.js";
import { connectorIsActivated } from "../connectors/settings.js";
import { requireLocalOAuthSendAccess, requireLocalOAuthOrganizeAccess, localOAuthMailAccess } from "../connectors/local-oauth.js";
import { createConnectorRequest, type StreamingConnectorRequest, type ConnectorRequestOptions } from "../connectors/request.js";
import { mailIntegrationAccountSchema, type MailIntegrationAccount, type MailIntegrationSnapshot } from "./integration-view.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const gmailProfile = "/gmail/v1/users/me/profile?fields=emailAddress";
const graphProfile = "/v1.0/me?$select=id,displayName,mail,userPrincipalName";
const identitySchema = z.object({ identity: z.string().min(1).max(500), email: z.email().max(320), displayName: z.string().max(1024) });
const methods = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const forwardedHeaders = ["content-type", "if-match", "prefer", "content-range"];
type ConnectorId = MailIntegrationAccount["connectorId"];
type RequestFactory = (id: ConnectorId, connectionId: string, verifyAccess?: (token: string) => Promise<boolean>) => Promise<StreamingConnectorRequest>;
type IntegrationSource = {
  connections: (id: ConnectorId) => ReturnType<typeof savedConnectorConnections>;
  activated: (id: ConnectorId, connectionId: string) => Promise<boolean>;
  send: (id: ConnectorId, connectionId: string) => Promise<void>;
  organize: (id: ConnectorId, connectionId: string) => Promise<void>;
  optionalAccess?: (id: ConnectorId, connectionId: string) => ReturnType<typeof localOAuthMailAccess>;
};
const handleOf = (id: ConnectorId, connection: { id: string; createdAt: string | null }) => digest(JSON.stringify([id, connection.id, connection.createdAt]));

function identity(id: ConnectorId, value: unknown) {
  if (id === "gmail") {
    const profile = z.object({ emailAddress: z.email().max(320) }).parse(value);
    // Gmail's mail-only grant exposes its address, not an OIDC subject. Pin it
    // within this exact connector handle; never merge archives by address.
    return identitySchema.parse({ identity: profile.emailAddress.toLowerCase(), email: profile.emailAddress, displayName: profile.emailAddress });
  }
  const profile = z.object({ id: z.string().min(1).max(500), displayName: z.string().nullish(), mail: z.email().nullish(), userPrincipalName: z.email().nullish() }).parse(value);
  const email = profile.mail ?? profile.userPrincipalName;
  return identitySchema.parse({ identity: profile.id, email, displayName: profile.displayName ?? email });
}

async function json(response: Response) {
  const bytes = await boundedBody(response, 64 * 1024);
  return JSON.parse(await bytes.text());
}
async function boundedBody(request: Request | Response, limit = 256 * 1024 * 1024): Promise<Blob> {
  const reader = request.body?.getReader();
  if (!reader) return new Blob();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) throw new ApiError(413, "mail_integration_too_large", "Mail content exceeds the supported provider upload size.");
      chunks.push(Uint8Array.from(chunk.value));
    }
    return new Blob(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}

/** One private transport into the existing connector account and refresh layer.
 * Provider credentials never cross this boundary into the encrypted worker. */
export class MailIntegrationProxy {
  private readonly capability = randomBytes(32).toString("hex");
  private readonly accounts = new Map<string, MailIntegrationAccount>();
  private readonly verified = new Map<string, Promise<boolean>>();
  private readonly uploads = new Map<string, { accountId: string; expiresAt: number; mailAccess?: ConnectorRequestOptions["mailAccess"] }>();
  private closed = false;
  private readonly request: RequestFactory;
  private readonly transport: typeof fetch;
  private readonly source: IntegrationSource;

  constructor(private readonly config: ServerConfig, options: { request?: RequestFactory; fetch?: typeof fetch; source?: IntegrationSource } = {}) {
    this.request = options.request ?? ((id, connectionId, verifyAccess) => createConnectorRequest(config, id, connectionId, { verifyAccess }));
    this.transport = options.fetch ?? fetch;
    this.source = options.source ?? {
      connections: id => savedConnectorConnections(config, id), activated: (id, connectionId) => connectorIsActivated(config, id, connectionId),
      send: (id, connectionId) => requireLocalOAuthSendAccess(config, id, connectionId), organize: (id, connectionId) => requireLocalOAuthOrganizeAccess(config, id, connectionId),
      optionalAccess: (id,connectionId)=>localOAuthMailAccess(config,id,connectionId),
    };
  }

  private scanning?: Promise<MailIntegrationSnapshot>;
  snapshot(): Promise<MailIntegrationSnapshot> {
    if (this.scanning) return this.scanning;
    const scanning = this.scan(); this.scanning = scanning;
    void scanning.finally(() => { if (this.scanning === scanning) this.scanning = undefined; }).catch(() => {});
    return scanning;
  }
  private async scan(): Promise<MailIntegrationSnapshot> {
    if (this.closed) throw new Error("mail_integration_closed");
    const handles: string[] = [], found: MailIntegrationAccount[] = [];
    for (const id of mailIntegrationAccountSchema.shape.connectorId.options) {
      // Failure to read saved metadata must not be mistaken for disconnection.
      const connections = await this.source.connections(id);
      for (const connection of connections) {
        if (!await this.source.activated(id, connection.id)) continue;
        const handle = handleOf(id, connection);
        handles.push(handle);
        try {
          const request = await this.request(id, connection.id);
          const profile = identity(id, await request(id === "gmail" ? gmailProfile : graphProfile));
          let write = true, send = true, organize = true;
          try { await request.assertWrite(); } catch { write = false; }
          try { await this.source.send(id, connection.id); } catch { send = false; }
          try { await this.source.organize(id, connection.id); } catch { organize = false; }
          const scopes = id === "gmail" ? ["https://www.googleapis.com/auth/gmail.readonly", ...(write && organize ? ["https://www.googleapis.com/auth/gmail.modify"] : []), ...(write && send ? ["https://www.googleapis.com/auth/gmail.send"] : [])]
            : ["User.Read", write ? "Mail.ReadWrite" : "Mail.Read", "MailboxSettings.Read", ...(write && send ? ["Mail.Send"] : [])];
          const optional=await this.source.optionalAccess?.(id,connection.id);
          if(optional?.contacts)scopes.push(id==='gmail'?'https://www.googleapis.com/auth/contacts.readonly':'Contacts.Read');
          if(id==='outlook'&&optional?.sharedMailboxes){scopes.push(write&&optional.sharedWrite?'Mail.ReadWrite.Shared':'Mail.Read.Shared');if(write&&send&&optional.sharedSend)scopes.push('Mail.Send.Shared');}
          const account = mailIntegrationAccountSchema.parse({
            accountId: `mail_${digest(JSON.stringify(["integrations", handle, profile.identity]))}`,
            handle, connectorId: id, connectionId: connection.id, ...profile, scopes,
          });
          const previous = this.accounts.get(account.accountId);
          found.push(previous && JSON.stringify(previous) === JSON.stringify(account) ? previous : account);
        } catch {
          // Keep previously verified metadata during a temporary provider or
          // broker outage. The per-request identity fence still governs access.
          const previous = [...this.accounts.values()].find(account => account.handle === handle);
          if (previous) found.push(previous);
        }
      }
    }
    if (this.closed) throw new Error("mail_integration_closed");
    this.accounts.clear();
    for (const account of found) this.accounts.set(account.accountId, account);
    return { configuration: { origin: `http://${this.config.host === "::1" ? "[::1]" : "127.0.0.1"}:${this.config.port}`, capability: this.capability }, handles, accounts: found };
  }

  private verify(account: MailIntegrationAccount, token: string, signal: AbortSignal): Promise<boolean> {
    const key = `${account.accountId}:${digest(token)}`;
    let pending = this.verified.get(key);
    if (pending) return pending;
    if (this.verified.size >= 128) this.verified.clear();
    pending = (async () => {
      const response = await this.transport((account.connectorId === "gmail" ? "https://gmail.googleapis.com" + gmailProfile : "https://graph.microsoft.com" + graphProfile), {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      });
      if (response.status === 401) { await response.body?.cancel(); return false; }
      if (!response.ok) { await response.body?.cancel(); throw new ApiError(409, "mail_integration_identity_unavailable", "This mailbox identity could not be verified. Check the connection in Integrations."); }
      const current = identity(account.connectorId, await json(response));
      if (current.identity !== account.identity) throw new ApiError(409, "mail_integration_identity_changed", "This connection now belongs to a different mailbox. Refresh Email before continuing.");
      return true;
    })();
    this.verified.set(key, pending);
    void pending.then(valid => { if (!valid) this.verified.delete(key); }, () => this.verified.delete(key));
    return pending;
  }

  private endpoint(account: MailIntegrationAccount, value: string, method: z.infer<typeof methods>) {
    if (value.length > 32768 || value.includes("\\")) throw new ApiError(400, "mail_integration_endpoint", "Invalid mail endpoint.");
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash || /%(?:2e|2f|5c)/i.test(url.pathname)) throw new ApiError(400, "mail_integration_endpoint", "Invalid mail endpoint.");
    if (url.origin === "https://outlook.office.com") {
      const upload = this.uploads.get(url.href);
      if (account.connectorId !== "outlook" || method !== "PUT" || upload?.accountId !== account.accountId || upload.expiresAt <= Date.now()) throw new ApiError(403, "mail_integration_upload", "This attachment upload is no longer authorized.");
      return { url, upload: true, send: false, organize: false, mailAccess: upload.mailAccess };
    }
    const path = url.pathname;
    const contacts=method==='GET'&&(account.connectorId==='gmail'?url.origin==='https://people.googleapis.com'&&path==='/v1/people/me/connections':url.origin==='https://graph.microsoft.com'&&/^\/v1\.0\/me\/(?:contacts|contactFolders\/[^/]+\/contacts\/delta)(?:$|\/[^/]+$)/.test(path));
    if(contacts){
      const google=account.connectorId==='gmail';
      const keys=new Set(google?['personFields','sources','pageSize','requestSyncToken','syncToken','pageToken','sortOrder']:['$select','$top','$skip','$skiptoken','$deltatoken']);
      const seen=new Set<string>();
      if([...url.searchParams.keys()].some(key=>{const name=google?key:key.toLowerCase();if(!keys.has(name)||seen.has(name))return true;seen.add(name);return false;}))throw new ApiError(403,'mail_integration_endpoint','Unsupported contacts query.');
      const fields=[...url.searchParams].find(([key])=>(google?key:key.toLowerCase())===(google?'personFields':'$select'))?.[1];
      if(google&&url.searchParams.has('sources')&&url.searchParams.get('sources')!=='READ_SOURCE_TYPE_CONTACT')throw new ApiError(403,'mail_integration_endpoint','Only personal contacts are supported.');
      const allowedFields=new Set(google?['names','emailAddresses','metadata']:['id','displayName','emailAddresses','parentFolderId']);
      if(fields?.split(',').some(field=>!allowedFields.has(field)))throw new ApiError(403,'mail_integration_endpoint','Unsupported contacts fields.');
    }
    const mailAccess:ConnectorRequestOptions['mailAccess']=contacts?'contacts':account.connectorId==='outlook'&&/^\/v1\.0\/users\//.test(path)?'sharedMailboxes':undefined;
    const allowed = contacts || (account.connectorId === "gmail"
      ? url.origin === "https://gmail.googleapis.com" && /^\/(?:upload\/)?gmail\/v1\/users\/me\/(?:profile|history|messages|threads|labels|drafts|settings\/sendAs)(?:\/|$)/.test(path)
      : url.origin === "https://graph.microsoft.com" && (/^\/v1\.0\/(?:me|organization)$/.test(path) || /^\/v1\.0\/(?:me|users\/[^/]+)\/(?:messages|mailFolders|mailboxSettings|sendMail)(?:\/|$)/.test(path)));
    if (!allowed) throw new ApiError(403, "mail_integration_endpoint", "This account only authorizes mail endpoints.");
    if (method !== "GET") {
      const writing = account.connectorId === "gmail"
        ? /\/(?:messages\/(?:send|batchModify|batchDelete)|messages\/[^/]+(?:\/(?:modify|trash|untrash))?|drafts(?:\/[^/]+(?:\/send)?)?)$/.test(path)
        : /\/(?:sendMail|messages(?:\/[^/]+(?:\/(?:send|move|copy|attachments(?:\/createUploadSession|\/[^/]+)?))?)?)$/.test(path);
      if (!writing) throw new ApiError(403, "mail_integration_endpoint", "This mail operation is not supported.");
    }
    const send = method !== "GET" && /\/(?:sendMail|send)$/.test(path);
    const draftWrite = /\/(?:drafts|attachments)(?:\/|$)/.test(path) || account.connectorId === "outlook" && method === "POST" && /\/messages$/.test(path);
    return { url, upload: false, send, organize: method !== "GET" && !send && !draftWrite, mailAccess };
  }

  async handle(request: Request): Promise<Response> {
    const supplied = request.headers.get("x-legalwork-mail-capability");
    if (this.closed || !supplied || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(this.capability))) return new Response(null, { status: 401 });
    const accountId = request.headers.get("x-legalwork-mail-account") ?? "";
    const account = this.accounts.get(accountId);
    if (!account) return new Response(null, { status: 401 });
    try {
      const connections = await this.source.connections(account.connectorId);
      if (connections.length !== 1 || !connections.some(connection => connection.id === account.connectionId && handleOf(account.connectorId, connection) === account.handle && !connection.needsReconnect) || !await this.source.activated(account.connectorId, account.connectionId)) return new Response(null, {status: 401});
      const method = methods.parse(request.headers.get("x-legalwork-mail-method"));
      const target = this.endpoint(account, request.headers.get("x-legalwork-mail-endpoint") ?? "", method);
      const assertOptional=async()=>{if(!target.mailAccess)return;const access=await this.source.optionalAccess?.(account.connectorId,account.connectionId);if(!access?.[target.mailAccess]||target.mailAccess==='sharedMailboxes'&&method!=='GET'&&(target.send?!access.sharedSend:!access.sharedWrite))throw new ApiError(403,'connector_permission_required','Optional email permission is not enabled for this account.');};
      await assertOptional();
      const connector = await this.request(account.connectorId, account.connectionId, token => this.verify(account, token, request.signal));
      const headers = Object.fromEntries(forwardedHeaders.flatMap(name => { const value = request.headers.get(name); return value === null ? [] : [[name, value]]; }));
      const rawBody = request.body ? await boundedBody(request) : undefined;
      let response: Response;
      if (target.upload) {
        await connector.assertWrite();
        // Recheck identity through a harmless provider read before every signed
        // upload chunk. Upload URLs themselves never receive an OAuth token.
        await connector(account.connectorId === "gmail" ? gmailProfile : graphProfile);
        await connector.assertWrite();await assertOptional();
        response = await this.transport(target.url, { method, headers, body: rawBody, redirect: "error", signal: request.signal });
      } else {
        const options: ConnectorRequestOptions = { method, headers, rawBody, bytes: true, send: target.send, organize: target.organize, signal: request.signal, providerStatus: true, mailAccess: target.mailAccess };
        response = await connector.response(target.url.pathname + target.url.search, options);
        if (account.connectorId === "outlook" && method === "POST" && target.url.pathname.endsWith("/createUploadSession") && response.ok) {
          const upload = z.object({ uploadUrl: z.url(), expirationDateTime: z.iso.datetime({ offset: true }).optional() }).parse(await json(response.clone()));
          const url = new URL(upload.uploadUrl);
          if (url.origin !== "https://outlook.office.com" || !url.pathname.startsWith("/api/") || url.username || url.password || url.hash) throw new ApiError(502, "mail_integration_upload", "The mail provider returned an invalid upload session.");
          if (this.uploads.size >= 128) for (const [key, value] of this.uploads) if (value.expiresAt <= Date.now()) this.uploads.delete(key);
          if (this.uploads.size >= 128) throw new ApiError(429, "mail_integration_upload", "Finish an existing attachment upload before starting another.");
          this.uploads.set(url.href, {accountId, mailAccess:target.mailAccess, expiresAt: Math.min(Date.now() + 60 * 60_000, upload.expirationDateTime ? Date.parse(upload.expirationDateTime) : Infinity)});
        }
      }
      if (this.closed || this.accounts.get(accountId)?.handle !== account.handle || this.accounts.get(accountId)?.identity !== account.identity) {
        await response.body?.cancel();
        // A mutation may already have happened. Never turn an uncertain send
        // into an authentication failure that is safe to retry automatically.
        return new Response(null, {status: method === "GET" ? 401 : 502});
      }
      const responseHeaders = new Headers({ "Cache-Control": "no-store" });
      for (const name of ["content-type", "retry-after", "etag"]) { const value = response.headers.get(name); if (value !== null) responseHeaders.set(name, value); }
      return new Response(response.body, { status: response.status, headers: responseHeaders });
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 502;
      return Response.json({ error: "Mail connection unavailable. Review the account in Integrations." }, { status, headers: {"Cache-Control":"no-store"} });
    }
  }

  close() { this.closed = true; this.accounts.clear(); this.verified.clear(); this.uploads.clear(); }
}
