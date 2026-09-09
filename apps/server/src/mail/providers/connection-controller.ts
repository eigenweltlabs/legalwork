import { createHash, randomUUID } from "node:crypto";
import type { MailDatabase } from "../storage/database-interface.js";
import { MailRepository } from "../storage/repository.js";
import { MailCredentialError, MailCredentialRepository, type MailCredentialBinding, type MailCredentialVersion } from "../storage/credentials.js";
import { GMAIL_MAIL_SCOPES } from "../provider-config.js";
import { MailOAuthError, startMailOAuth, type MailOAuthFlow, type MailOAuthSettings } from "./oauth.js";
import { discoverMailIdentity } from "./identity.js";

export type MailConnectionErrorCode = "configuration_invalid" | "provider_busy" | "capacity" | "closed" | "not_found"
  | "account_not_found" | "reconnect_required" | "binding_mismatch" | "stale_credentials" | "permissions_missing"
  | "cancelled" | "expired" | "authorization_failed" | "identity_failed" | "persistence_failed";
export class MailConnectionError extends Error {
  constructor(readonly code: MailConnectionErrorCode) { super(`mail_connection_${code}`); }
}
export type MailConnectionStatus = { connectionId: string; expiresAt: number } & (
  | { state: "pending" | "verifying" | "cancelled" | "expired" }
  | { state: "connected"; accountId: string; renewable: boolean }
  | { state: "failed"; error: MailConnectionErrorCode });
type Entry = {
  status: MailConnectionStatus; reconnectAccountId?: string; provider: "gmail" | "graph"; abort: AbortController;
  timer: ReturnType<typeof setTimeout>; settledAt: number | null; flow?: MailOAuthFlow; cleaning?: Promise<void>;
};
export type MailConnectionControllerOptions = {
  database: MailDatabase; ownerId: string;
  /** Trusted internal test seams, never supplied by RPC or HTTP. */
  oauth?: typeof startMailOAuth; identity?: typeof discoverMailIdentity;
  lifetimeMs?: number; retentionMs?: number; maxRetained?: number;
};
function bound(value: number | undefined, fallback: number, maximum: number): number {
  const number = value ?? fallback;
  if (!Number.isInteger(number) || number < 10 || number > maximum) throw new MailConnectionError("configuration_invalid");
  return number;
}
function active(entry: Entry): boolean { return entry.status.state === "pending" || entry.status.state === "verifying"; }
async function cleanup(flow: MailOAuthFlow): Promise<void> {
  // Production cancellation closes within 250 ms; a faulty seam cannot block controller shutdown.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([Promise.resolve().then(() => flow.cancel()).catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 300); })]); }
  finally { clearTimeout(timer); }
}
function fullGrants(settings: MailOAuthSettings, scopes: readonly string[] | null): boolean {
  if (!scopes || scopes.length > 32) return false;
  const normalized = new Set(scopes.map(scope => settings.provider === "gmail" && scope === "https://www.googleapis.com/auth/userinfo.email" ? "email"
    : settings.provider === "graph" && scope.startsWith("https://graph.microsoft.com/") ? scope.slice("https://graph.microsoft.com/".length) : scope));
  return (settings.provider === "gmail" ? GMAIL_MAIL_SCOPES : ["User.Read", "Mail.ReadWrite", "Mail.Send"]).every(scope => normalized.has(scope));
}

