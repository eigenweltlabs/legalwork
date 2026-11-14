import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import type { StorageInput, StorageOAuthStatus } from "@legalwork/types/file-storage";
import { ApiError } from "../../errors.js";
import { oauthProvider, type OAuthApplication, type AccessToken } from "./providers.js";
import { OAuthVault, vaultLock, type Credential } from "./vault.js";

const tokenResult = z.object({ access_token: z.string().min(1), refresh_token: z.string().optional(), expires_in: z.number().positive().default(3600) });
const signinRequired = () => new ApiError(401, "storage_signin_required", "Sign in to this connection in File storage settings.");
export const tokenBindings = new WeakMap<StorageInput, AccessToken>();
export class StorageOAuth {
  readonly vault: OAuthVault;
  private flows = new Map<string, { close: () => void; error?: string }>();
  constructor(path: string, private platform?: () => Promise<string>) { this.vault = new OAuthVault(path); }
  private async provider(id: string) {
    const provider = oauthProvider(id);
    if (id !== "box" || process.env.LEGALWORK_STORAGE_BOX_OAUTH_URL || !this.platform) return provider;
    const platform = await this.platform();
    return { ...provider, authorizeUrl: `${platform}/api/storage-oauth/box/authorize`, tokenUrl: `${platform}/api/storage-oauth/box/token` };
  }
  key(workspaceId: string, id: string, input: StorageInput) {
    // Root/access changes invalidate a grant instead of silently widening its use.
    return JSON.stringify([workspaceId, id, input.config, input.readOnly]);
  }
  bind(workspaceId: string, id: string, input: StorageInput) {
    if (input.config.kind !== "oauth" || input.config.accountId) return;
    const key = this.key(workspaceId, id, input);
    const providerId = input.config.provider;
    tokenBindings.set(input, async () => this.access(key, await this.provider(providerId)));
  }
  private async exchange(provider: OAuthApplication, fields: Record<string, string>, previous?: Credential) {
    let response: Response;
    try {
      response = await fetch(provider.tokenUrl, {
        method: "POST", signal: AbortSignal.timeout(30_000), redirect: "error",
        body: new URLSearchParams({ client_id: provider.clientId, ...(provider.clientSecret ? { client_secret: provider.clientSecret } : {}), ...fields }),
      });
    } catch { throw new ApiError(502, "storage_signin_unreachable", "Could not reach the sign-in provider. Try again shortly."); }
    if (response.status >= 500 || response.status === 429) throw new ApiError(502, "storage_signin_unreachable", "The sign-in provider is temporarily unavailable. Try again shortly.");
    if (!response.ok) throw signinRequired();
    const result = tokenResult.safeParse(await response.json().catch(() => null));
    if (!result.success) throw signinRequired();
    const token = result.data;
    const refreshToken = token.refresh_token ?? previous?.refreshToken;
    if (!refreshToken) throw signinRequired();
    return { accessToken: token.access_token, refreshToken, expiresAt: Date.now() + token.expires_in * 1000 };
  }
  async access(key: string, provider: OAuthApplication, forceRefresh = false) {
    return vaultLock(`${this.vault.path}:${key}`, async () => {
      let token = await this.vault.get(key);
      if (!token) throw signinRequired();
      if (forceRefresh || token.expiresAt < Date.now() + 60_000) {
        token = await this.exchange(provider, { grant_type: "refresh_token", refresh_token: token.refreshToken }, token);
        await this.vault.set(key, token);
      }
      return token.accessToken;
    });
  }
  async status(key: string): Promise<StorageOAuthStatus> {
    const flow = this.flows.get(key);
    return { connected: Boolean(await this.vault.get(key)), pending: Boolean(flow && !flow.error), ...(flow?.error ? { error: flow.error } : {}) };
  }
  async disconnect(key: string) {
    this.cancel(key);
    // Sharing a key with refresh prevents a late refresh from resurrecting a disconnected grant.
    await vaultLock(`${this.vault.path}:${key}`, () => this.vault.set(key));
  }
  cancel(key: string) { this.flows.get(key)?.close(); this.flows.delete(key); }
  async start(key: string, input: StorageInput, stillAllowed: () => Promise<boolean>) {
    if (input.config.kind !== "oauth") throw signinRequired();
    return this.startProvider(key, await this.provider(input.config.provider), input.readOnly, stillAllowed);
  }
  async startProvider(key: string, provider: OAuthApplication, readOnly: boolean, stillAllowed: () => Promise<boolean>) {
    this.cancel(key);
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let used = false;
    let redirectUri = "";
    const flow: { close: () => void; error?: string } = { close: () => { clearTimeout(timer); server.close(); server.closeAllConnections(); } };
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "text/plain; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
      if (request.method !== "GET" || url.pathname !== "/callback" || url.searchParams.get("state") !== state || used) {
        response.writeHead(400).end("This sign-in link is invalid. Return to LegalWork."); return;
      }
      used = true;
      try {
        const code = url.searchParams.get("code");
        if (!code || url.searchParams.has("error")) throw signinRequired();
        const token = await this.exchange(provider, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri });
        await vaultLock(`${this.vault.path}:${key}`, async () => {
          if (this.flows.get(key) !== flow || !await stillAllowed()) throw signinRequired();
          if (!await this.vault.set(key, token, () => this.flows.get(key) === flow)) throw signinRequired();
        });
        this.flows.delete(key);
        response.end("Connected. You can close this tab and return to LegalWork.");
      } catch {
        flow.error = "Sign-in did not complete. Return to LegalWork and try again.";
        response.writeHead(400).end(flow.error);
      } finally { clearTimeout(timer); server.close(); }
    });
    const timer = setTimeout(() => { flow.error = "Sign-in expired. Please try again."; flow.close(); }, 5 * 60_000);
    timer.unref();
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(provider.port ?? 0, "127.0.0.1", resolve); });
    } catch { flow.close(); throw new ApiError(409, "storage_signin_busy", "Another sign-in is using this connection. Finish it and try again."); }
    const address = server.address();
    if (!address || typeof address === "string") { flow.close(); throw signinRequired(); }
    redirectUri = `http://${provider.redirectHost ?? "localhost"}:${address.port}/callback`;
    this.flows.set(key, flow);
    const url = new URL(provider.authorizeUrl);
    url.search = new URLSearchParams({ ...provider.authorizeParams, response_type: "code", client_id: provider.clientId, redirect_uri: redirectUri, state, code_challenge: challenge, code_challenge_method: "S256", scope: provider.scopes(readOnly).join(" ") }).toString();
    return { authUrl: url.toString(), expiresAt: Date.now() + 5 * 60_000 };
  }
}
