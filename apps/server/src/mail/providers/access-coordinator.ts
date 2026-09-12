import { performance } from "node:perf_hooks";
import { z } from "zod";
import { MailCredentialRepository, MailCredentialError, type MailCredentialBinding, type MailCredentialVersion } from "../storage/credentials.js";
import type { MailDatabase } from "../storage/database-interface.js";
import { checkMailProviderReadiness } from "../provider-config.js";
import type { MailOAuthSettings } from "./oauth.js";
import { refreshMailOAuth, MailRefreshError, type MailRefreshResult } from "./refresh.js";

export type MailAccessErrorCode = "closed" | "not_found" | "locked" | "binding_mismatch" | "stale_credentials" | "configuration_invalid"
  | "reconsent_required" | "transient" | "rate_limited" | "timeout" | "provider_rejected" | "storage_unavailable" | "capacity";
export class MailAccessError extends Error {
  readonly retryable: boolean;
  readonly reconsentRequired: boolean;
  constructor(readonly code: MailAccessErrorCode, readonly retryAfterMs: number | null = null) {
    super(`mail_access_${code}`);
    this.retryable = ["transient", "rate_limited", "timeout", "stale_credentials", "capacity"].includes(code);
    this.reconsentRequired = code === "reconsent_required";
  }
}
export type MailAccountAccess = { accessToken: string; expiresAt: number; grantedScopes: string[] | null; version: MailCredentialVersion };
export type MailAccessCoordinatorOptions = {
  database: MailDatabase; ownerId: string;
  loadProviderSettings: (binding: Readonly<MailCredentialBinding>) => Promise<MailOAuthSettings>;
  refresh?: typeof refreshMailOAuth;
  now?: () => number;
  expiryMarginMs?: number;
  timeoutMs?: number;
};
const guid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).toLowerCase();
const scopes = z.array(z.string().regex(/^[\x21-\x7e]{1,512}$/)).max(32);
const common = { applicationType: z.literal("desktop"), pkceMethod: z.literal("S256"), scopes };
const settingsSchema = z.discriminatedUnion("provider", [
  z.object({ ...common, provider: z.literal("gmail"), clientId: z.string().max(4096).regex(/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/), clientSecret: z.string().regex(/^[\x21-\x7e]{1,16384}$/) }).strict(),
  z.object({ ...common, provider: z.literal("graph"), clientId: guid, tenantId: z.union([guid, z.literal("consumers")]), registeredRedirectUri: z.literal("http://localhost/mail/callback") }).strict(),
]);
function settings(value: unknown, binding: MailCredentialBinding): MailOAuthSettings {
  const result = settingsSchema.safeParse(value);
  if (!result.success) throw new MailAccessError("configuration_invalid");
  const parsed = result.data;
  const authority = parsed.provider === "gmail" ? "https://accounts.google.com" : `https://login.microsoftonline.com/${parsed.tenantId}/v2.0`;
  if (parsed.provider !== binding.provider || parsed.clientId !== binding.clientId || authority !== binding.authority) throw new MailAccessError("binding_mismatch");
  const config = parsed.provider === "gmail" ? { ...parsed, redirectUri: "http://127.0.0.1:43123/", clientSecretConfigured: true }
    : { ...parsed, redirectUri: "http://localhost:43123/mail/callback" };
  if (!checkMailProviderReadiness(config).configurationReady) throw new MailAccessError("configuration_invalid");
  return parsed;
}
function safe(error: unknown): MailAccessError {
  if (error instanceof MailAccessError && ["closed", "not_found", "locked", "binding_mismatch", "stale_credentials", "configuration_invalid",
    "reconsent_required", "transient", "rate_limited", "timeout", "provider_rejected", "storage_unavailable", "capacity"].includes(error.code)) return new MailAccessError(error.code);
  if (error instanceof MailCredentialError) {
    switch (error.code) {
      case "account_not_found": return new MailAccessError("not_found");
      case "disconnected": return new MailAccessError("locked");
      case "binding_mismatch": return new MailAccessError("binding_mismatch");
      case "stale_version": return new MailAccessError("stale_credentials");
      case "refresh_missing": return new MailAccessError("reconsent_required");
      default: return new MailAccessError("storage_unavailable");
    }
  }
  if (error instanceof MailRefreshError) {
    const code = error.code === "configuration_invalid" || error.code === "reconsent_required" || error.code === "transient" || error.code === "rate_limited" || error.code === "timeout" ? error.code : "provider_rejected";
    const delay = error.retryAfterMs;
    return new MailAccessError(code, typeof delay === "number" && Number.isSafeInteger(delay) && delay >= 0 ? delay : null);
  }
  return new MailAccessError("storage_unavailable");
}
/** Internal engine-only access. No tokens are exposed through the worker protocol or public service. */
export class MailAccessCoordinator {
  private readonly credentials: MailCredentialRepository;
  private readonly now: () => number;
  private readonly margin: number;
  private readonly timeout: number;
  private closed = false;
  private readonly pending = new Map<string, { controller: AbortController; promise: Promise<MailAccountAccess> }>();
  constructor(private readonly options: MailAccessCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.margin = options.expiryMarginMs ?? 60000;
    this.timeout = options.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(this.margin) || this.margin < 0 || this.margin > 300000 || !Number.isSafeInteger(this.timeout) || this.timeout < 10 || this.timeout > 60000) throw new MailAccessError("configuration_invalid");
    try { this.credentials = new MailCredentialRepository(options.database, options.ownerId, this.now); }
    catch (error) { throw safe(error); }
  }
  private fence(accountId: string, expected: MailCredentialVersion): void {
    if (this.closed) throw new MailAccessError("closed");
    const current = this.credentials.status(accountId);
    if (current.state !== "connected" || current.archiveLocked) throw new MailAccessError("locked");
    if (current.version.generation !== expected.generation || current.version.revision !== expected.revision) throw new MailAccessError("stale_credentials");
  }
  acquire(accountId: string): Promise<MailAccountAccess> {
    if (this.closed) return Promise.reject(new MailAccessError("closed"));
    try {
      const parent = this.credentials.credentialAccountId(accountId);
      if (parent !== accountId) {
        const before = this.credentials.status(accountId);
        if(before.state !== 'connected')return Promise.reject(new MailAccessError('locked'));
        return this.acquire(parent).then(access => { this.fence(accountId,before.version);this.fence(parent,access.version);return {...access,version:before.version}; });
      }
    } catch(error) { return Promise.reject(safe(error)); }
    const existing = this.pending.get(accountId);
    if (existing) return existing.promise;
    if (this.pending.size >= 64) return Promise.reject(new MailAccessError("capacity"));
    const controller = new AbortController();
    const deadline = performance.now() + this.timeout;
    let timer: ReturnType<typeof setTimeout>;
    const stopped = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(new MailAccessError(this.closed ? "closed" : "timeout")), { once: true });
      timer = setTimeout(() => controller.abort(), this.timeout);
    });
    const promise = Promise.race([this.perform(accountId, controller.signal, deadline), stopped]).catch(error => { throw safe(error); })
      .finally(() => { clearTimeout(timer); this.pending.delete(accountId); })
      .then(access => {
        try {
          if (controller.signal.aborted) throw new MailAccessError(this.closed ? "closed" : "timeout");
          this.fence(accountId, access.version);
          if (access.expiresAt <= this.now()) throw new MailAccessError("transient");
          if (performance.now() >= deadline) throw new MailAccessError("timeout");
          return access;
        } catch (error) { throw safe(error); }
      });
    this.pending.set(accountId, { controller, promise });
    return promise;
  }
  private async perform(accountId: string, signal: AbortSignal, deadline: number): Promise<MailAccountAccess> {
    const current = this.credentials.status(accountId);
    if (current.state !== "connected" || current.archiveLocked) throw new MailAccessError("locked");
    const expected = current.version;
    const binding = this.credentials.getBinding(accountId);
    const check = () => { if (signal.aborted) throw new MailAccessError(this.closed ? "closed" : "timeout"); this.fence(accountId, expected); if (performance.now() >= deadline) throw new MailAccessError("timeout"); };
    let supplied: MailOAuthSettings;
    try { supplied = await this.options.loadProviderSettings(Object.freeze({ ...binding })); }
    catch { check(); throw new MailAccessError("configuration_invalid"); }
    check();
    const selected = settings(supplied, binding);
    try {
      const access = this.credentials.readAccess(accountId, binding);
      if (access.expiresAt - this.now() > this.margin) { check(); return access; }
    } catch (error) { if (!(error instanceof MailCredentialError) || error.code !== "access_expired") throw error; }
    const refresh = this.credentials.readForRefresh(accountId, binding);
    check();
    let result: MailRefreshResult;
    try { result = await (this.options.refresh ?? refreshMailOAuth)({ settings: selected, refreshToken: refresh.refreshToken, signal, timeoutMs: this.timeout }); }
    catch (error) { check(); throw error; }
    check();
    // RFC 6749 sections 6 and 5.1: omitted refresh request scope retains the grant,
    // and an omitted response scope denotes no change. Preserve only recorded Gmail proof.
    // https://www.rfc-editor.org/rfc/rfc6749.html#section-6
    const grantedScopes = binding.provider === "gmail" && result.grantedScopes === null ? refresh.grantedScopes : result.grantedScopes;
    const version = this.credentials.rotate(accountId, binding, expected, { accessToken: result.accessToken, expiresAt: result.expiresAt,
      refreshToken: result.refreshToken, grantedScopes });
    const access = this.credentials.readAccess(accountId, binding);
    if (access.version.generation !== version.generation || access.version.revision !== version.revision) throw new MailAccessError("stale_credentials");
    this.fence(accountId, version);
    return access;
  }
  close(): void {
    this.closed = true;
    for (const entry of this.pending.values()) entry.controller.abort();
  }
}