/** Worker-local controller; database/key lifetime is owned by the caller. Close before closing its database. */
export class MailConnectionController {
  private readonly entries = new Map<string, Entry>();
  private readonly database: MailDatabase;
  private readonly ownerId: string;
  private readonly credentials: MailCredentialRepository;
  private readonly accounts: MailRepository;
  private readonly oauth: typeof startMailOAuth;
  private readonly identity: typeof discoverMailIdentity;
  private readonly lifetime: number;
  private readonly retention: number;
  private readonly capacity: number;
  private closed = false;
  constructor(options: MailConnectionControllerOptions) {
    this.lifetime = bound(options.lifetimeMs, 300000, 600000);
    this.retention = bound(options.retentionMs, 600000, 86400000);
    this.capacity = options.maxRetained ?? 32;
    if (!Number.isInteger(this.capacity) || this.capacity < 1 || this.capacity > 128
      || typeof options.ownerId !== "string" || !options.ownerId.length || options.ownerId.length > 4096) throw new MailConnectionError("configuration_invalid");
    this.database = options.database; this.ownerId = options.ownerId;
    this.oauth = options.oauth ?? startMailOAuth; this.identity = options.identity ?? discoverMailIdentity;
    try { this.credentials = new MailCredentialRepository(this.database, this.ownerId); this.accounts = new MailRepository(this.database, this.ownerId); }
    catch { throw new MailConnectionError("persistence_failed"); }
  }
  private prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) if (entry.settledAt !== null && now - entry.settledAt >= this.retention) this.entries.delete(id);
  }
  private finish(entry: Entry, status: MailConnectionStatus): void {
    if (!active(entry)) return;
    entry.status = status; entry.settledAt = Date.now(); clearTimeout(entry.timer); entry.abort.abort();
    const flow = entry.flow; entry.flow = undefined; if (flow) entry.cleaning ??= cleanup(flow);
  }
  private base(entry: Entry) { return { connectionId: entry.status.connectionId, expiresAt: entry.status.expiresAt }; }
  private usable(entry: Entry): boolean {
    if (active(entry) && Date.now() >= entry.status.expiresAt) this.finish(entry, { ...this.base(entry), state: "expired" });
    return !this.closed && active(entry) && !entry.abort.signal.aborted;
  }
  async begin(settingsInput: MailOAuthSettings, options: { reconnectAccountId?: string } = {}): Promise<{ connectionId: string; authorizationUrl: string; expiresAt: number }> {
    if (this.closed) throw new MailConnectionError("closed");
    this.prune();
    if (settingsInput.provider !== "gmail" && settingsInput.provider !== "graph") throw new MailConnectionError("configuration_invalid");
    for (const entry of this.entries.values()) if (entry.provider === settingsInput.provider && this.usable(entry)) throw new MailConnectionError("provider_busy");
    if (this.entries.size >= this.capacity) throw new MailConnectionError("capacity");
    const settings: MailOAuthSettings = { ...settingsInput, scopes: [...settingsInput.scopes] };
    const reconnectId = options.reconnectAccountId;
    let expected: MailCredentialVersion | null = null;
    if (reconnectId !== undefined) {
      try { expected = this.credentials.status(reconnectId).version; }
      catch { throw new MailConnectionError("account_not_found"); }
      // Never attach a newly discovered identity to an existing archive without an immutable binding.
      if (expected === null) throw new MailConnectionError("account_not_found");
    }
    const connectionId = randomUUID(), expiresAt = Date.now() + this.lifetime;
    const abort = new AbortController();
    const entry: Entry = { provider: settings.provider, reconnectAccountId: reconnectId, status: { connectionId, expiresAt, state: "pending" }, abort,
      timer: setTimeout(() => this.finish(entry, { connectionId, expiresAt, state: "expired" }), this.lifetime), settledAt: null };
    this.entries.set(connectionId, entry);
    let aborted: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => { aborted = () => reject(new MailConnectionError(this.closed ? "closed" : "authorization_failed")); abort.signal.addEventListener("abort", aborted, { once: true }); });
    const starting = Promise.resolve().then(() => this.oauth(settings, { lifetimeMs: this.lifetime, signal: abort.signal }));
    void starting.then(flow => { if (!this.usable(entry)) void cleanup(flow); }, () => {});
    try {
      const flow = await Promise.race([starting, cancelled]);
      if (!this.usable(entry)) { void cleanup(flow); throw new MailConnectionError(this.closed ? "closed" : "authorization_failed"); }
      entry.flow = flow;
      void this.complete(entry, flow, settings, reconnectId, expected);
      return { connectionId, authorizationUrl: flow.authorizationUrl, expiresAt };
    } catch (error) {
      if (active(entry)) this.finish(entry, { connectionId, expiresAt, state: "failed", error: error instanceof MailOAuthError && error.code === "configuration_invalid" ? "configuration_invalid" : "authorization_failed" });
      throw new MailConnectionError(this.closed ? "closed" : entry.status.state === "failed" ? entry.status.error : entry.status.state === "expired" ? "expired" : "cancelled");
    } finally { if (aborted) abort.signal.removeEventListener("abort", aborted); }
  }
  private async complete(entry: Entry, flow: MailOAuthFlow, settings: MailOAuthSettings, reconnectId: string | undefined, expected: MailCredentialVersion | null): Promise<void> {
    let stage: "authorization_failed" | "identity_failed" | "persistence_failed" = "authorization_failed";
    try {
      const tokens = await flow.result;
      if (!this.usable(entry)) return;
      if (!fullGrants(settings, tokens.grantedScopes)) throw new MailConnectionError("permissions_missing");
      stage = "identity_failed";
      entry.status = { ...this.base(entry), state: "verifying" };
      const identity = await this.identity({ settings, accessToken: tokens.accessToken, grantedScopes: tokens.grantedScopes, signal: entry.abort.signal });
      if (!this.usable(entry)) return;
      if (identity.provider !== settings.provider) throw new MailConnectionError("binding_mismatch");
      const binding: MailCredentialBinding = identity.provider === "gmail"
        ? { provider: "gmail", clientId: settings.clientId, authority: identity.authority, providerSubject: identity.providerSubject }
        : { provider: "graph", clientId: settings.clientId, authority: identity.authority, providerSubject: identity.providerSubject };
      const accountId = reconnectId ?? `mail_${createHash("sha256").update(JSON.stringify([this.ownerId, identity.provider, identity.authority, identity.providerSubject])).digest("hex")}`;
      stage = "persistence_failed";
      this.database.transaction(() => {
        if (!this.usable(entry)) throw new MailConnectionError("closed");
        if (reconnectId === undefined) {
          if (this.database.get("SELECT id FROM mail_accounts WHERE id=?", [accountId])) throw new MailConnectionError("reconnect_required");
          this.accounts.createAccount({ id: accountId, provider: identity.provider, displayName: identity.displayName ?? identity.email });
        }
        this.credentials.connect(accountId, binding, expected, { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt,
          grantedScopes: tokens.grantedScopes, refreshToken: tokens.refreshToken === null ? { action: "clear" } : { action: "replace", value: tokens.refreshToken } });
        if (!this.usable(entry)) throw new MailConnectionError("expired");
      });
      this.finish(entry, { ...this.base(entry), state: "connected", accountId, renewable: tokens.refreshToken !== null });
    } catch (error) {
      if (!this.usable(entry)) return;
      if (error instanceof MailOAuthError && (error.code === "cancelled" || error.code === "expired")) {
        this.finish(entry, { ...this.base(entry), state: error.code }); return;
      }
      const code = error instanceof MailConnectionError ? error.code : error instanceof MailCredentialError && error.code === "binding_mismatch" ? "binding_mismatch"
        : error instanceof MailCredentialError && error.code === "stale_version" ? "stale_credentials" : stage;
      this.finish(entry, { ...this.base(entry), state: "failed", error: code });
    }
  }
  poll(connectionId: string): MailConnectionStatus {
    this.prune(); const entry = this.entries.get(connectionId);
    if (!entry) throw new MailConnectionError("not_found");
    this.usable(entry); return { ...entry.status };
  }
  async cancel(connectionId: string): Promise<void> {
    const entry = this.entries.get(connectionId); if (!entry) throw new MailConnectionError("not_found");
    this.finish(entry, { ...this.base(entry), state: "cancelled" }); await entry.cleaning;
  }
  /** Persist the fence before any async cleanup; retain archive metadata/content and never revoke remotely. */
  async disconnect(accountId: string): Promise<void> {
    if (this.closed) throw new MailConnectionError("closed");
    try {
      this.database.transaction(() => {
        const status = this.credentials.status(accountId);
        if (status.state === "unconfigured") throw new MailConnectionError("account_not_found");
        // Every explicit disconnect fences reconnects started by other controllers/processes.
        this.credentials.disconnect(accountId, status.version);
      });
    } catch (error) {
      throw new MailConnectionError(error instanceof MailConnectionError && error.code === "account_not_found"
        || error instanceof MailCredentialError && error.code === "account_not_found" ? "account_not_found"
        : error instanceof MailCredentialError && error.code === "stale_version" ? "stale_credentials" : "persistence_failed");
    }
    const matching = [...this.entries.values()].filter(entry => entry.reconnectAccountId === accountId);
    for (const entry of matching) this.finish(entry, { ...this.base(entry), state: "cancelled" });
    await Promise.all(matching.map(entry => entry.cleaning));
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const entry of this.entries.values()) this.finish(entry, { ...this.base(entry), state: "cancelled" });
    await Promise.all([...this.entries.values()].map(entry => entry.cleaning));
  }
}
