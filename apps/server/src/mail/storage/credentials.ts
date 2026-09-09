import {ImapCustody} from './imap-custody.js';
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MailDatabase } from "./database-interface.js";
import { assertMailSchema } from "./consistency.js";

const id = z.string().min(1).max(4096);
const printable = z.string().regex(/^[\x21-\x7e]{1,16384}$/);
const subject = z.string().regex(/^[\x21-\x7e]{1,4096}$/);
const integer = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const guid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const bindingInput = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("gmail"), clientId: z.string().max(4096).regex(/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/),
    authority: z.literal("https://accounts.google.com"), providerSubject: subject }).strict(),
  z.object({ provider: z.literal("graph"), clientId: z.string().regex(new RegExp(`^${guid}$`, "i")).toLowerCase(),
    authority: z.string().regex(new RegExp(`^https://login\\.microsoftonline\\.com/${guid}/v2\\.0$`, "i")).toLowerCase(), providerSubject: z.string().regex(new RegExp(`^${guid}$`, "i")).toLowerCase() }).strict(),
]);
const versionInput = z.object({ generation: z.string().uuid(), revision: integer }).strict();
const grantsInput = z.array(z.string().regex(/^[\x21-\x7e]{1,512}$/)).max(32).nullable();
const refreshInput = z.discriminatedUnion("action", [z.object({ action: z.literal("preserve") }).strict(),
  z.object({ action: z.literal("replace"), value: printable }).strict(), z.object({ action: z.literal("clear") }).strict()]);
const tokensInput = z.object({ accessToken: printable, expiresAt: integer, grantedScopes: grantsInput, refreshToken: refreshInput }).strict();
const storedInput = z.object({ account_id: id, provider: z.enum(["gmail", "graph"]), client_id: z.string(), authority: z.string(), provider_subject: subject,
  generation: z.string().uuid(), revision: integer, state: z.enum(["connected", "disconnected"]), archive_locked: z.union([z.literal(0), z.literal(1)]),
  access_token: printable.nullable(), refresh_token: printable.nullable(), expires_at: integer.nullable(), granted_scopes_json: z.string().nullable() });
type Stored = z.infer<typeof storedInput>;
export type MailCredentialBinding = z.infer<typeof bindingInput>;
export type MailCredentialVersion = z.infer<typeof versionInput>;
export type MailCredentialTokens = z.infer<typeof tokensInput>;
export type MailCredentialStatus = { state: "unconfigured"; archiveLocked: true; version: null }
  | { state: "connected" | "disconnected"; archiveLocked: boolean; version: MailCredentialVersion };
export type MailCredentialErrorCode = "invalid_input" | "account_not_found" | "binding_mismatch" | "stale_version" | "disconnected"
  | "refresh_missing" | "access_expired" | "revision_exhausted" | "storage_unavailable";
export class MailCredentialError extends Error {
  constructor(readonly code: MailCredentialErrorCode) { super(`mail_credentials_${code}`); }
}
const errorCodes = new Set<MailCredentialErrorCode>(["invalid_input", "account_not_found", "binding_mismatch", "stale_version", "disconnected", "refresh_missing", "access_expired", "revision_exhausted", "storage_unavailable"]);
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MailCredentialError("invalid_input");
  return parsed.data;
}
function safe<T>(body: () => T): T {
  try { return body(); }
  catch (error) {
    // Never propagate SQL/Zod/provider messages, values, causes or errors from injected storage.
    throw new MailCredentialError(error instanceof MailCredentialError && errorCodes.has(error.code) ? error.code : "storage_unavailable");
  }
}
function version(row: Pick<Stored, "generation" | "revision">): MailCredentialVersion { return { generation: row.generation, revision: row.revision }; }
function binding(row: Stored): MailCredentialBinding {
  return input(bindingInput, { provider: row.provider, clientId: row.client_id, authority: row.authority, providerSubject: row.provider_subject });
}
function sameBinding(left: MailCredentialBinding, right: MailCredentialBinding): boolean {
  return left.provider === right.provider && left.clientId === right.clientId && left.authority === right.authority && left.providerSubject === right.providerSubject;
}
function nextRevision(row: Stored | undefined): number {
  if (row?.revision === Number.MAX_SAFE_INTEGER) throw new MailCredentialError("revision_exhausted");
  return (row?.revision ?? 0) + 1;
}
function scopes(row: Stored): string[] | null { return row.granted_scopes_json === null ? null : input(grantsInput, JSON.parse(row.granted_scopes_json)); }

