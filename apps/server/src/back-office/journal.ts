import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { z } from "zod";
import type { SqliteHandle } from "../runtime-db.js";
import {
  BACK_OFFICE_AUDIT_GENESIS,
  BackOfficeAuditActorSchema,
  BackOfficeAuditPayloadSchema,
  BackOfficeAuditProofSchema,
  canonicalBackOfficeAudit,
  type BackOfficeActor,
  type BackOfficeAuditActor,
  type BackOfficeAuditEntry,
  type BackOfficeAuditHead,
  type BackOfficeAuditPayload,
  type BackOfficeAuditProof,
} from "./schema.js";
import {
  backOfficeAuditEntityKey,
  backOfficeAuditStateHash,
  signBackOfficeAudit,
  verifyBackOfficeAuditEntry,
  verifyBackOfficeAuditProofChain,
} from "./audit-integrity.js";
import type { BackOfficeAuditStorage } from "./audit-storage.js";

const JsonSchema = z.json();
const PendingSchema = z.object({
  seq: z.number(),
  scope: z.string(),
  kind: z.enum(["record", "model", "view", "proposal"]),
  target: z.string(),
  before_data: z.string().nullable(),
  after_data: z.string().nullable(),
  actor: z.string(),
  action: z.string(),
  model_revision: z.number(),
});
const StreamSchema = z.object({
  stream_id: z.string().uuid(),
  scope: z.string(),
  public_key: z.string(),
  created_at: z.string(),
});
const RowSchema = z.object({
  stream_id: z.string(),
  sequence: z.number(),
  event_id: z.string(),
  proof: z.string(),
  sealed: z.string(),
});

export const BACK_OFFICE_JOURNAL_TABLES = `
CREATE TABLE IF NOT EXISTS bo_journal_context (id INTEGER PRIMARY KEY CHECK(id=1), actor TEXT NOT NULL, action TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bo_journal_pending (seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, before_data TEXT, after_data TEXT, actor TEXT NOT NULL, action TEXT NOT NULL, model_revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bo_journal_streams (stream_id TEXT PRIMARY KEY, scope TEXT NOT NULL, public_key TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bo_journal_active (scope TEXT PRIMARY KEY, stream_id TEXT NOT NULL REFERENCES bo_journal_streams(stream_id));
CREATE TABLE IF NOT EXISTS bo_journal_entries (stream_id TEXT NOT NULL REFERENCES bo_journal_streams(stream_id), sequence INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE, proof TEXT NOT NULL, sealed TEXT NOT NULL, PRIMARY KEY(stream_id,sequence));
CREATE TRIGGER IF NOT EXISTS bo_journal_entries_no_update BEFORE UPDATE ON bo_journal_entries BEGIN SELECT RAISE(ABORT,'Back Office audit history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS bo_journal_entries_no_delete BEFORE DELETE ON bo_journal_entries BEGIN SELECT RAISE(ABORT,'Back Office audit history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS bo_journal_streams_no_update BEFORE UPDATE ON bo_journal_streams BEGIN SELECT RAISE(ABORT,'Back Office audit identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS bo_journal_streams_no_delete BEFORE DELETE ON bo_journal_streams BEGIN SELECT RAISE(ABORT,'Back Office audit identity is immutable'); END;
`;
const legacyGuards = `
CREATE TRIGGER IF NOT EXISTS bo_journal_legacy_no_insert BEFORE INSERT ON bo_audit BEGIN SELECT RAISE(ABORT,'Legacy Back Office audit history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS bo_journal_legacy_no_update BEFORE UPDATE ON bo_audit BEGIN SELECT RAISE(ABORT,'Legacy Back Office audit history is immutable'); END;
CREATE TRIGGER IF NOT EXISTS bo_journal_legacy_no_delete BEFORE DELETE ON bo_audit BEGIN SELECT RAISE(ABORT,'Legacy Back Office audit history is immutable'); END;
`;
const auditedTables = [
  { table: "bo_models", kind: "model", target: "'model'" },
  { table: "bo_records", kind: "record", target: "id" },
  { table: "bo_views", kind: "view", target: "id" },
  { table: "bo_outbox", kind: "proposal", target: "id" },
] satisfies { table: string; kind: Pending["kind"]; target: string }[];
type Pending = z.infer<typeof PendingSchema>;
type Json = z.infer<typeof JsonSchema>;

