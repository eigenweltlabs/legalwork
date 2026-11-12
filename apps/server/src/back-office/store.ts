import type { SyncInbox } from "./sync-inbox.js";
import type { DirectoryPosition } from "./paged-sync.js";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { BackOfficeJournal } from "./journal.js";
import { backOfficeAuthorKey, backOfficePrincipalKey } from "./principal.js";
import {
  openBackOfficeAuditStorage,
  memoryBackOfficeAuditStorage,
  type BackOfficeAuditStorage,
} from "./audit-storage.js";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { OrgPolicySnapshotSchema, parseOrgPolicyEntries } from "../org-policy-schema.js";
import { openSqlite, runtimeDbPath, type SqliteHandle } from "../runtime-db.js";
import { ensureDir } from "../utils.js";
import type { ServerConfig } from "../types.js";
import {
  BackOfficeChangeSchema,
  BackOfficeModelSchema,
  BackOfficeRecordSchema,
  BackOfficeValueSchema,
  BackOfficeFilesSchema,
  BackOfficeFileSchema,
  BackOfficeViewSchema,
  assertModelChange,
  defaultBackOfficeModel,
  defaultBackOfficeValues,
  readableBackOfficeRecord,
  readableBackOfficeView,
  canonicalBackOfficeAudit,
  validateBackOfficeValues,
  validateBackOfficeView,
  visibleBackOfficeRecord,
  upgradeBackOfficeModel,
  upgradeBackOfficeRecord,
  upgradeBackOfficeView,
  type BackOfficeActor,
  type BackOfficeChange,
  type BackOfficeModel,
  type BackOfficeRecord,
  type BackOfficeSnapshot,
  type BackOfficeView,
  type BackOfficeFile,
} from "./schema.js";

const table = `
CREATE TABLE IF NOT EXISTS bo_first_sync (id TEXT PRIMARY KEY, principal TEXT NOT NULL, staged INTEGER, baseline TEXT, operation TEXT, confirmed INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS bo_first_sync_operation ON bo_first_sync(operation) WHERE operation IS NOT NULL;
CREATE INDEX IF NOT EXISTS bo_first_sync_pending ON bo_first_sync(principal,staged);
CREATE TABLE IF NOT EXISTS bo_first_sync_projects (principal TEXT NOT NULL, workspace TEXT NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(principal,workspace));
CREATE TABLE IF NOT EXISTS bo_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bo_models (scope TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bo_records (scope TEXT NOT NULL, id TEXT NOT NULL, object_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope,id));
CREATE INDEX IF NOT EXISTS bo_records_object ON bo_records(scope,object_id);
CREATE TABLE IF NOT EXISTS native_directory_links (
  account TEXT NOT NULL, kind TEXT NOT NULL, sourceId TEXT NOT NULL, projectKey TEXT NOT NULL, recordId TEXT NOT NULL,
  present INTEGER NOT NULL, stamp TEXT, generation TEXT, PRIMARY KEY(account,kind,sourceId,projectKey,recordId));
CREATE TABLE IF NOT EXISTS bo_views (scope TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope,id));
CREATE TABLE IF NOT EXISTS bo_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, error TEXT);
CREATE TABLE IF NOT EXISTS bo_replicas (scope TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bo_files (scope TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope,id));
CREATE TABLE IF NOT EXISTS bo_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, record_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bo_sync (scope TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 0, last_error TEXT);
INSERT OR IGNORE INTO bo_migrations VALUES(1,datetime('now'));`;
const inputRecord = z.object({
  id: z.string().uuid().optional(),
  create: z.boolean().optional(),
  expectedValues: z.record(z.string(), BackOfficeValueSchema).optional(),
  objectId: z.string(),
  revision: z.number().int().nonnegative(),
  values: z.record(z.string(), BackOfficeValueSchema),
  sourceId: z.string().max(16000).nullable().optional(),
  archived: z.boolean().optional(),
  access: z.enum(["org", "members"]).optional(),
  members: z.array(z.string()).max(500).optional(),
});
function conflict(
  message = "This edit conflicts with a newer change.",
): never {
  throw new ApiError(409, "back_office_conflict", message);
}
// Keep a fingerprint of only the modified fields on this device. The wire schema strips it.
function editBaseDigest(record: BackOfficeRecord, fields: string[]) {
  return createHash("sha256").update(canonicalBackOfficeAudit({
    archived: Boolean(record.archivedAt),
    values: Object.fromEntries(fields.map(id => [id, record.values[id] ?? null])),
  })).digest("hex");
}
// Selection edits have set semantics. Hash the previous membership so the
// outbox does not keep a second copy of names or IDs the user removed.
function selectionIds(value: unknown): string[] | undefined {
  if (value == null) return [];
  return Array.isArray(value) && value.every(id => typeof id === "string") ? value : undefined;
}
function memberHash(id: string) { return createHash("sha256").update(id).digest("hex"); }
function mergeSelection(before: string[], desired: string[], current: string[]) {
  const original = new Set(before), present = new Set(current);
  return [...new Set([
    ...desired.filter(id => present.has(id) || !original.has(memberHash(id))),
    ...current.filter(id => !original.has(memberHash(id))),
  ])];
}
function selectionField(model: BackOfficeModel, record: BackOfficeRecord, fields?: string[]) {
  if (fields?.length !== 1) return undefined;
  const definition = model.objects.find(object => object.id === record.objectId && !object.archived);
  const field = definition?.fields.find(item => item.id === fields[0]);
  if (field?.type === "multiselect" || (field?.type === "relation" && field.multiple)) return field.id;
}
const ReplicaBindingSchema = z.object({ id: z.literal("replica"), principalKey: z.string(), replicaId: z.string().uuid().optional(), position: z.object({ access: z.string(), cursor: z.number().int().nonnegative() }).optional(), permissions: z.object({ model: z.boolean(), edit: z.boolean(), finance: z.boolean() }).optional() });