/** Internal serial-writer repository on an already keyed encrypted database. No secret enumeration or public API.
 * Callers must use openEncryptedMailDatabase; configuration probes alone are not proof of an at-rest key. */
export class MailCredentialRepository {
  private readonly ownerId: string;
  constructor(private readonly database: MailDatabase, ownerId: string, private readonly now: () => number = Date.now) {
    this.ownerId = safe(() => input(id, ownerId));
    safe(() => {
      assertMailSchema(database);
      const engine = database.get("SELECT sqlite3mc_version() AS engine");
      if (engine?.engine !== "SQLite3 Multiple Ciphers 2.4.0" || Object.values(database.get("PRAGMA cipher") ?? {})[0] !== "sqlcipher"
        || database.get("PRAGMA temp_store")?.temp_store !== 2) throw new MailCredentialError("storage_unavailable");
    });
  }
  private account(accountId: string): string {
    input(id, accountId);
    const row = this.database.get("SELECT provider FROM mail_accounts WHERE id=? AND owner_id=?", [accountId, this.ownerId]);
    if (!row) throw new MailCredentialError("account_not_found");
    return input(z.enum(["gmail", "graph", "imap"]), row.provider);
  }
  private load(accountId: string): Stored | undefined {
    const row = this.database.get("SELECT * FROM mail_account_credentials WHERE account_id=?", [accountId]);
    return row ? input(storedInput, row) : undefined;
  }
  private matches(row: Stored | undefined, expected: MailCredentialVersion | null): void {
    if (expected === null ? row !== undefined : !row || row.generation !== expected.generation || row.revision !== expected.revision) throw new MailCredentialError("stale_version");
  }
  private connected(accountId: string, requested: MailCredentialBinding): Stored {
    if (this.account(accountId) !== requested.provider) throw new MailCredentialError("binding_mismatch");
    const row = this.load(accountId);
    if (!row || row.state !== "connected" || row.archive_locked !== 0) throw new MailCredentialError("disconnected");
    if (!sameBinding(binding(row), requested)) throw new MailCredentialError("binding_mismatch");
    return row;
  }
  private validTokens(tokens: MailCredentialTokens): void {
    const now = input(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), this.now());
    if (tokens.expiresAt <= now) throw new MailCredentialError("access_expired");
  }
  /** Nonsecret single-account lifecycle status, not an archive content authorization gate. */
  status(accountId: string): MailCredentialStatus {
    return safe(() => {
      const provider=this.account(accountId);
      const found = this.database.get(provider==='imap'?"SELECT state,archive_locked,generation,revision FROM mail_imap_credentials WHERE account_id=?":"SELECT state,archive_locked,generation,revision FROM mail_account_credentials WHERE account_id=?", [accountId]);
      const row = found ? input(storedInput.pick({ state: true, archive_locked: true, generation: true, revision: true }), found) : undefined;
      return row ? { state: row.state, archiveLocked: row.archive_locked === 1, version: version(row) }
        : { state: "unconfigured", archiveLocked: true, version: null };
    });
  }
  /** Internal owner-checked immutable identity lookup. Never includes usable secrets. */
  getBinding(accountId: string): MailCredentialBinding {
    return safe(() => {
      this.account(accountId);
      const row = this.database.get("SELECT provider,client_id,authority,provider_subject FROM mail_account_credentials WHERE account_id=?", [accountId]);
      if (!row) throw new MailCredentialError("disconnected");
      return input(bindingInput, { provider: row.provider, clientId: row.client_id, authority: row.authority, providerSubject: row.provider_subject });
    });
  }
  /** First connect uses expected=null; reconnect must CAS the saved status and never inherits refresh credentials. */
  connect(accountId: string, requested: MailCredentialBinding, expected: MailCredentialVersion | null, supplied: MailCredentialTokens): MailCredentialVersion {
    return safe(() => {
      const selected = input(bindingInput, requested), wanted = input(versionInput.nullable(), expected), tokens = input(tokensInput, supplied);
      if (tokens.refreshToken.action === "preserve") throw new MailCredentialError("invalid_input");
      return this.database.transaction(() => {
        if (this.account(accountId) !== selected.provider) throw new MailCredentialError("binding_mismatch");
        const row = this.load(accountId); this.matches(row, wanted);
        if (row && !sameBinding(binding(row), selected)) throw new MailCredentialError("binding_mismatch");
        this.validTokens(tokens);
        const next = { generation: randomUUID(), revision: nextRevision(row) };
        const refresh = tokens.refreshToken.action === "replace" ? tokens.refreshToken.value : null;
        this.database.run(`INSERT INTO mail_account_credentials(account_id,provider,client_id,authority,provider_subject,generation,revision,state,archive_locked,access_token,refresh_token,expires_at,granted_scopes_json)
          VALUES(?,?,?,?,?,?,?,'connected',0,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET generation=excluded.generation,revision=excluded.revision,
          state='connected',archive_locked=0,access_token=excluded.access_token,refresh_token=excluded.refresh_token,expires_at=excluded.expires_at,granted_scopes_json=excluded.granted_scopes_json`,
        [accountId, selected.provider, selected.clientId, selected.authority, selected.providerSubject, next.generation, next.revision, tokens.accessToken, refresh, tokens.expiresAt,
          tokens.grantedScopes === null ? null : JSON.stringify([...new Set(tokens.grantedScopes)])]);
        return next;
      });
    });
  }
  /** Explicit preserve/replace/clear semantics; a late refresh cannot overwrite newer credentials. */
  rotate(accountId: string, requested: MailCredentialBinding, expected: MailCredentialVersion, supplied: MailCredentialTokens): MailCredentialVersion {
    return safe(() => {
      const selected = input(bindingInput, requested), wanted = input(versionInput, expected), tokens = input(tokensInput, supplied);
      return this.database.transaction(() => {
        const row = this.connected(accountId, selected); this.matches(row, wanted); this.validTokens(tokens);
        const next = { generation: row.generation, revision: nextRevision(row) };
        const refresh = tokens.refreshToken.action === "preserve" ? row.refresh_token : tokens.refreshToken.action === "replace" ? tokens.refreshToken.value : null;
        this.database.run("UPDATE mail_account_credentials SET revision=?,access_token=?,refresh_token=?,expires_at=?,granted_scopes_json=? WHERE account_id=?",
          [next.revision, tokens.accessToken, refresh, tokens.expiresAt, tokens.grantedScopes === null ? null : JSON.stringify([...new Set(tokens.grantedScopes)]), accountId]);
        return next;
      });
    });
  }
  /** Clear local usable secrets, fence prior refreshes and retain the archive. Provider revocation is separate. */
  disconnect(accountId: string, expected: MailCredentialVersion): MailCredentialVersion {
    return safe(() => {
      const wanted = input(versionInput, expected);
      if(this.account(accountId)==='imap')return new ImapCustody(this.database,this.ownerId).disconnect(accountId,wanted);
      return this.database.transaction(() => {
        this.account(accountId); const row = this.load(accountId); this.matches(row, wanted);
        if (!row) throw new MailCredentialError("stale_version");
        const next = { generation: randomUUID(), revision: nextRevision(row) };
        this.database.run("UPDATE mail_account_credentials SET generation=?,revision=?,state='disconnected',archive_locked=1,access_token=NULL,refresh_token=NULL,expires_at=NULL,granted_scopes_json=NULL WHERE account_id=?",
          [next.generation, next.revision, accountId]);
        return next;
      });
    });
  }
  readAccess(accountId: string, requested: MailCredentialBinding) {
    return safe(() => {
      const row = this.connected(accountId, input(bindingInput, requested));
      const now = input(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), this.now());
      if (row.expires_at === null || row.expires_at <= now || row.access_token === null) throw new MailCredentialError("access_expired");
      return { accessToken: row.access_token, expiresAt: row.expires_at, grantedScopes: scopes(row), version: version(row) };
    });
  }
  readForRefresh(accountId: string, requested: MailCredentialBinding) {
    return safe(() => {
      const row = this.connected(accountId, input(bindingInput, requested));
      if (row.refresh_token === null) throw new MailCredentialError("refresh_missing");
      return { refreshToken: row.refresh_token, grantedScopes: scopes(row), version: version(row) };
    });
  }
}
