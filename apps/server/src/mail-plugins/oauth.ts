import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { z } from "zod";
import type { MailProvider } from "@legalwork/types/mail-plugins";
import { ApiError } from "../errors.js";
import { mailJson } from "./http.js";
import { mailRegistration, type MailRegistration } from "./registration.js";
import { MailPluginVault, type SavedMailAccount } from "./vault.js";
import { vaultLock } from "../file-storage/oauth/vault.js";

const tokenSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().optional(), expires_in: z.number().positive(), scope: z.string().optional() });
const googleIdentity = z.object({ sub: z.string().min(1), email: z.email(), email_verified: z.literal(true), name: z.string().optional() });
const graphIdentity = z.object({ id: z.string().min(1), displayName: z.string(), mail: z.string().nullable().optional(), userPrincipalName: z.string().optional() });
export const mailScopes = (provider: MailProvider, canWrite: boolean) => provider === "gmail"
  ? ["openid", "email", "profile", "https://www.googleapis.com/auth/gmail.readonly", ...(canWrite ? ["https://www.googleapis.com/auth/gmail.compose"] : [])]
  : ["openid", "profile", "offline_access", "User.Read", canWrite ? "Mail.ReadWrite" : "Mail.Read", ...(canWrite ? ["Mail.Send"] : [])];
const tokenUrl = (provider: MailProvider) => provider === "gmail" ? "https://oauth2.googleapis.com/token" : "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const normalizeScope = (scope: string) => scope.replace(/^https:\/\/graph.microsoft.com\//, "");
export function grantedMailPermissions(provider: MailProvider, scopes: string[]) {
  return provider === "gmail"
    ? { read: scopes.includes("https://www.googleapis.com/auth/gmail.readonly"), write: scopes.includes("https://www.googleapis.com/auth/gmail.compose") }
    : { read: scopes.includes("Mail.Read") || scopes.includes("Mail.ReadWrite"), write: scopes.includes("Mail.ReadWrite") && scopes.includes("Mail.Send") };
}
type Flow = {
  provider: MailProvider; registration: MailRegistration; server: Server; controller: AbortController;
  status: "pending" | "connected" | "failed" | "expired" | "cancelled"; error: string | null;
  used: boolean; close: () => void; expiresAt: number;
};