function parseJson(value: string | null): Json {
  return value === null ? null : JsonSchema.parse(JSON.parse(value));
}
function seal(payload: BackOfficeAuditPayload, key: Buffer) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const bytes = Buffer.concat([
    cipher.update(canonicalBackOfficeAudit(payload), "utf8"),
    cipher.final(),
  ]);
  return JSON.stringify({
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: bytes.toString("base64"),
  });
}
function unseal(value: string, key: Buffer) {
  const envelope = z
    .object({ nonce: z.string(), tag: z.string(), data: z.string() })
    .strict()
    .parse(JSON.parse(value));
  const cipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(envelope.nonce, "base64"),
  );
  cipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return BackOfficeAuditPayloadSchema.parse(
    JSON.parse(
      Buffer.concat([
        cipher.update(Buffer.from(envelope.data, "base64")),
        cipher.final(),
      ]).toString("utf8"),
    ),
  );
}

export class BackOfficeJournal {
  private changed = new Set<string>();
  private eraseAfterCommit = new Set<string>();
  private retireAfterFlush = new Set<string>();
  private failure: Error | null = null;
  private readonly expectedTriggers = new Map<string, string>();
  private prospectiveHeads = new Map<string, BackOfficeAuditHead>();
  private admittedKeys = new Map<string, string | null>();
  private admittedHeads = new Map<string, BackOfficeAuditHead>();
  private preparedStamp: string | null = null;
  private verifiedCache: {
    stamp: string;
    heads: string;
    keys: string;
    streams: number;
  } | null = null;
  private established = false;
  constructor(
    private readonly db: SqliteHandle,
    readonly storage: BackOfficeAuditStorage,
  ) {
    const statements = [BACK_OFFICE_JOURNAL_TABLES, legacyGuards];
    for (const { table, kind, target } of auditedTables) {
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        const old = operation === "INSERT" ? "NULL" : "OLD.data";
        const next = operation === "DELETE" ? "NULL" : "NEW.data";
        const side = operation === "DELETE" ? "OLD" : "NEW";
        const id = target === "id" ? `${side}.id` : target;
        const when =
          operation === "UPDATE" ? "WHEN OLD.data IS NOT NEW.data" : "";
        statements.push(`CREATE TRIGGER IF NOT EXISTS ${table}_journal_guard_${operation} BEFORE ${operation} ON ${table} ${when}
          BEGIN SELECT RAISE(ABORT,'Back Office changes require an audited transaction') WHERE NOT EXISTS(SELECT 1 FROM bo_journal_context WHERE id=1); END;
          CREATE TRIGGER IF NOT EXISTS ${table}_journal_capture_${operation} AFTER ${operation} ON ${table} ${when}
          BEGIN INSERT INTO bo_journal_pending(scope,kind,target,before_data,after_data,actor,action,model_revision)
            SELECT ${side}.scope,'${kind}',${id},${old},${next},actor,action,COALESCE((SELECT json_extract(data,'$.revision') FROM bo_models WHERE scope=${side}.scope),0) FROM bo_journal_context WHERE id=1; END;`);
      }
    }
    for (const statement of statements) {
      for (const match of statement.matchAll(
        /CREATE TRIGGER IF NOT EXISTS (\w+)[\s\S]*?END;/g,
      ))
        this.expectedTriggers.set(match[1], this.normalizeTrigger(match[0]));
    }
    const initialized = Boolean(
      db.get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='bo_journal_entries'",
      ),
    );
    this.established = initialized;
    if (
      initialized &&
      !db.get("SELECT version FROM bo_migrations WHERE version=2")
    )
      throw new Error(
        "Back Office audit migration evidence is missing. Preserve this database before recovery.",
      );
    if (initialized) this.validateGuards();
    db.exec(BACK_OFFICE_JOURNAL_TABLES);
    for (const statement of statements.slice(2)) db.exec(statement);
    if (initialized) db.exec(legacyGuards);
  }
  private normalizeTrigger(sql: string) {
    return sql
      .replace(/IF NOT EXISTS /gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/;$/, "");
  }
  private validateGuards() {
    const initialized = this.established;
    if (
      initialized &&
      !this.db.get("SELECT version FROM bo_migrations WHERE version=2")
    )
      throw new Error(
        "Back Office audit migration evidence is missing. Preserve this database before recovery.",
      );
    const rows = this.db.all(
      "SELECT name,sql,tbl_name FROM sqlite_master WHERE type='trigger' AND tbl_name LIKE 'bo_%'",
    );
    const found = new Map(
      rows.map((row) => [
        String(row.name),
        this.normalizeTrigger(String(row.sql)),
      ]),
    );
    for (const [name, sql] of this.expectedTriggers) {
      if (!initialized && name.startsWith("bo_journal_legacy_")) continue;
      if (found.get(name) !== sql)
        throw new Error(
          "Back Office audit security triggers were changed or removed. Further changes are blocked.",
        );
    }
    for (const name of found.keys())
      if (!this.expectedTriggers.has(name))
        throw new Error(
          "Unexpected Back Office audit security trigger. Further changes are blocked.",
        );
  }
  private stamp() {
    return canonicalBackOfficeAudit({
      data: Number(this.db.get("PRAGMA data_version")?.data_version),
      schema: Number(this.db.get("PRAGMA schema_version")?.schema_version),
      changes: Number(this.db.get("SELECT total_changes() AS value")?.value),
    });
  }
  private keyHashes() {
    return new Map(
      this.streams().map((stream) => {
        const key = this.storage.key(stream.stream_id);
        return [
          stream.stream_id,
          key ? backOfficeAuditStateHash(key.toString("hex")) : null,
        ];
      }),
    );
  }
  verify(force = false) {
    const stamp = this.stamp();
    const heads = canonicalBackOfficeAudit(
      this.storage.heads().sort((a, b) => a.streamId.localeCompare(b.streamId)),
    );
    const keyHashes = this.keyHashes();
    const keys = canonicalBackOfficeAudit(Object.fromEntries(keyHashes));
    if (
      !force &&
      this.verifiedCache?.stamp === stamp &&
      this.verifiedCache.heads === heads &&
      this.verifiedCache.keys === keys
    )
      return { streams: this.verifiedCache.streams, locallyVerified: true };
    this.validateGuards();
    const result = this.verifyFull();
    this.admittedKeys = keyHashes;
    this.admittedHeads = new Map(
      this.storage.heads().map((head) => [head.streamId, head]),
    );
    this.verifiedCache = { stamp, heads, keys, streams: result.streams };
    return result;
  }

  systemActor(migration = false): BackOfficeAuditActor {
    return {
      id: migration ? "migration" : "legalwork",
      name: migration ? "Existing data baseline" : "LegalWork",
      kind: "system",
      identitySource: migration ? "migration" : "operating-system",
      deviceId: this.storage.identity.deviceId,
      agentId: null,
    };
  }
  actor(actor: BackOfficeActor): BackOfficeAuditActor {
    const identity = this.storage.identity;
    return {
      id: actor.userId === "local" ? identity.userId : actor.userId,
      name: actor.userId === "local" ? identity.userName : null,
      kind: actor.agentId ? "agent" : "user",
      identitySource:
        actor.userId === "local" ? "operating-system" : "account-cache",
      deviceId: identity.deviceId,
      agentId: actor.agentId ?? null,
    };
  }
  begin(action = "system.transaction") {
    if (this.failure) throw this.failure;
    this.verify();
    if (this.db.get("SELECT seq FROM bo_journal_pending LIMIT 1"))
      throw new Error(
        "Back Office has unaudited database changes. Preserve this database and recover its verified history.",
      );
    this.db.run("INSERT INTO bo_journal_context VALUES(1,?,?)", [
      JSON.stringify(this.systemActor()),
      action,
    ]);
  }
  attribute(scope: string, actor: BackOfficeActor, action: string, id: string) {
    this.db.run(
      `UPDATE bo_journal_pending SET actor=?,action=? WHERE scope=?${id === "directory" ? "" : " AND target=?"}`,
      id === "directory"
        ? [JSON.stringify(this.actor(actor)), action, scope]
        : [JSON.stringify(this.actor(actor)), action, scope, id],
    );
  }

  context(actor: BackOfficeActor | undefined, action: string) {
    this.db.run("UPDATE bo_journal_context SET actor=?,action=? WHERE id=1", [
      JSON.stringify(actor ? this.actor(actor) : this.systemActor()),
      action,
    ]);
  }
  currentContext() {
    return z
      .object({ actor: z.string(), action: z.string() })
      .parse(
        this.db.get("SELECT actor,action FROM bo_journal_context WHERE id=1"),
      );
  }
  restoreContext(context: { actor: string; action: string }) {
    this.db.run("UPDATE bo_journal_context SET actor=?,action=? WHERE id=1", [
      context.actor,
      context.action,
    ]);
  }
  private streams() {
    return this.db
      .all("SELECT * FROM bo_journal_streams ORDER BY rowid")
      .map((row) => StreamSchema.parse(row));
  }
  private rows(id: string) {
    return this.db
      .all(
        "SELECT * FROM bo_journal_entries WHERE stream_id=? ORDER BY sequence",
        [id],
      )
      .map((row) => RowSchema.parse(row));
  }
  private root(
    stream: ReturnType<BackOfficeJournal["streams"]>[number],
  ): BackOfficeAuditHead {
    return {
      streamId: stream.stream_id,
      publicKey: stream.public_key,
      sequence: 0,
      hash: BACK_OFFICE_AUDIT_GENESIS,
    };
  }
  private current(scope: string): Record<string, Json> {
    const result: Record<string, Json> = {};
    for (const { table, kind, target } of auditedTables) {
      for (const row of this.db.all(
        `SELECT ${target} AS target,data FROM ${table} WHERE scope=?`,
        [scope],
      ))
        result[`${kind}:${String(row.target)}`] = parseJson(String(row.data));
    }
    return result;
  }
  private expected(stream: ReturnType<BackOfficeJournal["streams"]>[number]) {
    const result: Record<string, string> = {};
    const empty = backOfficeAuditStateHash(null);
    for (const row of this.rows(stream.stream_id)) {
      const proof = BackOfficeAuditProofSchema.parse(JSON.parse(row.proof));
      if (!["record", "model", "view", "proposal"].includes(proof.entityType))
        continue;
      if (proof.beforeHash !== (result[proof.entityKey] ?? empty))
        throw new Error(
          "Back Office history contains an inconsistent state transition.",
        );
      if (proof.afterHash === empty) delete result[proof.entityKey];
      else result[proof.entityKey] = proof.afterHash;
    }
    return result;
  }
  private currentHashes(scope: string) {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.current(scope))) {
      const colon = key.indexOf(":");
      const kind = PendingSchema.shape.kind.parse(key.slice(0, colon));
      result[backOfficeAuditEntityKey(scope, kind, key.slice(colon + 1))] =
        backOfficeAuditStateHash(value);
    }
    return result;
  }

  private verifyFull() {
    const streams = this.streams();
    for (const head of this.storage.heads()) {
      if (!streams.some((stream) => stream.stream_id === head.streamId))
        throw new Error(
          "Back Office history is missing a previously checkpointed stream.",
        );
    }
    const latest = new Map(
      streams.map((stream) => [stream.scope, stream.stream_id]),
    );
    for (const stream of streams) {
      if (stream.public_key !== this.storage.identity.publicKey)
        throw new Error(
          "Back Office audit identity differs from its retained signing key.",
        );
      const rows = this.rows(stream.stream_id);
      const checkpoint = this.storage.head(stream.stream_id);
      if (
        !checkpoint &&
        rows.length &&
        this.storage.persistent &&
        !this.changed.has(stream.stream_id)
      )
        throw new Error(
          "Back Office audit checkpoint is missing. History cannot be reset automatically.",
        );
      const head = verifyBackOfficeAuditProofChain(
        rows.map((row) => JSON.parse(row.proof)),
        checkpoint ?? this.root(stream),
      );
      const active = this.db.get(
        "SELECT scope FROM bo_journal_active WHERE stream_id=?",
        [stream.stream_id],
      );
      const key = this.storage.key(stream.stream_id);
      if (active && !key)
        throw new Error(
          "Back Office history encryption key is missing. Further changes are blocked.",
        );
      if (key) {
        const entries = this.entries(stream.stream_id);
        if (!active) {
          if (entries.at(-1)?.payload.action !== "cache.revoke")
            throw new Error(
              "Back Office history was disconnected without a recorded access revocation.",
            );
          this.eraseAfterCommit.add(stream.stream_id);
        }
      }
      if (
        latest.get(stream.scope) === stream.stream_id &&
        canonicalBackOfficeAudit(this.expected(stream)) !==
          canonicalBackOfficeAudit(this.currentHashes(stream.scope))
      )
        throw new Error(
          "Back Office database contents differ from their recorded history. Further changes are blocked.",
        );
      if (checkpoint && head.sequence > checkpoint.sequence) {
        this.changed.add(stream.stream_id);
        this.prospectiveHeads.set(stream.stream_id, head);
      }
    }
    return { streams: streams.length, locallyVerified: true };
  }

  entries(streamId: string): BackOfficeAuditEntry[] {
    const key = this.storage.key(streamId);
    if (!key) return [];
    return this.rows(streamId).map((row) =>
      verifyBackOfficeAuditEntry({
        payload: unseal(row.sealed, key),
        proof: JSON.parse(row.proof),
      }),
    );
  }
  history(scope: string, id: string) {
    const entries = this.streams()
      .filter((stream) => stream.scope === scope)
      .flatMap((stream) => this.entries(stream.stream_id));
    const current = entries
      .filter((entry) => entry.payload.entityId === id)
      .reverse()
      .map(({ payload, proof }) => ({
        actor: payload.actor.id,
        actorDetails: payload.actor,
        action: payload.action,
        created_at: payload.recordedAt,
        sequence: proof.sequence,
        streamId: proof.streamId,
        hash: proof.hash,
        modelRevision: payload.modelRevision,
      }));
    const legacy = entries
      .filter((entry) => entry.payload.action === "directory.baseline")
      .flatMap((entry) => {
        const baseline = z
          .object({
            legacy: z.array(
              z
                .object({
                  record_id: z.string(),
                  actor: z.string(),
                  action: z.string(),
                  created_at: z.string(),
                })
                .passthrough(),
            ),
          })
          .passthrough()
          .parse(entry.payload.after);
        return baseline.legacy
          .filter((row) => row.record_id === id)
          .map((row) => ({
            actor: row.actor,
            action: row.action,
            created_at: row.created_at,
            legacy: true,
            capturedAt: entry.payload.recordedAt,
          }));
      });
    return [...current, ...legacy];
  }

  private append(
    stream: ReturnType<BackOfficeJournal["streams"]>[number],
    input: Omit<
      BackOfficeAuditPayload,
      "version" | "streamId" | "sequence" | "eventId" | "recordedAt"
    >,
  ) {
    const last = this.db.get(
      "SELECT sequence,proof FROM bo_journal_entries WHERE stream_id=? ORDER BY sequence DESC LIMIT 1",
      [stream.stream_id],
    );
    const previous = last
      ? BackOfficeAuditProofSchema.parse(JSON.parse(String(last.proof)))
      : null;
    const key = this.storage.key(stream.stream_id);
    if (
      !key ||
      this.admittedKeys.get(stream.stream_id) !==
        backOfficeAuditStateHash(key.toString("hex"))
    )
      throw new Error(
        "Back Office history encryption key changed outside its audited lifecycle.",
      );
    const entry = signBackOfficeAudit(
      {
        ...input,
        version: 1,
        streamId: stream.stream_id,
        sequence: (previous?.sequence ?? 0) + 1,
        eventId: randomUUID(),
        recordedAt: new Date().toISOString(),
      },
      previous?.hash ?? BACK_OFFICE_AUDIT_GENESIS,
      this.storage.identity,
    );
    this.db.run("INSERT INTO bo_journal_entries VALUES(?,?,?,?,?)", [
      stream.stream_id,
      entry.proof.sequence,
      entry.payload.eventId,
      JSON.stringify(entry.proof),
      seal(entry.payload, key),
    ]);
    this.changed.add(stream.stream_id);
    this.prospectiveHeads.set(stream.stream_id, {
      streamId: stream.stream_id,
      publicKey: entry.proof.publicKey,
      sequence: entry.proof.sequence,
      hash: entry.proof.hash,
    });
    return entry;
  }

  private stream(scope: string, pending: Pending[]) {
    const active = this.db.get(
      "SELECT s.* FROM bo_journal_streams s JOIN bo_journal_active a ON a.stream_id=s.stream_id WHERE a.scope=?",
      [scope],
    );
    if (active) return StreamSchema.parse(active);
    const stream = {
      stream_id: randomUUID(),
      scope,
      public_key: this.storage.identity.publicKey,
      created_at: new Date().toISOString(),
    };
    const key = this.storage.createKey(stream.stream_id);
    this.admittedKeys.set(
      stream.stream_id,
      backOfficeAuditStateHash(key.toString("hex")),
    );
    this.db.run("INSERT INTO bo_journal_streams VALUES(?,?,?,?)", [
      stream.stream_id,
      scope,
      stream.public_key,
      stream.created_at,
    ]);
    this.db.run("INSERT INTO bo_journal_active VALUES(?,?)", [
      scope,
      stream.stream_id,
    ]);
    const state = this.current(scope);
    for (const change of [...pending].reverse()) {
      if (change.scope !== scope) continue;
      const id = `${change.kind}:${change.target}`;
      if (change.before_data === null) delete state[id];
      else state[id] = parseJson(change.before_data);
    }
    const legacy = this.db
      .all("SELECT * FROM bo_audit WHERE scope=? ORDER BY seq", [scope])
      .map((row) => JsonSchema.parse(JSON.parse(JSON.stringify(row))));
    this.append(stream, {
      scope,
      actor: this.systemActor(true),
      action: "directory.baseline",
      entityType: "directory",
      entityId: "baseline",
      modelRevision: 0,
      before: null,
      after: { legacy, guaranteeStartsAt: stream.created_at },
    });
    for (const [id, value] of Object.entries(state)) {
      const colon = id.indexOf(":");
      const kind = PendingSchema.shape.kind.parse(id.slice(0, colon));
      this.append(stream, {
        scope,
        actor: this.systemActor(true),
        action: `baseline.${kind}`,
        entityType: kind,
        entityId: id.slice(colon + 1),
        modelRevision: 0,
        before: null,
        after: value,
      });
    }
    return stream;
  }

  initialize() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.begin("audit.initialize");
      for (const row of this.db.all(
        "SELECT scope FROM bo_models UNION SELECT scope FROM bo_records UNION SELECT scope FROM bo_views UNION SELECT scope FROM bo_outbox UNION SELECT scope FROM bo_audit",
      )) {
        const scope = String(row.scope);
        if (
          !this.db.get(
            "SELECT stream_id FROM bo_journal_streams WHERE scope=?",
            [scope],
          )
        )
          this.stream(scope, []);
      }
      if (
        !this.db.get(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND name='bo_journal_legacy_no_delete'",
        )
      ) {
        this.db.run("DELETE FROM bo_audit");
        this.db.exec(legacyGuards);
      }
      this.db.run(
        "INSERT OR IGNORE INTO bo_migrations VALUES(2,datetime('now'))",
      );
      this.established = true;
      this.db.run("DELETE FROM bo_journal_context");
      this.preparedStamp = this.stamp();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.rollback();
      throw error;
    }
    this.checkpoint();
  }

  flush() {
    this.validateGuards();
    const pending = this.db
      .all("SELECT * FROM bo_journal_pending ORDER BY seq")
      .map((row) => PendingSchema.parse(row));
    for (const change of pending) {
      const stream = this.stream(change.scope, pending);
      const revision = change.model_revision;
      this.append(stream, {
        scope: change.scope,
        actor: BackOfficeAuditActorSchema.parse(JSON.parse(change.actor)),
        action:
          change.action === "system.transaction"
            ? `${change.kind}.${change.before_data === null ? "create" : change.after_data === null ? "remove" : "update"}`
            : change.action,
        entityType: change.kind,
        entityId: change.target,
        modelRevision: revision,
        before: parseJson(change.before_data),
        after: parseJson(change.after_data),
      });
    }
    for (const scope of this.retireAfterFlush) this.retireNow(scope);
    this.retireAfterFlush.clear();
    this.db.run("DELETE FROM bo_journal_pending");
    this.db.run("DELETE FROM bo_journal_context");
    if (this.db.get("SELECT seq FROM bo_journal_pending LIMIT 1"))
      throw new Error(
        "Back Office has changes outside its completed audit batch.",
      );
    this.preparedStamp = this.stamp();
  }

  retire(scope: string) {
    this.retireAfterFlush.add(scope);
  }
  private retireNow(scope: string) {
    const active = this.db.get(
      "SELECT s.* FROM bo_journal_streams s JOIN bo_journal_active a ON a.stream_id=s.stream_id WHERE a.scope=?",
      [scope],
    );
    if (!active) return;
    const stream = StreamSchema.parse(active);
    this.append(stream, {
      scope,
      actor: this.systemActor(),
      action: "cache.revoke",
      entityType: "directory",
      entityId: "cache",
      modelRevision: 0,
      before: null,
      after: { contentAccessRemoved: true },
    });
    this.db.run("DELETE FROM bo_journal_active WHERE scope=?", [scope]);
    this.eraseAfterCommit.add(stream.stream_id);
  }
  checkpoint() {
    try {
      const expectedHeads = new Map(this.admittedHeads);
      for (const [id, head] of this.prospectiveHeads)
        expectedHeads.set(id, head);
      for (const head of this.prospectiveHeads.values())
        this.storage.checkpoint(head);
      const heads = this.storage
        .heads()
        .sort((a, b) => a.streamId.localeCompare(b.streamId));
      if (
        canonicalBackOfficeAudit(heads) !==
        canonicalBackOfficeAudit(
          [...expectedHeads.values()].sort((a, b) =>
            a.streamId.localeCompare(b.streamId),
          ),
        )
      )
        throw new Error(
          "Back Office audit checkpoints changed during persistence.",
        );
      for (const id of this.eraseAfterCommit) {
        this.storage.eraseKey(id);
        this.admittedKeys.set(id, null);
      }
      const keys = this.keyHashes();
      if (
        canonicalBackOfficeAudit(Object.fromEntries(keys)) !==
        canonicalBackOfficeAudit(Object.fromEntries(this.admittedKeys))
      )
        throw new Error(
          "Back Office history encryption keys changed during checkpoint persistence.",
        );
      if (this.preparedStamp !== this.stamp()) {
        this.db.exec("BEGIN");
        try {
          this.verify(true);
          this.db.exec("COMMIT");
        } catch (error) {
          this.db.exec("ROLLBACK");
          throw error;
        }
      } else {
        this.verifiedCache = {
          stamp: this.preparedStamp,
          heads: canonicalBackOfficeAudit(heads),
          keys: canonicalBackOfficeAudit(Object.fromEntries(keys)),
          streams: this.streams().length,
        };
      }
      this.admittedHeads = expectedHeads;
      this.changed.clear();
      this.prospectiveHeads.clear();
      this.eraseAfterCommit.clear();
      this.preparedStamp = null;
      this.failure = null;
    } catch (error) {
      this.verifiedCache = null;
      this.failure =
        error instanceof Error
          ? error
          : new Error("The Back Office audit checkpoint could not be secured.");
      throw this.failure;
    }
  }

  rollback() {
    this.verifiedCache = null;
    this.preparedStamp = null;
    this.prospectiveHeads.clear();
    this.changed.clear();
    this.eraseAfterCommit.clear();
    this.retireAfterFlush.clear();
  }
  savepoint() {
    return new Set(this.retireAfterFlush);
  }
  rollbackTo(retirements: Set<string>) {
    this.retireAfterFlush = retirements;
  }
}