export class BackOfficeStore {
  private transactionDepth = 0;
  private lastRestricted: { signature: string; version: number } | null = null;
  private restrictionState(scope: string, actor: BackOfficeActor) {
    const row = this.db.get("SELECT data_version,(SELECT max(rowid) FROM bo_journal_entries) AS head FROM pragma_data_version");
    return { signature: JSON.stringify([scope, actor.userId, actor.principalKey, actor.replicaId ?? this.replicaId(scope), actor.edit, actor.model, actor.finance, row?.head]), version: Number(row?.data_version) };
  }
  readonly journal: BackOfficeJournal;
  private readonly releaseAuditStorage: () => void;
  private closed = false;
  private fileCleanupNeeded = true;
  private fileCleanupVersion: number | null = null;
  private fileFailure: Error | null = null;
  constructor(
    readonly db: SqliteHandle,
    storage: BackOfficeAuditStorage = memoryBackOfficeAuditStorage(),
  ) {
    if (storage.persistent && !storage.serialized)
      throw new Error(
        "Persistent Back Office history requires the audit coordinator.",
      );
    this.releaseAuditStorage = storage.retain();
    try {
      storage.acquire();
      try {
        db.exec("PRAGMA busy_timeout=5000");
        db.exec("PRAGMA secure_delete=ON");
        db.exec(table);
        if (!db.all("PRAGMA table_info(native_directory_links)").some(column => column.name === "generation"))
          db.exec("ALTER TABLE native_directory_links ADD COLUMN generation TEXT");
        this.journal = new BackOfficeJournal(db, storage);
        this.journal.initialize();
        this.applyCachedPolicy();
        this.cleanFileKeys();
      } finally {
        storage.release();
      }
    } catch (error) {
      this.releaseAuditStorage();
      throw error;
    }
  }
  model(scope: string): BackOfficeModel {
    const row = this.db.get("SELECT data FROM bo_models WHERE scope=?", [
      scope,
    ]);
    if (typeof row?.data === "string") {
      const current = BackOfficeModelSchema.parse(JSON.parse(row.data));
      if (scope !== "local" || upgradeBackOfficeModel(current) === current)
        return current;
    }
    // Re-read after acquiring the transaction lock. Another process may have
    // created or edited the model since the optimistic read above.
    return this.transaction(
      () => {
        const latest = this.db.get("SELECT data FROM bo_models WHERE scope=?", [
          scope,
        ]);
        if (typeof latest?.data !== "string") {
          const model = defaultBackOfficeModel();
          this.db.run("INSERT INTO bo_models VALUES(?,?)", [
            scope,
            JSON.stringify(model),
          ]);
          return model;
        }
        const current = BackOfficeModelSchema.parse(JSON.parse(latest.data));
        const upgraded =
          scope === "local" ? upgradeBackOfficeModel(current) : current;
        if (upgraded !== current) {
          for (const row of this.db.all("SELECT data FROM bo_records WHERE scope=?", [scope])) {
            if (typeof row.data !== "string") continue;
            const previous = BackOfficeRecordSchema.parse(JSON.parse(row.data));
            const record = upgradeBackOfficeRecord(current, upgraded, previous);
            if (record !== previous) this.db.run("UPDATE bo_records SET data=? WHERE scope=? AND id=?", [JSON.stringify(record), scope, record.id]);
          }
          for (const row of this.db.all("SELECT data FROM bo_views WHERE scope=?", [scope])) {
            if (typeof row.data !== "string") continue;
            const previous = BackOfficeViewSchema.parse(JSON.parse(row.data));
            const view = upgradeBackOfficeView(current, upgraded, previous);
            if (view !== previous) this.db.run("UPDATE bo_views SET data=? WHERE scope=? AND id=?", [JSON.stringify(view), scope, view.id]);
          }
          this.db.run("UPDATE bo_models SET data=? WHERE scope=?", [JSON.stringify(upgraded), scope]);
        }
        return upgraded;
      },
      { action: "model.initialize-or-upgrade" },
    );
  }
  transaction<T>(
    fn: () => T,
    context?: { actor?: BackOfficeActor; action: string },
  ): T {
    const level = this.transactionDepth++;
    const journalSavepoint = this.journal.savepoint();
    const savepoint = `bo_save_${level}`;
    let acquired = false,
      started = false,
      committed = false;
    try {
      if (!level) {
        this.journal.storage.acquire();
        acquired = true;
      }
      this.db.exec(level ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
      started = true;
      if (this.fileFailure) throw this.fileFailure;
      if (!level) { this.journal.begin(); this.validateFileKeys(); }
      const previousContext = context ? this.journal.currentContext() : null;
      if (context) this.journal.context(context.actor, context.action);
      const value = fn();
      if (value instanceof Promise)
        throw new Error(
          "Back Office database transactions must be synchronous.",
        );
      if (level && previousContext)
        this.journal.restoreContext(previousContext);
      if (!level) this.journal.flush();
      this.db.exec(level ? `RELEASE ${savepoint}` : "COMMIT");
      committed = true;
      if (!level) { this.journal.checkpoint(); this.cleanFileKeys(); }
      return value;
    } catch (error) {
      if (started && !committed) {
        this.db.exec(level ? `ROLLBACK TO ${savepoint}` : "ROLLBACK");
        if (!level) this.journal.rollback();
        else this.journal.rollbackTo(journalSavepoint);
      }
      throw error;
    } finally {
      this.transactionDepth--;
      if (acquired) this.journal.storage.release();
    }
  }
  checkIntegrity() {
    this.journal.storage.acquire();
    try {
      this.db.exec("BEGIN");
      try {
        if (this.fileFailure) throw this.fileFailure;
        const result = this.journal.verify();
        this.validateFileKeys();
        this.cleanFileKeys();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      this.journal.storage.release();
    }
  }

  private connectedAccount() {
    const hasConnection = this.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='eigenwelt_connections'");
    const row = hasConnection ? this.db.get("SELECT account_json,platform_url,platform_token FROM eigenwelt_connections WHERE workspace_id='eigenwelt-account'") : null;
    const account = row?.account_json ? z.object({ orgId: z.string(), userId: z.string(), orgRole: z.string().nullable().optional() }).safeParse(JSON.parse(String(row.account_json))) : null;
    return row?.platform_token && row.platform_url && account?.success ? { ...account.data, principalKey: backOfficePrincipalKey(String(row.platform_url), account.data.orgId, account.data.userId) } : null;
  }
  connectedPrincipalKey() { return this.connectedAccount()?.principalKey ?? null; }
  private requireIdentity(scope: string, actor: BackOfficeActor) {
    if (scope === "local" || !actor.principalKey) return;
    const account = this.connectedAccount();
    if (!account || account.orgId !== scope || account.userId !== actor.userId || account.principalKey !== actor.principalKey)
      throw new ApiError(409, "back_office_account_changed", "The connected account changed.");
    if (actor.replicaId && actor.replicaId !== this.replicaId(scope))
      throw new ApiError(409, "back_office_replica_changed", "The directory is updating.");
  }
  requireAccount(scope: string, actor: BackOfficeActor) {
    this.requireIdentity(scope, actor);
    if (scope === "local" || !actor.principalKey) return;
    const current = this.cachedPolicyActor(scope);
    if (!current || (actor.model && !current.model) || (actor.edit && !current.edit) || (actor.finance && !current.finance))
      throw new ApiError(403, "back_office_permissions_changed", "Your current permissions do not allow this action.");
  }
  private cachedPolicyActor(scope: string): BackOfficeActor | null {
    const account = this.connectedAccount();
    if (!account || account.orgId !== scope) return null;
    const hasPolicy = this.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='org_policy'");
    const row = hasPolicy ? this.db.get("SELECT snapshot_json,released_json FROM org_policy WHERE id='current'") : null;
    const snapshot = row ? OrgPolicySnapshotSchema.safeParse(JSON.parse(String(row.snapshot_json))) : null;
    const released = row ? z.array(z.string()).parse(JSON.parse(String(row.released_json))) : [];
    const policy = snapshot?.success && snapshot.data.orgId === scope ? parseOrgPolicyEntries(snapshot.data.entries)["backOffice.sync"] : null;
    const value = policy?.mode === "enforced" && !released.includes("backOffice.sync") ? policy.value : null;
    const admin = account?.orgRole === "org:admin";
    return value?.enabled ? { userId: account.userId, principalKey: account.principalKey,
      model: admin || value.modelEditors.includes(account.userId),
      edit: admin || value.directoryEditors.includes(account.userId),
      finance: value.billingMembers.includes(account.userId),
    } : null;
  }
  currentCachedActor(scope: string): BackOfficeActor | null {
    const actor = this.cachedPolicyActor(scope), replicaId = this.replicaId(scope);
    return actor && replicaId ? { ...actor, replicaId } : null;
  }
  /** Apply a persisted policy even without a subsequent UI request or sync. */
  applyCachedPolicy() {
    const expected = this.connectedPrincipalKey();
    for (const row of this.db.all("SELECT scope FROM bo_replicas")) {
      const scope = String(row.scope), actor = this.cachedPolicyActor(scope);
      if (actor) { this.bindAccount(scope, actor); this.restrictTeamAccess(scope, actor); }
      else this.suspendAccount(scope, null, "Team access changed. Reconnect as the author to review remaining drafts.", expected);
    }
  }

  accountPendingCount(scope: string, actor: BackOfficeActor) {
    this.requireIdentity(scope, actor);
    return Number(this.db.get("SELECT count(*) AS count FROM bo_outbox WHERE scope=? AND json_extract(data,'$.authorKey')=?", [scope, backOfficeAuthorKey(actor)])?.count ?? 0);
  }

  teamScopes() {
    return this.db.all("SELECT scope FROM bo_models UNION SELECT scope FROM bo_records UNION SELECT scope FROM bo_views UNION SELECT scope FROM bo_outbox UNION SELECT scope FROM bo_replicas UNION SELECT scope FROM bo_files")
      .map(row => String(row.scope)).filter(scope => scope !== "local");
  }

  replicaId(scope: string): string | null {
    const row = this.db.get("SELECT data FROM bo_replicas WHERE scope=?", [scope]);
    return row ? z.object({ replicaId: z.string().uuid().optional() }).parse(JSON.parse(String(row.data))).replicaId ?? null : null;
  }
  private retireCache(scope: string, actor?: BackOfficeActor) {
    for (const row of this.db.all("SELECT id FROM bo_files WHERE scope=?", [scope])) {
      const file = this.fileManifest(scope, String(row.id));
      const record = file ? this.raw(scope, file.recordId) : null;
      const field = file ? this.model(scope).objects.find(object => object.id === record?.objectId)?.fields.find(field => field.id === file.fieldId && field.type === "file") : null;
      if (!actor || !record || !field || !this.canRead(scope, record, actor) || (field.visibility === "finance" && !actor.finance) || (field.visibility === "private" && record.ownerId !== actor.userId))
        this.db.run("DELETE FROM bo_files WHERE scope=? AND id=?", [scope, String(row.id)]);
    }
    this.fileCleanupNeeded = true;
    const binding = this.db.get("SELECT data FROM bo_replicas WHERE scope=?", [scope]);
    if (binding) {
      const previous = ReplicaBindingSchema.parse(JSON.parse(String(binding.data)));
      this.db.run("UPDATE bo_replicas SET data=? WHERE scope=?", [JSON.stringify({ ...previous, position: undefined, replicaId: randomUUID() }), scope]);
    }
    this.journal.retire(scope);
  }

  fileManifest(scope: string, id: string) {
    const row = this.db.get("SELECT data FROM bo_files WHERE scope=? AND id=?", [scope, id]);
    return row ? BackOfficeFileSchema.extend({ keyId: z.string().uuid(), keyHash: z.string(), ready: z.boolean() }).parse(JSON.parse(String(row.data))) : null;
  }
  private cleanFileKeys() {
    const version = Number(this.db.get("PRAGMA data_version")?.data_version);
    if (!this.fileCleanupNeeded && this.fileCleanupVersion === version) return;
    try {
      const retained = new Set(this.db.all("SELECT data FROM bo_files").map(row => z.object({ keyId: z.string().uuid() }).parse(JSON.parse(String(row.data))).keyId));
      for (const id of this.journal.storage.fileKeyIds()) if (!retained.has(id)) this.journal.storage.eraseFileKey(id);
      this.fileCleanupNeeded = false;
      this.fileCleanupVersion = version;
    } catch (error) {
      this.fileFailure = error instanceof Error ? error : new Error("Attachment keys could not be cleaned up.");
      throw this.fileFailure;
    }
  }
  private validateFileKeys() {
    for (const row of this.db.all("SELECT scope,id FROM bo_files")) {
      const manifest = this.fileManifest(String(row.scope), String(row.id));
      const key = manifest ? this.journal.storage.fileKey(manifest.keyId) : null;
      if (!manifest || !key || createHash("sha256").update(key).digest("hex") !== manifest.keyHash)
        throw new Error("The attachment key is missing or changed. Preserve the data before recovery.");
    }
  }
  prepareFileManifest(scope: string, actor: BackOfficeActor, file: BackOfficeFile) {
    this.model(scope);
    return this.transaction(() => {
      this.requireAccount(scope, actor);
      const previous = this.fileManifest(scope, file.id);
      if (previous) {
        if (canonicalBackOfficeAudit(BackOfficeFileSchema.parse(previous)) !== canonicalBackOfficeAudit(file))
          throw new ApiError(409, "back_office_file", "This attachment identity already belongs to another version.");
        const key = this.journal.storage.fileKey(previous.keyId);
        if (!key || createHash("sha256").update(key).digest("hex") !== previous.keyHash) throw new Error("The attachment key is missing or changed. Preserve the data before recovery.");
        return { ...previous, key };
      }
      const keyId = randomUUID(), key = this.journal.storage.createFileKey(keyId);
      this.fileCleanupNeeded = true;
      const manifest = { ...file, keyId, keyHash: createHash("sha256").update(key).digest("hex"), ready: false };
      this.db.run("INSERT INTO bo_files VALUES(?,?,?)", [scope, file.id, JSON.stringify(manifest)]);
      return { ...manifest, key };
    }, { actor, action: "file.prepare" });
  }
  commitFileManifest(scope: string, actor: BackOfficeActor, id: string, keyId: string) {
    this.transaction(() => {
      this.requireAccount(scope, actor);
      const current = this.fileManifest(scope, id);
      if (!current || current.keyId !== keyId) throw new ApiError(409, "back_office_replica_changed", "Attachment access changed. Try again.");
      this.db.run("UPDATE bo_files SET data=? WHERE scope=? AND id=?", [JSON.stringify({ ...current, ready: true }), scope, id]);
    }, { actor, action: "file.commit" });
  }

  bindAccount(scope: string, actor: BackOfficeActor) {
    this.transaction(() => {
      this.requireAccount(scope, actor);
      const key = backOfficeAuthorKey(actor);
      const current = this.db.get("SELECT data FROM bo_replicas WHERE scope=?", [scope]);
      const previous = current ? ReplicaBindingSchema.parse(JSON.parse(String(current.data))) : null;
      const permissions = { model: actor.model, edit: actor.edit, finance: actor.finance };
      if (previous?.principalKey === key && previous.replicaId) {
        if (canonicalBackOfficeAudit(previous.permissions ?? null) !== canonicalBackOfficeAudit(permissions)) {
          this.db.run("UPDATE bo_replicas SET data=? WHERE scope=?", [JSON.stringify({ ...previous, permissions }), scope]);
          if (!previous.permissions || (previous.permissions.model && !actor.model) || (previous.permissions.edit && !actor.edit) || (previous.permissions.finance && !actor.finance)) {
            this.restrictTeamAccess(scope, actor);
            this.retireCache(scope, actor);
          }
        }
        return;
      }
      this.suspendTeam(scope, "The connected account changed. Reconnect to load authorized team records.");
      if (previous?.principalKey !== key)
        this.db.run("UPDATE bo_sync SET cursor=0 WHERE scope=?", [scope]);
      this.db.run("INSERT INTO bo_replicas VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET data=excluded.data", [scope, JSON.stringify({ id: "replica", principalKey: key, replicaId: randomUUID(), permissions })]);
    }, { actor, action: "cache.account" });
  }

  suspendAccount(scope: string, principalKey: string | null, message: string, expectedConnection?: string | null, preservePrincipal?: string | null) {
    this.transaction(() => {
      if (expectedConnection !== undefined && this.connectedPrincipalKey() !== expectedConnection) return;
      const row = this.db.get("SELECT data FROM bo_replicas WHERE scope=?", [scope]);
      const bound = row ? z.object({ principalKey: z.string() }).parse(JSON.parse(String(row.data))).principalKey : null;
      if (bound && ((principalKey !== null && bound !== principalKey) || (preservePrincipal && bound === preservePrincipal))) return;
      this.suspendTeam(scope, message);
    }, { action: "cache.account-revoke" });
  }

  audit(
    scope: string,
    actor: BackOfficeActor,
    action: string,
    id: string,
    data: unknown,
  ) {
    this.journal.attribute(scope, actor, action, id);
  }
  enqueue(
    scope: string,
    actor: BackOfficeActor,
    kind: BackOfficeChange["kind"],
    revision: number,
    data: unknown,
    changedFields?: string[],
    changedMetadata: BackOfficeChange["changedMetadata"] = [],
    base?: BackOfficeRecord,
  ) {
    if (scope === "local") return;
    if (kind === "record" && revision > 0) {
      const record = BackOfficeRecordSchema.parse(data);
      data = {
        ...record,
        values: Object.fromEntries(Object.entries(record.values).filter(([id]) => changedFields?.includes(id))),
        sourceId: changedMetadata.includes("sourceId") ? record.sourceId : undefined,
        access: changedMetadata.includes("sharing") ? record.access : "org",
        members: changedMetadata.includes("sharing") ? record.members : [],
      };
    }
    const change: BackOfficeChange = {
      id: randomUUID(),
      kind,
      baseRevision: revision,
      schemaRevision: this.model(scope).revision,
      data,
      changedFields,
      changedMetadata,
      authorKey: backOfficeAuthorKey(actor),
    };
    const selection = base && !changedMetadata.length && selectionField(this.model(scope), base, changedFields);
    const selectionBase = selection ? selectionIds(base?.values[selection])?.map(memberHash) : undefined;
    this.db.run("INSERT INTO bo_outbox(scope,id,data) VALUES(?,?,?)", [
      scope,
      change.id,
      JSON.stringify(base && changedFields && changedMetadata.every(key => key === "archive")
        ? { ...change, editBase: editBaseDigest(base, changedFields), selectionBase } : change),
    ]);
    return change.id;
  }
  raw(scope: string, id: string): BackOfficeRecord | null {
    const row = this.db.get(
      "SELECT data FROM bo_records WHERE scope=? AND id=?",
      [scope, id],
    );
    return typeof row?.data === "string"
      ? BackOfficeRecordSchema.parse(JSON.parse(row.data))
      : null;
  }
  canRead(scope: string, record: BackOfficeRecord, actor: BackOfficeActor) {
    if (!visibleBackOfficeRecord(record, actor)) return false;
    const matter = record.values.matter;
    if (typeof matter === "string" && matter !== record.id) {
      const parent = this.raw(scope, matter);
      if (!parent || !visibleBackOfficeRecord(parent, actor)) return false;
    }
    return true;
  }
  records(
    scope: string,
    actor: BackOfficeActor,
    objectId?: string,
    archived = false,
  ): BackOfficeRecord[] {
    this.requireAccount(scope, actor);
    const model = this.model(scope);
    return this.db
      .all(
        "SELECT data FROM bo_records WHERE scope=?" +
          (objectId ? " AND object_id=?" : ""),
        objectId ? [scope, objectId] : [scope],
      )
      .flatMap((row) => {
        if (typeof row.data !== "string") return [];
        const record = BackOfficeRecordSchema.parse(JSON.parse(row.data));
        const object = model.objects.find(
          (object) => object.id === record.objectId,
        );
        return object &&
          !object.archived &&
          Boolean(record.archivedAt) === archived &&
          this.canRead(scope, record, actor)
          ? [readableBackOfficeRecord(record, object, actor)]
          : [];
      });
  }
  saveRecord(
    scope: string,
    actor: BackOfficeActor,
    input: unknown,
  ): BackOfficeRecord {
    if (!actor.edit)
      throw new ApiError(
        403,
        "back_office_forbidden",
        "You do not have permission to edit these records.",
      );
    const parsed = inputRecord.parse(input);
    return this.transaction(
      () => {
        this.requireAccount(scope, actor);
        const model = this.model(scope),
          object = model.objects.find(
            (object) => object.id === parsed.objectId && !object.archived,
          );
        if (
          ["feeAgreements", "billingItems", "invoices"].includes(
            parsed.objectId,
          ) &&
          !actor.finance
        )
          throw new ApiError(
            403,
            "back_office_finance",
            "Billing access is required for this object.",
          );
        if (!object)
          throw new ApiError(
            404,
            "back_office_object",
            "The object is unavailable.",
          );
        const existing = parsed.id ? this.raw(scope, parsed.id) : null;
        if (parsed.id && !existing && !parsed.create)
          throw new ApiError(
            404,
            "back_office_record",
            "The record is unavailable.",
          );
        if (
          existing &&
          (!this.canRead(scope, existing, actor) ||
            existing.objectId !== object.id)
        )
          throw new ApiError(
            404,
            "back_office_record",
            "The record is unavailable.",
          );
        if (parsed.create && existing) {
          if (parsed.revision === 0 && existing.revision === 1 && existing.ownerId === actor.userId &&
              parsed.sourceId === undefined && parsed.members === undefined && parsed.access === undefined &&
              parsed.archived === undefined && !existing.archivedAt &&
              canonicalBackOfficeAudit(existing.values) === canonicalBackOfficeAudit({ ...defaultBackOfficeValues(object), ...parsed.values }))
            return readableBackOfficeRecord(existing, object, actor);
          conflict("This record identity already exists.");
        }
        const revision = existing?.revision ?? 0;
        const mergeable = existing && parsed.revision > 0 && parsed.revision <= revision &&
          !parsed.create && parsed.sourceId === undefined && parsed.access === undefined && parsed.members === undefined &&
          (parsed.expectedValues !== undefined || (parsed.archived !== undefined && !Object.keys(parsed.values).length));
        if (revision !== parsed.revision && !mergeable) conflict();
        if (
          existing &&
          ((parsed.access !== undefined && parsed.access !== existing.access) ||
            (parsed.members !== undefined &&
              JSON.stringify(parsed.members) !==
                JSON.stringify(existing.members))) &&
          existing.ownerId !== actor.userId &&
          !actor.model
        )
          throw new ApiError(
            403,
            "back_office_access",
            "Only the owner or a model administrator can change sharing.",
          );
        const recordId = existing?.id ?? parsed.id ?? randomUUID();
        const values = { ...(existing ? existing.values : defaultBackOfficeValues(object)) };
        for (const [id, raw] of Object.entries(parsed.values)) {
          const field = object.fields.find((field) => field.id === id);
          if (!field)
            throw new ApiError(
              400,
              "back_office_field",
              `Unknown field ${id}.`,
            );
          if (
            (field.visibility === "finance" && !actor.finance) ||
            (field.visibility === "private" &&
              existing &&
              existing.ownerId !== actor.userId)
          )
            throw new ApiError(
              403,
              "back_office_field",
              `You cannot edit ${field.label}.`,
            );
          let value = BackOfficeValueSchema.parse(raw);
          if (existing && mergeable && parsed.expectedValues && Object.hasOwn(parsed.expectedValues, id) &&
              (field.type === "multiselect" || field.type === "relation" && field.multiple)) {
            const before = selectionIds(parsed.expectedValues[id]), desired = selectionIds(value), current = selectionIds(existing.values[id]);
            if (before && desired && current) {
              value = mergeSelection(before.map(memberHash), desired, current);
              parsed.expectedValues[id] = existing.values[id] ?? null;
            }
          }
          if (field.type === "file" && value !== null) {
            for (const file of BackOfficeFilesSchema.parse(value)) {
              if (file.recordId !== recordId || file.fieldId !== field.id)
                throw new ApiError(
                  400,
                  "back_office_file",
                  "Attach a copy to this record and field before linking it.",
                );
              const manifest = scope === "local" ? this.fileManifest(scope, file.id) : null;
              if (scope === "local" && (!manifest?.ready || canonicalBackOfficeAudit(BackOfficeFileSchema.parse(manifest)) !== canonicalBackOfficeAudit(file)))
                throw new ApiError(409, "back_office_file", "The attachment has not been saved successfully. Attach its copy before saving.");
            }
          }
          if (field.type === "relation" && value) {
            for (const target of Array.isArray(value) ? value : [value]) {
              const related =
                typeof target === "string" ? this.raw(scope, target) : null;
              if (
                !related ||
                related.archivedAt ||
                related.objectId !== field.target ||
                !this.canRead(scope, related, actor)
              )
                throw new ApiError(
                  400,
                  "back_office_relation",
                  "Choose an accessible record from the target object.",
                );
            }
          }
          values[id] = value;
        }
        if (mergeable) {
          const keys = Object.keys(parsed.values);
          const same = (a: BackOfficeRecord["values"][string] | undefined, b: BackOfficeRecord["values"][string] | undefined) => canonicalBackOfficeAudit(a ?? null) === canonicalBackOfficeAudit(b ?? null);
          if (revision !== parsed.revision) {
            if (existing.archivedAt && parsed.archived === undefined)
              throw new ApiError(409, "back_office_archived", "This record was archived while you were editing.");
            const conflicts = keys.filter(id => !same(existing.values[id], values[id]) &&
              (!Object.hasOwn(parsed.expectedValues ?? {}, id) || !same(existing.values[id], parsed.expectedValues?.[id])));
            if (conflicts.length)
              throw new ApiError(409, "back_office_field_conflict", "Two edits changed the same field.", {
                record: readableBackOfficeRecord(existing, object, actor), fields: conflicts,
              });
          }
          if (keys.every(id => same(existing.values[id], values[id])) &&
              (parsed.archived === undefined || parsed.archived === Boolean(existing.archivedAt)))
            return readableBackOfficeRecord(existing, object, actor);
        }
        try {
          validateBackOfficeValues(object, values);
        } catch (error) {
          throw new ApiError(
            400,
            "back_office_value",
            error instanceof Error ? error.message : "Check the values.",
          );
        }
        if (
          object.id === "projectLinks" &&
          (!values.matter ||
            this.records(scope, actor, "projectLinks").some(
              (record) =>
                record.id !== existing?.id &&
                record.values.projectId === values.projectId &&
                record.values.matter === values.matter,
            ))
        )
          throw new ApiError(
            409,
            "back_office_project_link",
            "This project and matter are already linked, or the matter is missing.",
          );
        const now = new Date().toISOString();
        const record = BackOfficeRecordSchema.parse({
          ...existing,
          id: recordId,
          objectId: object.id,
          values,
          sourceId:
            parsed.sourceId === undefined
              ? existing?.sourceId
              : parsed.sourceId,
          revision: revision + 1,
          schemaRevision: model.revision,
          ownerId: existing?.ownerId ?? actor.userId,
          access: parsed.access ?? existing?.access ?? "org",
          members: parsed.members ?? existing?.members ?? [],
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
          archivedAt:
            parsed.archived === undefined
              ? (existing?.archivedAt ?? null)
              : parsed.archived
                ? now
                : null,
        });
        this.db.run(
          "INSERT INTO bo_records VALUES(?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET data=excluded.data",
          [scope, record.id, record.objectId, JSON.stringify(record)],
        );
        if (scope === "local" && !existing) {
          const principal = this.connectedPrincipalKey();
          if (principal) this.db.run("INSERT INTO bo_first_sync(id,principal) VALUES(?,?)", [record.id, principal]);
        }
        this.audit(
          scope,
          actor,
          existing ? "record.update" : "record.create",
          record.id,
          { before: existing, after: record },
        );
        const changedMetadata: NonNullable<BackOfficeChange["changedMetadata"]> = [];
        if (parsed.sourceId !== undefined && parsed.sourceId !== existing?.sourceId)
          changedMetadata.push("sourceId");
        if ((parsed.access !== undefined && parsed.access !== existing?.access) ||
          (parsed.members !== undefined && JSON.stringify(parsed.members) !== JSON.stringify(existing?.members)))
          changedMetadata.push("sharing");
        if (parsed.archived !== undefined && parsed.archived !== Boolean(existing?.archivedAt))
          changedMetadata.push("archive");
        this.enqueue(
          scope,
          actor,
          "record",
          revision,
          record,
          Object.keys(parsed.values).filter(id => !existing || existing.values[id] === undefined || canonicalBackOfficeAudit(existing.values[id]) !== canonicalBackOfficeAudit(record.values[id])),
          changedMetadata,
          existing ?? undefined,
        );
        return readableBackOfficeRecord(record, object, actor);
      },
      { actor, action: "record.write" },
    );
  }
  previewModel(
    scope: string,
    actor: BackOfficeActor,
    input: unknown,
    revision: number,
  ) {
    if (!actor.model)
      throw new ApiError(
        403,
        "back_office_model",
        "Model administrator permission is required.",
      );
    const candidate = BackOfficeModelSchema.parse(input),
      current = this.model(scope);
    if (revision !== current.revision)
      conflict("The data model changed while you were editing.");
    const changes = candidate.objects.flatMap((object) => {
      const before = current.objects.find((item) => item.id === object.id);
      if (JSON.stringify(before) === JSON.stringify(object)) return [];
      const records = Number(
        this.db.get(
          "SELECT count(*) AS count FROM bo_records WHERE scope=? AND object_id=?",
          [scope, object.id],
        )?.count ?? 0,
      );
      return [
        {
          object: object.plural,
          action: !before
            ? "Add object"
            : object.archived !== before.archived
              ? object.archived
                ? "Archive object"
                : "Restore object"
              : "Update fields or labels",
          records,
        },
      ];
    });
    const errors: string[] = [];
    try {
      assertModelChange(current, candidate);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Check the model.");
    }
    for (const row of this.db.all("SELECT data FROM bo_records WHERE scope=?", [
      scope,
    ])) {
      const record = BackOfficeRecordSchema.parse(JSON.parse(String(row.data))),
        object = candidate.objects.find(
          (object) => object.id === record.objectId,
        );
      if (!object) {
        errors.push("Archive populated objects instead of deleting them.");
        break;
      }
      try {
        validateBackOfficeValues(object, record.values);
      } catch {
        errors.push(
          "Existing values require a migration. Preserve populated fields and fill required values first.",
        );
        break;
      }
    }
    return { changes, valid: !errors.length, errors };
  }
  saveModel(
    scope: string,
    actor: BackOfficeActor,
    input: unknown,
    baseRevision: number,
  ): BackOfficeModel {
    if (!actor.model)
      throw new ApiError(
        403,
        "back_office_model",
        "Only model administrators can change the data model.",
      );
    const candidate = BackOfficeModelSchema.parse(input);
    return this.transaction(
      () => {
        this.requireAccount(scope, actor);
        const current = this.model(scope);
        if (current.revision !== baseRevision)
          conflict(
            "The data model changed while you were editing.",
          );
        try {
          assertModelChange(current, candidate);
        } catch (error) {
          throw new ApiError(
            400,
            "back_office_protected",
            error instanceof Error ? error.message : "Check the model.",
          );
        }
        const allRecords = this.db.all(
          "SELECT data FROM bo_records WHERE scope=?",
          [scope],
        );
        for (const row of allRecords) {
          const record = BackOfficeRecordSchema.parse(
            JSON.parse(String(row.data)),
          );
          const object = candidate.objects.find(
            (object) => object.id === record.objectId,
          );
          if (!object)
            throw new ApiError(
              409,
              "back_office_migration",
              "Archive an object instead of deleting records it contains.",
            );
          try {
            validateBackOfficeValues(object, record.values);
          } catch {
            throw new ApiError(
              409,
              "back_office_migration",
              "This model change requires a data migration. Preserve existing field types and values, or fill required fields first.",
            );
          }
        }
        const next = {
          ...candidate,
          templateVersion: current.templateVersion,
          revision: current.revision + 1,
        };
        this.db.run("UPDATE bo_models SET data=? WHERE scope=?", [
          JSON.stringify(next),
          scope,
        ]);
        this.audit(scope, actor, "model.update", "model", {
          before: current,
          after: next,
        });
        this.enqueue(scope, actor, "model", current.revision, next);
        return next;
      },
      { actor, action: "model.update" },
    );
  }
  views(scope: string): BackOfficeView[] {
    return this.db
      .all("SELECT data FROM bo_views WHERE scope=?", [scope])
      .map((row) => BackOfficeViewSchema.parse(JSON.parse(String(row.data))));
  }
  saveView(scope: string, actor: BackOfficeActor, input: unknown) {
    if (!actor.edit)
      throw new ApiError(403, "back_office_view", "You cannot save views.");
    const patch = z.record(z.string(), z.unknown()).parse(input);
    const expected = patch.expected === undefined ? undefined : BackOfficeViewSchema.nullable().parse(patch.expected);
    return this.transaction(
      () => {
        this.requireAccount(scope, actor);
        const existing = this.views(scope).find(view => view.id === patch.id);
        if (existing && expected === undefined)
          throw new ApiError(428, "back_office_view_base_required", "The original view settings are missing.");
        const comparable = (view?: BackOfficeView | null) => view ? { ...view, filterCriteria: view.filterCriteria ?? null } : null;
        if (canonicalBackOfficeAudit(comparable(existing)) !== canonicalBackOfficeAudit(comparable(expected)))
          throw new ApiError(409, "back_office_view_conflict", "This view changed elsewhere.");
        const view = BackOfficeViewSchema.parse({ ...existing, ...patch });
        try {
          validateBackOfficeView(this.model(scope), view);
        } catch (error) {
          throw new ApiError(400, "back_office_view", error instanceof Error ? error.message : "Check the view settings.");
        }
        this.db.run(
          "INSERT INTO bo_views VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET data=excluded.data",
          [scope, view.id, JSON.stringify(view)],
        );
        this.enqueue(scope, actor, "view", 0, view);
        this.audit(scope, actor, "view.save", view.id, view);
        return view;
      },
      { actor, action: "view.save" },
    );
  }
  history(scope: string, actor: BackOfficeActor, id: string) {
    this.requireAccount(scope, actor);
    if (id !== "model") {
      const record = this.raw(scope, id);
      if (!record || !this.canRead(scope, record, actor))
        throw new ApiError(
          404,
          "back_office_record",
          "The record is unavailable.",
        );
    }
    if (!actor.model) return [];
    return this.journal.history(scope, id);
  }
  pending(scope: string, limit = 100, actor?: BackOfficeActor) {
    if (actor) this.requireAccount(scope, actor);
    return this.db
      .all(
        "SELECT seq,data,error,json_extract(data,'$.selectionBase') AS selection_base FROM bo_outbox WHERE scope=?" + (actor ? " AND json_extract(data,'$.authorKey')=?" : "") + " ORDER BY seq" +
          (limit ? ` LIMIT ${limit}` : ""),
        actor ? [scope, backOfficeAuthorKey(actor)] : [scope],
      )
      .map((row) => ({
        seq: Number(row.seq),
        change: BackOfficeChangeSchema.parse(JSON.parse(String(row.data))),
        error: row.error,
        selectionBase: row.selection_base == null ? undefined : z.array(z.string()).parse(JSON.parse(String(row.selection_base))),
      }));
  }
  syncState(scope: string, actor?: BackOfficeActor) {
    const row = this.db.get("SELECT * FROM bo_sync WHERE scope=?", [scope]);
    const personal = this.pending(scope, 0, actor);
    const blocked = personal.find((entry) => entry.error);
    return {
      enabled: Boolean(row?.enabled),
      cursor: Number(row?.cursor ?? 0),
      error: blocked
        ? String(blocked.error)
        : typeof row?.last_error === "string"
          ? row.last_error
          : null,
      pending: personal.length,
    };
  }
  setSync(scope: string, enabled: boolean) {
    this.db.run(
      "INSERT INTO bo_sync(scope,enabled) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET enabled=excluded.enabled WHERE bo_sync.enabled<>excluded.enabled",
      [scope, enabled ? 1 : 0],
    );
  }
  directoryPosition(scope: string, actor: BackOfficeActor): DirectoryPosition | null {
    this.requireAccount(scope, actor);
    const row = this.db.get("SELECT data FROM bo_replicas WHERE scope=?", [scope]);
    if (!row) return null;
    const binding = ReplicaBindingSchema.parse(JSON.parse(String(row.data)));
    return binding.principalKey === backOfficeAuthorKey(actor) && binding.replicaId === actor.replicaId ? binding.position ?? null : null;
  }
  receive(scope: string, snapshot: BackOfficeSnapshot, actor: BackOfficeActor, position?: DirectoryPosition, incremental = false, inbox?: SyncInbox) {
    const before = this.restrictionState(scope, actor);
    const localized = incremental && before.signature === this.lastRestricted?.signature;
    const replicaId = this.transaction(() => {
      this.requireAccount(scope, actor);
      const cursor = Number(this.db.get("SELECT cursor FROM bo_sync WHERE scope=?", [scope])?.cursor ?? 0);
      if (snapshot.cursor < cursor)
        throw new ApiError(409, "back_office_snapshot_stale", "A newer team snapshot is already stored.");
      const previousModel = this.db.get("SELECT data FROM bo_models WHERE scope=?", [scope]);
      let revoked = Boolean(previousModel && canonicalBackOfficeAudit(BackOfficeModelSchema.parse(JSON.parse(String(previousModel.data)))) !== canonicalBackOfficeAudit(snapshot.model));
      const settledIds = new Set<string>();
      if (incremental) for (const id of [...snapshot.accepted, ...snapshot.conflicts.map(item => item.id)]) {
        const entry=this.db.get("SELECT json_extract(data,'$.data.id') AS record FROM bo_outbox WHERE scope=? AND id=? AND json_extract(data,'$.kind')='record' AND json_extract(data,'$.authorKey')=?",
          [scope,id,backOfficeAuthorKey(actor)]);
        if (entry?.record) settledIds.add(String(entry.record));
      }
      for (const id of snapshot.accepted) {
        this.db.run("UPDATE bo_first_sync SET confirmed=1,operation=NULL WHERE operation=? AND principal=?", [id, backOfficeAuthorKey(actor)]);
        this.db.run("DELETE FROM bo_outbox WHERE scope=? AND id=? AND json_extract(data,'$.authorKey')=?", [
          scope,
          id,
          backOfficeAuthorKey(actor),
        ]);
      }
      for (const conflict of snapshot.conflicts) {
        const params = [scope, conflict.id, backOfficeAuthorKey(actor)];
        const where = " WHERE scope=? AND id=? AND json_extract(data,'$.authorKey')=?";
        const row = this.db.get("SELECT data,json_extract(data,'$.editBase') AS base FROM bo_outbox" + where, params);
        if (row && typeof row.base === "string" && actor.edit) {
          const change = BackOfficeChangeSchema.parse(JSON.parse(String(row.data)));
          const draft = BackOfficeRecordSchema.parse(change.data);
          const found = inbox ? inbox.get(draft.id) : snapshot.records.find(record => record.id === draft.id);
          const remote = found?.objectId === draft.objectId ? found : undefined;
          const base = z.object({ selectionBase: z.array(z.string()).optional() }).parse(JSON.parse(String(row.data))).selectionBase;
          const field = remote && base && !remote.archivedAt && !draft.archivedAt && selectionField(snapshot.model, remote, change.changedFields);
          const desired = field ? selectionIds(draft.values[field]) : undefined;
          const current = field && remote ? selectionIds(remote.values[field]) : undefined;
          const selection = base && desired && current ? mergeSelection(base, desired, current) : undefined;
          if (remote && remote.revision > change.baseRevision && change.changedFields &&
              (selection || editBaseDigest(remote, change.changedFields) === row.base ||
                (change.changedMetadata?.includes("archive") && !change.changedFields.length && Boolean(draft.archivedAt) === Boolean(remote.archivedAt)))) {
            // Only a rejected operation is rebased. Accepted operation IDs stay immutable.
            const archiveTime = remote.archivedAt && draft.archivedAt ? remote.archivedAt : draft.archivedAt;
            this.db.run("UPDATE bo_outbox SET data=?,error=NULL" + where, [JSON.stringify({
              ...change, baseRevision: remote.revision, editBase: editBaseDigest(remote, change.changedFields),
              selectionBase: selection && current?.map(memberHash),
              data: { ...draft, values: field && selection ? { ...draft.values, [field]: selection } : draft.values, revision: remote.revision + 1, archivedAt: archiveTime },
            }), ...params]);
            continue;
          }
        }
        this.db.run("UPDATE bo_outbox SET error=?" + where, [conflict.message, ...params]);
      }
      const pending = this.pending(scope, 0, actor);
      this.db.run(
          "INSERT INTO bo_models VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET data=excluded.data WHERE bo_models.data<>excluded.data",
          [scope, JSON.stringify(snapshot.model)],
        );
      const newDrafts = new Set(
        pending.flatMap((entry) =>
          entry.change.kind === "record" &&
          entry.change.baseRevision === 0 &&
          !entry.error
            ? [BackOfficeRecordSchema.parse(entry.change.data).id]
            : [],
        ),
      );
      const incomingIds = new Set(snapshot.records.map(record => record.id));
      const missing = incremental
        ? [...settledIds].filter(id => !(inbox ? inbox.get(id) : incomingIds.has(id))).map(id => ({id}))
        : inbox ? inbox.missing(this.db,scope) : this.db.all("SELECT id FROM bo_records WHERE scope=?", [scope]).filter(row => !incomingIds.has(String(row.id)));
      for (const row of missing) {
        if (!newDrafts.has(String(row.id))) {
          revoked = true;
          this.db.run("DELETE FROM bo_records WHERE scope=? AND id=?", [scope, String(row.id)]);
        }
      }
      const changedIds: string[] = [];
      for (const record of inbox ? inbox.records() : snapshot.records) {
        const previous = this.raw(scope, record.id);
        let projected = record;
        const object = snapshot.model.objects.find(object => object.id === record.objectId);
        for (const queued of pending) {
          if (queued.change.kind !== "record" || queued.error || !object) continue;
          const draft = BackOfficeRecordSchema.parse(queued.change.data);
          if (draft.id !== record.id) continue;
          const authored = new Set(queued.change.changedFields ?? []);
          const values = readableBackOfficeRecord({ ...record, values: Object.fromEntries(Object.entries(draft.values).filter(([id]) => authored.has(id))) }, object, actor).values;
          const field = queued.selectionBase && selectionField(snapshot.model, record, queued.change.changedFields);
          if (field && queued.selectionBase && Object.hasOwn(values, field)) {
            const current = selectionIds(projected.values[field]), desired = selectionIds(values[field]);
            if (current && desired) values[field] = mergeSelection(queued.selectionBase, desired, current);
          }
          const metadata = queued.change.changedMetadata;
          projected = { ...projected, values: { ...projected.values, ...values },
            revision: Math.max(projected.revision, draft.revision),
            updatedAt: draft.updatedAt,
            sourceId: metadata?.includes("sourceId") ? draft.sourceId : projected.sourceId,
            access: metadata?.includes("sharing") ? draft.access : projected.access,
            members: metadata?.includes("sharing") ? draft.members : projected.members,
            archivedAt: metadata?.includes("archive") ? draft.archivedAt : projected.archivedAt,
          };
        }
        // An unsent field can be absent from the platform snapshot but still
        // present in the authorized projection. That is not an access change.
        if (previous && (Object.keys(previous.values).some(id => !(id in projected.values)) || previous.access !== record.access || previous.ownerId !== record.ownerId || canonicalBackOfficeAudit(previous.members) !== canonicalBackOfficeAudit(record.members))) revoked = true;
        if (previous && JSON.stringify(previous) === JSON.stringify(projected)) continue;
        if (incremental) changedIds.push(record.id);
        this.db.run(
          "INSERT INTO bo_records VALUES(?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET data=excluded.data",
          [scope, record.id, record.objectId, JSON.stringify(projected)],
        );
      }
      if (!pending.some(entry => entry.change.kind === "view")) {
        const kept = new Set(snapshot.views.map(view => view.id));
        for (const row of this.db.all("SELECT id FROM bo_views WHERE scope=?", [scope])) {
          if (!kept.has(String(row.id))) this.db.run("DELETE FROM bo_views WHERE scope=? AND id=?", [scope, String(row.id)]);
        }
        for (const view of snapshot.views) {
          this.db.run(
            "INSERT INTO bo_views VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET data=excluded.data WHERE bo_views.data<>excluded.data",
            [scope, view.id, JSON.stringify(view)],
          );
        }
      }
      this.db.run(
        "INSERT INTO bo_sync(scope,cursor,enabled,last_error) VALUES(?,?,1,?) ON CONFLICT(scope) DO UPDATE SET cursor=excluded.cursor,last_error=excluded.last_error WHERE bo_sync.cursor<>excluded.cursor OR bo_sync.enabled<>1 OR bo_sync.last_error IS NOT excluded.last_error",
        [scope, snapshot.cursor, snapshot.conflicts[0]?.message ?? null],
      );
      this.restrictTeamAccess(scope, actor, localized && !revoked ? changedIds : undefined);
      if (revoked) this.retireCache(scope, actor);
      const bound = this.db.get("SELECT data FROM bo_replicas WHERE scope=?", [scope]);
      if (bound) {
        const binding=ReplicaBindingSchema.parse(JSON.parse(String(bound.data)));
        if (binding.position?.access !== position?.access || binding.position?.cursor !== position?.cursor)
          this.db.run("UPDATE bo_replicas SET data=? WHERE scope=?",[JSON.stringify({...binding,position}),scope]);
      }
      return this.replicaId(scope);
    });
    if (!this.transactionDepth) {
      const after = this.restrictionState(scope, replicaId ? {...actor, replicaId} : actor);
      this.lastRestricted = after.version === before.version ? after : null;
    }
    return replicaId;
  }

  /** Current permissions also apply to cached values and copied proposal data. */
  restrictTeamAccess(scope: string, actor: BackOfficeActor, changedIds?: string[]) {
    if (scope === "local") return;
    this.requireAccount(scope, actor);
    // Only committed signed work can be memoized. Pending operations inside a
    // transaction have not reached the journal yet and must be checked directly.
    const outer = this.transactionDepth === 0 && !changedIds;
    const before = outer ? this.restrictionState(scope, actor) : null;
    if (before && this.lastRestricted?.signature === before.signature) {
      // Other stores share runtime.sqlite. An external write still triggers
      // integrity verification. Reapply permissions only if the CRM head moved.
      if (this.lastRestricted.version !== before.version) this.checkIntegrity();
      this.lastRestricted = before;
      return;
    }
    this.transaction(() => {
      this.requireAccount(scope, actor);
      const modelRow = this.db.get("SELECT data FROM bo_models WHERE scope=?", [scope]);
      if (!modelRow) return;
      const model = BackOfficeModelSchema.parse(JSON.parse(String(modelRow.data)));
      let revoked = false;
      // The platform resets a paged transfer whenever directory visibility
      // changes. Inside a stable incremental transfer only these rows changed.
      const rows = changedIds
        ? this.db.all("SELECT data FROM bo_records WHERE scope=? AND id IN (SELECT value FROM json_each(?))", [scope, JSON.stringify(changedIds)])
        : this.db.all("SELECT data FROM bo_records WHERE scope=?", [scope]);
      const records = rows.map(row => BackOfficeRecordSchema.parse(JSON.parse(String(row.data))));
      for (const record of records) {
        const object = model.objects.find(object => object.id === record.objectId);
        if (!object || !this.canRead(scope, record, actor)) {
          this.db.run("DELETE FROM bo_records WHERE scope=? AND id=?", [scope, record.id]);
          revoked = true;
          continue;
        }
        const next = readableBackOfficeRecord(record, object, actor);
        if (canonicalBackOfficeAudit(record.values) !== canonicalBackOfficeAudit(next.values)) {
          this.db.run("UPDATE bo_records SET data=? WHERE scope=? AND id=?", [JSON.stringify(next), scope, record.id]);
          revoked = true;
        }
      }
      // Saved filters only require membership checks for IDs they reference.
      const readableIds = { has: (id: string) => {
        const record = this.raw(scope, id);
        return !!record && this.canRead(scope, record, actor);
      } };
      for (const entry of this.pending(scope, 0, actor)) {
        const change = entry.change;
        if (change.kind === "view") {
          const view = BackOfficeViewSchema.parse(change.data);
          const next = readableBackOfficeView(view, model, actor, readableIds);
          if (!next) {
            this.db.run("DELETE FROM bo_outbox WHERE scope=? AND id=?", [scope, change.id]);
            revoked = true;
          } else if (canonicalBackOfficeAudit(next) !== canonicalBackOfficeAudit({ ...view, filterCriteria: view.filterCriteria ?? null })) {
            this.db.run("UPDATE bo_outbox SET data=?,error=? WHERE scope=? AND id=?", [JSON.stringify({ ...change, data: next }), "Access changed. Review the remaining view settings before sending.", scope, change.id]);
            revoked = true;
          } else if (!actor.edit && !entry.error)
            this.db.run("UPDATE bo_outbox SET error=? WHERE scope=? AND id=?", ["Editor permission is required before sending this view.", scope, change.id]);
          continue;
        }
        if (change.kind === "model") {
          if (!actor.model && JSON.stringify(change.data) !== JSON.stringify(model)) {
            this.db.run("UPDATE bo_outbox SET data=?,error=? WHERE scope=? AND id=?", [JSON.stringify({ ...change, data: model }), "Model access changed. Review the current definitions before editing.", scope, change.id]);
            revoked = true;
          }
          continue;
        }
        const record = BackOfficeRecordSchema.parse(change.data);
        const object = model.objects.find(object => object.id === record.objectId);
        const current = this.raw(scope, record.id);
        const authored = new Set(change.changedFields ?? (change.baseRevision === 0 ? Object.keys(record.values) : []));
        // A create carries model defaults even when the caller only supplied a name.
        const defaults = change.baseRevision === 0 && object ? defaultBackOfficeValues(object) : {};
        const values = Object.fromEntries(Object.entries(record.values).filter(([id, value]) => authored.has(id) || defaults[id] === value));
        const permitted = object && visibleBackOfficeRecord(record, actor)
          ? readableBackOfficeRecord({ ...record, values }, object, actor).values : {};
        const filtered = Object.fromEntries(Object.entries(permitted).filter(([id, value]) => {
          const field = object?.fields.find(field => field.id === id);
          if (!current && change.baseRevision > 0 && field?.type === "file") return false;
          if (field?.type !== "relation" || value === null) return true;
          return (Array.isArray(value) ? value : [value]).every(id => {
            const related = typeof id === "string" ? this.raw(scope, id) : null;
            return related && this.canRead(scope, related, actor);
          });
        }));
        const reduced = canonicalBackOfficeAudit(record.values) !== canonicalBackOfficeAudit(filtered);
        const next = { ...change, changedFields: Object.keys(filtered), data: { ...record, values: filtered,
          sourceId: current || change.baseRevision === 0 ? record.sourceId : undefined,
          members: current || change.baseRevision === 0 ? record.members : [],
        } };
        const blocked = reduced || (!current && change.baseRevision > 0) || !actor.edit;
        if (JSON.stringify(next) !== JSON.stringify(change) || (blocked && !entry.error))
          this.db.run("UPDATE bo_outbox SET data=?,error=COALESCE(?,error) WHERE scope=? AND id=?", [JSON.stringify(next), blocked ? "Access changed. Review the remaining authored fields before sending." : null, scope, change.id]);
        if (reduced) revoked = true;
      }
      for (const row of this.db.all("SELECT id,data FROM bo_views WHERE scope=?", [scope])) {
        const view = BackOfficeViewSchema.parse(JSON.parse(String(row.data)));
        const next = readableBackOfficeView(view, model, actor, readableIds);
        if (!next) {
          this.db.run("DELETE FROM bo_views WHERE scope=? AND id=?", [scope, String(row.id)]);
          revoked = true;
        } else if (canonicalBackOfficeAudit({ ...view, filterCriteria: view.filterCriteria ?? null }) !== canonicalBackOfficeAudit(next)) {
          this.db.run("UPDATE bo_views SET data=? WHERE scope=? AND id=?", [JSON.stringify(next), scope, String(row.id)]);
          revoked = true;
        }
      }
      if (revoked) this.retireCache(scope, actor);
    }, { action: "cache.permissions" });
    if (before) {
      const after = this.restrictionState(scope, actor);
      this.lastRestricted = after.version === before.version ? after : null;
    }
  }
  syncError(scope: string, message: string) {
    this.db.run("UPDATE bo_sync SET last_error=? WHERE scope=?", [
      message,
      scope,
    ]);
  }
  suspendTeam(scope: string, message: string) {
    this.transaction(() => {
      this.db.run("DELETE FROM native_directory_links WHERE stamp IS NULL AND account=(SELECT json_extract(data,'$.principalKey') FROM bo_replicas WHERE scope=?)",[scope]);
      const modelRow = this.db.get("SELECT data FROM bo_models WHERE scope=?", [scope]);
      if (!modelRow && !this.db.get("SELECT id FROM bo_records WHERE scope=? LIMIT 1", [scope]) && !this.db.get("SELECT id FROM bo_views WHERE scope=? LIMIT 1", [scope]) && !this.db.get("SELECT id FROM bo_files WHERE scope=? LIMIT 1", [scope]) && !this.syncState(scope).enabled) {
        this.syncError(scope, message);
        return;
      }
      const model = modelRow ? BackOfficeModelSchema.parse(JSON.parse(String(modelRow.data))) : null;
      for (const { change } of this.pending(scope, 0)) {
        if (change.kind !== "record") {
          this.db.run("DELETE FROM bo_outbox WHERE scope=? AND id=?", [scope, change.id]);
          continue;
        }
        const record = BackOfficeRecordSchema.parse(change.data);
        const object = model?.objects.find(object => object.id === record.objectId);
        const authored = new Set(change.changedFields ?? (change.baseRevision === 0 ? Object.keys(record.values) : []));
        const values = Object.fromEntries(Object.entries(record.values).filter(([id]) => {
          const field = object?.fields.find(field => field.id === id);
          return authored.has(id) && field?.visibility === "normal" && field.type !== "file" && field.type !== "relation" && !["feeAgreements", "billingItems", "invoices"].includes(record.objectId);
        }));
        this.db.run("UPDATE bo_outbox SET data=? WHERE scope=? AND id=?", [JSON.stringify({ ...change, changedFields: Object.keys(values), changedMetadata: [], data: { ...record, values, sourceId: undefined, members: [], access: "org" } }), scope, change.id]);
      }
      for (const table of ["bo_records", "bo_models", "bo_views"])
        this.db.run(`DELETE FROM ${table} WHERE scope=?`, [scope]);
      this.db.run("UPDATE bo_outbox SET error=? WHERE scope=?", [
        message,
        scope,
      ]);
      this.setSync(scope, false);
      this.syncError(scope, message);
      this.retireCache(scope);
    });
  }
  stagePublish(
    scope: string,
    actor: BackOfficeActor,
    source: BackOfficeRecord[],
  ) {
    this.requireAccount(scope, actor);
    const model = this.model(scope);
    const waiting = source.filter(
      (record) => record.objectId !== "projectLinks",
    );
    const ordered: BackOfficeRecord[] = [];
    const known = new Set(
      this.db
        .all("SELECT id FROM bo_records WHERE scope=?", [scope])
        .map((row) => String(row.id)),
    );
    while (waiting.length) {
      const index = waiting.findIndex((record) => {
        const object = model.objects.find(
          (object) => object.id === record.objectId,
        );
        return (
          object &&
          object.fields
            .filter((field) => field.type === "relation" && (field.required || field.id === "matter" && record.values.matter != null))
            .every((field) => {
              const value = record.values[field.id];
              return (Array.isArray(value) ? value : [value]).every(
                (id) => typeof id === "string" && known.has(id),
              );
            })
        );
      });
      if (index < 0)
        throw new ApiError(
          409,
          "back_office_publish",
          "Required relationships form a cycle or target an unpublished record. Make those relationships optional before publishing.",
        );
      const [record] = waiting.splice(index, 1);
      ordered.push(record);
      known.add(record.id);
    }
    for (const record of ordered) {
      if (this.raw(scope, record.id)) continue;
      const object = model.objects.find(
        (object) => object.id === record.objectId,
      );
      if (!object) continue;
      const values = Object.fromEntries(
        Object.entries(record.values).filter(([id]) => {
          const field = object.fields.find((field) => field.id === id);
          return (
            field &&
            (field.type !== "relation" || field.required || field.id === "matter") &&
            (field.visibility !== "finance" || actor.finance)
          );
        }),
      );
      const identity = {
        ...record,
        values,
        revision: 1,
        schemaRevision: model.revision,
        ownerId: actor.userId,
      };
      this.db.run("INSERT INTO bo_records VALUES(?,?,?,?)", [
        scope,
        identity.id,
        identity.objectId,
        JSON.stringify(identity),
      ]);
      this.enqueue(scope, actor, "record", 0, identity, Object.keys(values));
    }
    for (const record of source) {
      const object = model.objects.find(
        (object) => object.id === record.objectId,
      );
      if (!object) continue;
      const relations = Object.fromEntries(
        Object.entries(record.values).filter(
          ([id]) =>
            id !== "matter" && object.fields.find((field) => field.id === id)?.type === "relation",
        ),
      );
      if (record.objectId === "projectLinks") {
        if (this.raw(scope, record.id)) continue;
        const next = {
          ...record,
          revision: 1,
          schemaRevision: model.revision,
          ownerId: actor.userId,
        };
        this.db.run("INSERT INTO bo_records VALUES(?,?,?,?)", [
          scope,
          next.id,
          next.objectId,
          JSON.stringify(next),
        ]);
        this.enqueue(scope, actor, "record", 0, next, Object.keys(next.values));
      } else if (Object.keys(relations).length) {
        const existing = this.raw(scope, record.id);
        if (!existing) continue;
        const next = {
          ...existing,
          values: { ...existing.values, ...relations },
          revision: existing.revision + 1,
        };
        this.db.run("UPDATE bo_records SET data=? WHERE scope=? AND id=?", [
          JSON.stringify(next),
          scope,
          next.id,
        ]);
        this.enqueue(
          scope,
          actor,
          "record",
          existing.revision,
          next,
          Object.keys(relations),
        );
      }
    }
    this.audit(scope, actor, "directory.publish", "directory", {
      records: source.map((record) => record.id),
    });
  }
  holdFirstSyncConflict(scope: string, actor: BackOfficeActor, record: BackOfficeRecord, revision: number, fields: string[], metadata: NonNullable<BackOfficeChange["changedMetadata"]>) {
    this.requireAccount(scope, actor);
    const id = this.enqueue(scope, actor, "record", revision, { ...record, revision: revision + 1 }, fields, metadata);
    this.db.run("UPDATE bo_outbox SET error=? WHERE scope=? AND id=?", ["The local and firm copies changed. Review your changes.", scope, id!]);
  }
  queuedRecordIntent(scope: string, operationId: string, actor?: BackOfficeActor) {
    const pending = this.pending(scope, 0, actor),
      entry = pending.find((entry) => entry.change.id === operationId);
    if (!entry || entry.change.kind !== "record")
      throw new ApiError(
        404,
        "back_office_pending",
        "The queued record edit is unavailable.",
      );
    const id = BackOfficeRecordSchema.parse(entry.change.data).id;
    const related = pending.filter(
      (entry) =>
        entry.change.kind === "record" &&
        BackOfficeRecordSchema.parse(entry.change.data).id === id,
    );
    const last = BackOfficeRecordSchema.parse(
      related[related.length - 1].change.data,
    );
    const record: BackOfficeRecord = { ...last, values: {} };
    const values: BackOfficeRecord["values"] = {};
    for (const entry of related) {
      const proposed = BackOfficeRecordSchema.parse(entry.change.data);
      Object.assign(values, proposed.values);
      const metadata = entry.change.changedMetadata;
      if (!metadata || metadata.includes("sourceId")) record.sourceId = proposed.sourceId;
      if (!metadata || metadata.includes("sharing")) {
        record.access = proposed.access;
        record.members = proposed.members;
      }
      if (!metadata || metadata.includes("archive")) record.archivedAt = proposed.archivedAt;
    }
    record.values = values;
    const fields = [
      ...new Set(
        related.flatMap(
          (entry) =>
            entry.change.changedFields ??
            Object.keys(BackOfficeRecordSchema.parse(entry.change.data).values),
        ),
      ),
    ];
    const metadata = [...new Set(related.flatMap(entry => entry.change.changedMetadata ?? ["sourceId", "sharing", "archive"]))];
    return { record, fields, metadata };
  }
  discardQueued(scope: string, operationId: string, actor?: BackOfficeActor) {
    const entry = this.pending(scope, 0, actor).find(
      (entry) => entry.change.id === operationId,
    );
    if (!entry)
      throw new ApiError(
        404,
        "back_office_pending",
        "The queued change is unavailable.",
      );
    this.transaction(() => {
      if (actor) this.requireAccount(scope, actor);
      if (entry.change.kind === "record") {
        const id = BackOfficeRecordSchema.parse(entry.change.data).id;
        for (const row of this.db.all(
          "SELECT id,data FROM bo_outbox WHERE scope=?",
          [scope],
        )) {
          const change = BackOfficeChangeSchema.parse(
            JSON.parse(String(row.data)),
          );
          if (
            change.kind === "record" &&
            BackOfficeRecordSchema.parse(change.data).id === id && change.authorKey === entry.change.authorKey
          )
            this.db.run("DELETE FROM bo_outbox WHERE id=?", [String(row.id)]);
        }
        // A reviewed first-sync draft now follows the team copy; do not enqueue it again.
        this.db.run("UPDATE bo_first_sync SET operation=NULL,confirmed=1 WHERE id=? AND principal=? AND operation IS NOT NULL", [id, entry.change.authorKey ?? ""]);
        this.db.run("DELETE FROM bo_records WHERE scope=? AND id=?", [
          scope,
          id,
        ]);
      } else
        this.db.run("DELETE FROM bo_outbox WHERE scope=? AND id=?", [
          scope,
          operationId,
        ]);
    });
  }
  clearTeam(scope: string, actor?: BackOfficeActor) {
    this.transaction(() => {
      if (actor) this.requireIdentity(scope, actor);
      this.suspendTeam(scope, "The account disconnected. Reconnect as the author to review remaining drafts.");
      for (const table of [
        "bo_records",
        "bo_models",
        "bo_views",
        "bo_sync",
        "bo_replicas",
      ])
        this.db.run(`DELETE FROM ${table} WHERE scope=?`, [scope]);
      this.db.run("DELETE FROM bo_outbox WHERE scope=?" + (actor ? " AND json_extract(data,'$.authorKey')=?" : ""), actor ? [scope, backOfficeAuthorKey(actor)] : [scope]);
      this.journal.retire(scope);
    });
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      this.releaseAuditStorage();
    }
  }
}
const instances = new Map<string, Promise<BackOfficeStore>>();
export async function existingBackOfficeStore(config: ServerConfig): Promise<BackOfficeStore | null> {
  const path = runtimeDbPath(config);
  const instance = instances.get(path);
  if (instance) return instance;
  if (!existsSync(path)) return null;
  const db = await openSqlite(path);
  try {
    if (!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='bo_models'")) return null;
  } finally { db.close(); }
  return backOfficeStore(config);
}

export async function closeBackOfficeStoreForTests(config: ServerConfig) {
  const path = runtimeDbPath(config), instance = instances.get(path);
  if (instance) { (await instance).close(); instances.delete(path); }
}
export function backOfficeStore(
  config: ServerConfig,
): Promise<BackOfficeStore> {
  const path = runtimeDbPath(config);
  let instance = instances.get(path);
  if (!instance) {
    instance = (async () => {
      await ensureDir(dirname(path));
      const db = await openSqlite(path);
      let store: BackOfficeStore | null = null;
      try {
        const existing = Boolean(
          db.get(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='bo_journal_streams'",
          ) && db.get("SELECT stream_id FROM bo_journal_streams LIMIT 1"),
        );
        store = new BackOfficeStore(
          db,
          await openBackOfficeAuditStorage(
            join(dirname(path), "back-office-audit"),
            existing,
          ),
        );
        const { migrateLegacyFiles } = await import("./files.js");
        await migrateLegacyFiles(config, store);
        return store;
      } catch (error) {
        if (store) store.close(); else db.close();
        throw error;
      }
    })();
    instances.set(path, instance);
    void instance.catch(() => {
      if (instances.get(path) === instance) instances.delete(path);
    });
  }
  return instance;
}