export class MailPluginOAuth {
  private flows = new Map<string, Flow>();
  constructor(readonly vault: MailPluginVault) {}
  private key(id: string) { return `${this.vault.path}:account:${id}`; }
  async account(provider: MailProvider, id: string) {
    const account = (await this.vault.read()).accounts.find((item) => item.provider === provider && item.id === id);
    if (!account) throw new ApiError(401, "mail_not_connected", "Connect this email account in Plugins settings.");
    return account;
  }
  private exchange(provider: MailProvider, registration: MailRegistration, fields: Record<string, string>, signal?: AbortSignal) {
    return mailJson(tokenUrl(provider), tokenSchema, { method: "POST", signal,
      body: new URLSearchParams({ client_id: registration.clientId, ...(registration.clientSecret ? { client_secret: registration.clientSecret } : {}), ...fields }) });
  }
  async access(provider: MailProvider, id: string): Promise<SavedMailAccount> {
    return vaultLock(this.key(id), async () => {
      const account = await this.account(provider, id);
      if (account.expiresAt > Date.now() + 60_000) return account;
      const registration = await mailRegistration(provider);
      if (!registration || registration.clientId !== account.clientId) throw new ApiError(401, "mail_reconnect_required", "Reconnect this email account after the sign-in registration change.");
      const token = await this.exchange(provider, registration, { grant_type: "refresh_token", refresh_token: account.refreshToken });
      const scopes = token.scope ? token.scope.split(/\s+/).filter(Boolean).map(normalizeScope) : account.scopes;
      const permissions = grantedMailPermissions(provider, scopes);
      if (!permissions.read) throw new ApiError(403, "mail_scope_missing", "Email read permission was not granted. Reconnect this account.");
      const next = { ...account, accessToken: token.access_token, refreshToken: token.refresh_token ?? account.refreshToken, expiresAt: Date.now() + token.expires_in * 1000, scopes, canWrite: permissions.write };
      await this.vault.update((value) => {
        const index = value.accounts.findIndex((item) => item.id === id && item.connectedAt === account.connectedAt);
        if (index < 0) throw new ApiError(401, "mail_reconnect_required", "This email connection changed during the operation.");
        value.accounts[index] = next;
      });
      return next;
    });
  }
  async status(provider: MailProvider, workspaceId?: string) {
    const saved = await this.vault.read();
    const accounts = saved.accounts.filter((item) => item.provider === provider).map(({ id, email, name, canWrite, connectedAt }) => ({ id, provider, email, name, canWrite, connectedAt, workspaceAccess: workspaceId ? (saved.grants[workspaceId] ?? []).includes(id) : false }));
    return { provider, configured: Boolean(await mailRegistration(provider)), connected: accounts.length > 0, accounts };
  }
  async disconnect(provider: MailProvider, id: string) {
    // Closing pending sign-ins prevents a late callback from restoring a removed account.
    for (const flow of this.flows.values()) if (flow.provider === provider && flow.status === "pending") { flow.status = "cancelled"; flow.close(); }
    return vaultLock(this.key(id), async () => {
      const current = await this.account(provider, id);
      await this.vault.update((value) => { value.accounts = value.accounts.filter((account) => account.id !== id); for (const key of Object.keys(value.grants)) value.grants[key] = value.grants[key]!.filter((accountId) => accountId !== id); });
      let providerRevoked = false;
      if (provider === "gmail") {
        try {
          const response = await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000), body: new URLSearchParams({ token: current.refreshToken }) });
          providerRevoked = response.ok;
          await response.body?.cancel();
        } catch { /* Local removal succeeds even if the provider is unavailable. */ }
      }
      return { ...await this.status(provider), providerRevoked, revocationUrl: provider === "outlook" ? "https://myapps.microsoft.com/" : "https://myaccount.google.com/connections" };
    });
  }
  flowStatus(provider: MailProvider, id: string) {
    const flow = this.flows.get(id);
    if (!flow || flow.provider !== provider) throw new ApiError(404, "mail_signin_unknown", "This email sign-in has expired. Start again.");
    return { status: flow.status, error: flow.error };
  }
  cancel(provider: MailProvider, id: string) {
    const flow = this.flows.get(id);
    if (!flow || flow.provider !== provider) return;
    if (flow.status === "pending") { flow.status = "cancelled"; flow.close(); }
  }
  dispose() { for (const flow of this.flows.values()) flow.close(); this.flows.clear(); }
  async start(provider: MailProvider, canWrite: boolean, workspaceId?: string) {
    const registration = await mailRegistration(provider);
    if (!registration) throw new ApiError(409, "mail_plugin_unavailable", "Google sign-in is not available in this build of LegalWork yet.");
    if (this.flows.size >= 20) {
      for (const [id, flow] of this.flows) if (flow.expiresAt < Date.now()) { flow.close(); this.flows.delete(id); }
      if (this.flows.size >= 20) throw new ApiError(429, "mail_signin_busy", "Finish the current email sign-in before starting another.");
    }
    const id = randomBytes(24).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const controller = new AbortController();
    const expiresAt = Date.now() + 5 * 60_000;
    const path = `/oauth/mail/${provider}/callback`;
    let redirectUri = "";
    const server = createServer(async (request, response) => {
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
      const flow = this.flows.get(id);
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method !== "GET" || url.pathname !== path || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== state || !flow || flow.used || flow.status !== "pending") {
        response.writeHead(400).end("This sign-in link is invalid. Return to LegalWork."); return;
      }
      flow.used = true;
      try {
        const code = url.searchParams.get("code");
        if (!code || url.searchParams.getAll("code").length !== 1 || url.searchParams.has("error")) throw new Error("denied");
        const token = await this.exchange(provider, registration, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }, controller.signal);
        if (!token.refresh_token || !token.scope) throw new Error("grant_incomplete");
        const scopes = token.scope.split(/\s+/).filter(Boolean).map(normalizeScope);
        const permissions = grantedMailPermissions(provider, scopes);
        if (!permissions.read) throw new Error("read_not_granted");
        const headers = { Authorization: `Bearer ${token.access_token}` };
        const identity = provider === "gmail"
          ? await mailJson("https://www.googleapis.com/oauth2/v3/userinfo", googleIdentity, { headers, signal: controller.signal }).then((value) => ({ id: value.sub, email: value.email, name: value.name ?? value.email }))
          : await mailJson("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName", graphIdentity, { headers, signal: controller.signal }).then((value) => ({ id: value.id, email: value.mail || value.userPrincipalName || "", name: value.displayName }));
        if (!identity.email) throw new Error("identity_incomplete");
        const accountId = createHash("sha256").update(JSON.stringify([provider, registration.clientId, identity.id])).digest("hex");
        await vaultLock(this.key(accountId), () => this.vault.update((value) => {
          if (controller.signal.aborted || flow.status !== "pending") throw new Error("cancelled");
          value.accounts = value.accounts.filter((item) => item.id !== accountId);
          value.accounts.push({ id: accountId, provider, clientId: registration.clientId, email: identity.email, name: identity.name, canWrite: permissions.write, scopes,
            accessToken: token.access_token, refreshToken: token.refresh_token ?? "", expiresAt: Date.now() + token.expires_in * 1000, connectedAt: new Date().toISOString() });
          if (workspaceId) value.grants[workspaceId] = [...new Set([...(value.grants[workspaceId] ?? []), accountId])];
        }));
        flow.status = "connected";
        response.end("Email connected. You can close this tab and return to LegalWork.");
      } catch {
        if (flow.status === "pending") { flow.status = "failed"; flow.error = "Sign-in did not complete. Check the permissions or administrator approval and try again."; }
        response.writeHead(400).end(flow.error ?? "Sign-in was cancelled.");
      } finally { clearTimeout(timer); controller.abort(); server.close(); }
    });
    const timer = setTimeout(() => { const flow = this.flows.get(id); if (flow?.status === "pending") { flow.status = "expired"; flow.error = "Sign-in expired. Please try again."; flow.close(); } }, 5 * 60_000);
    timer.unref();
    const close = () => { clearTimeout(timer); controller.abort(); server.close(); server.closeAllConnections(); };
    try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
    catch { close(); throw new ApiError(409, "mail_signin_busy", "Could not open the email sign-in callback. Please try again."); }
    const address = server.address();
    if (!address || typeof address === "string") { close(); throw new Error("mail_callback_unavailable"); }
    redirectUri = `http://${provider === "gmail" ? "127.0.0.1" : "localhost"}:${address.port}${path}`;
    this.flows.set(id, { provider, registration, server, controller, status: "pending", error: null, used: false, expiresAt, close });
    const auth = new URL(provider === "gmail" ? "https://accounts.google.com/o/oauth2/v2/auth" : "https://login.microsoftonline.com/common/oauth2/v2.0/authorize");
    auth.search = new URLSearchParams({ response_type: "code", client_id: registration.clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: "S256", scope: mailScopes(provider, canWrite).join(" "),
      ...(provider === "gmail" ? { access_type: "offline", prompt: "consent" } : { prompt: "select_account" }) }).toString();
    return { flowId: id, authUrl: auth.toString(), expiresAt };
  }
}
