import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { openSqlite, runtimeDbPath, type SqliteHandle } from "../runtime-db.js";
import { ensureDir } from "../utils.js";
import type { ServerConfig } from "../types.js";
import {
  BackOfficeChangeSchema,
  BackOfficeModelSchema,
  BackOfficeRecordSchema,
  BackOfficeValueSchema,
  BackOfficeViewSchema,
  assertModelChange,
  defaultBackOfficeModel,
  readableBackOfficeRecord,
  validateBackOfficeValues,
  validateBackOfficeView,
  visibleBackOfficeRecord,
  upgradeBackOfficeModel,
  type BackOfficeActor,
  type BackOfficeChange,
  type BackOfficeModel,
  type BackOfficeRecord,
  type BackOfficeSnapshot,
  type BackOfficeView,
} from "./schema.js";

const table = `
CREATE TABLE IF NOT EXISTS bo_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bo_models (scope TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bo_records (scope TEXT NOT NULL, id TEXT NOT NULL, object_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope,id));
CREATE INDEX IF NOT EXISTS bo_records_object ON bo_records(scope,object_id);
CREATE TABLE IF NOT EXISTS bo_views (scope TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(scope,id));
CREATE TABLE IF NOT EXISTS bo_outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, error TEXT);
CREATE TABLE IF NOT EXISTS bo_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, record_id TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bo_sync (scope TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 0, last_error TEXT);
INSERT OR IGNORE INTO bo_migrations VALUES(1,datetime('now'));`;
const inputRecord = z.object({
  id: z.string().uuid().optional(),
  objectId: z.string(),
  revision: z.number().int().nonnegative(),
  values: z.record(z.string(), z.unknown()),
  sourceId: z.string().max(16000).nullable().optional(),
  archived: z.boolean().optional(),
  access: z.enum(["org", "members"]).optional(),
  members: z.array(z.string()).max(500).optional(),
});
function conflict(
  message = "This record changed. Refresh it before saving.",
): never {
  throw new ApiError(409, "back_office_conflict", message);
}

export class BackOfficeStore {
  private transactionDepth = 0;
  constructor(readonly db: SqliteHandle) {
    db.exec("PRAGMA busy_timeout=5000");
    db.exec(table);
  }
  model(scope: string): BackOfficeModel {
    const row = this.db.get("SELECT data FROM bo_models WHERE scope=?", [
      scope,
    ]);
    if (typeof row?.data === "string") {
      const current = BackOfficeModelSchema.parse(JSON.parse(row.data));
      const upgraded =
        scope === "local" ? upgradeBackOfficeModel(current) : current;
      if (upgraded !== current)
        this.db.run("UPDATE bo_models SET data=? WHERE scope=?", [
          JSON.stringify(upgraded),
          scope,
        ]);
      return upgraded;
    }
    const model = defaultBackOfficeModel();
    this.db.run("INSERT OR IGNORE INTO bo_models VALUES(?,?)", [
      scope,
      JSON.stringify(model),
    ]);
    return model;
  }
  transaction<T>(fn: () => T): T {
    const level = this.transactionDepth++;
    const savepoint = `bo_save_${level}`;
    this.db.exec(level ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec(level ? `RELEASE ${savepoint}` : "COMMIT");
      return value;
    } catch (error) {
      this.db.exec(level ? `ROLLBACK TO ${savepoint}` : "ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }
  audit(
    scope: string,
    actor: BackOfficeActor,
    action: string,
    id: string,
    data: unknown,
  ) {
    this.db.run(
      "INSERT INTO bo_audit(scope,actor,action,record_id,data,created_at) VALUES(?,?,?,?,?,?)",
      [
        scope,
        actor.userId + (actor.agentId ? "/agent:" + actor.agentId : ""),
        action,
        id,
        JSON.stringify(data),
        new Date().toISOString(),
      ],
    );
  }
  enqueue(
    scope: string,
    kind: BackOfficeChange["kind"],
    revision: number,
    data: unknown,
    changedFields?: string[],
  ) {
    if (scope === "local") return;
    const change: BackOfficeChange = {
      id: randomUUID(),
      kind,
      baseRevision: revision,
      schemaRevision: this.model(scope).revision,
      data,
      changedFields,
    };
    this.db.run("INSERT INTO bo_outbox(scope,id,data) VALUES(?,?,?)", [
      scope,
      change.id,
      JSON.stringify(change),
    ]);
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
    return this.transaction(() => {
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
      if (parsed.id && !existing)
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
      if ((existing?.revision ?? 0) !== parsed.revision) conflict();
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
      const values = { ...existing?.values };
      for (const [id, raw] of Object.entries(parsed.values)) {
        const field = object.fields.find((field) => field.id === id);
        if (!field)
          throw new ApiError(400, "back_office_field", `Unknown field ${id}.`);
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
        const value = BackOfficeValueSchema.parse(raw);
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
        id: existing?.id ?? randomUUID(),
        objectId: object.id,
        values,
        sourceId: parsed.sourceId === undefined ? existing?.sourceId : parsed.sourceId,
        revision: parsed.revision + 1,
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
      this.audit(
        scope,
        actor,
        existing ? "record.update" : "record.create",
        record.id,
        { before: existing, after: record },
      );
      this.enqueue(
        scope,
        "record",
        parsed.revision,
        record,
        Object.keys(parsed.values),
      );
      return readableBackOfficeRecord(record, object, actor);
    });
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
      conflict("The data model changed. Refresh before reviewing changes.");
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
    return this.transaction(() => {
      const current = this.model(scope);
      if (current.revision !== baseRevision)
        conflict(
          "The data model changed. Refresh before applying your changes.",
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
      this.enqueue(scope, "model", current.revision, next);
      return next;
    });
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
    const view = BackOfficeViewSchema.parse({
      ...this.views(scope).find((view) => view.id === patch.id),
      ...patch,
    });
    try {
      validateBackOfficeView(this.model(scope), view);
    } catch (error) {
      throw new ApiError(
        400,
        "back_office_view",
        error instanceof Error ? error.message : "Check the view settings.",
      );
    }
    this.transaction(() => {
      this.db.run(
        "INSERT INTO bo_views VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET data=excluded.data",
        [scope, view.id, JSON.stringify(view)],
      );
      this.enqueue(scope, "view", 0, view);
      this.audit(scope, actor, "view.save", view.id, view);
    });
    return view;
  }
  history(scope: string, actor: BackOfficeActor, id: string) {
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
    return this.db.all(
      "SELECT actor,action,created_at FROM bo_audit WHERE scope=? AND record_id=? ORDER BY seq DESC LIMIT 100",
      [scope, id],
    );
  }
  pending(scope: string, limit = 100) {
    return this.db
      .all(
        "SELECT seq,data,error FROM bo_outbox WHERE scope=? ORDER BY seq" +
          (limit ? ` LIMIT ${limit}` : ""),
        [scope],
      )
      .map((row) => ({
        seq: Number(row.seq),
        change: BackOfficeChangeSchema.parse(JSON.parse(String(row.data))),
        error: row.error,
      }));
  }
  syncState(scope: string) {
    const row = this.db.get("SELECT * FROM bo_sync WHERE scope=?", [scope]);
    const blocked = this.pending(scope).find((entry) => entry.error);
    return {
      enabled: Boolean(row?.enabled),
      cursor: Number(row?.cursor ?? 0),
      error: blocked
        ? String(blocked.error)
        : typeof row?.last_error === "string"
          ? row.last_error
          : null,
      pending: Number(
        this.db.get("SELECT count(*) AS count FROM bo_outbox WHERE scope=?", [
          scope,
        ])?.count ?? 0,
      ),
    };
  }
  setSync(scope: string, enabled: boolean) {
    this.db.run(
      "INSERT INTO bo_sync(scope,enabled) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET enabled=excluded.enabled",
      [scope, enabled ? 1 : 0],
    );
  }
  receive(scope: string, snapshot: BackOfficeSnapshot) {
    this.transaction(() => {
      for (const id of snapshot.accepted)
        this.db.run("DELETE FROM bo_outbox WHERE scope=? AND id=?", [
          scope,
          id,
        ]);
      for (const conflict of snapshot.conflicts)
        this.db.run("UPDATE bo_outbox SET error=? WHERE scope=? AND id=?", [
          conflict.message,
          scope,
          conflict.id,
        ]);
      const pending = this.db
        .all("SELECT data,error FROM bo_outbox WHERE scope=? ORDER BY seq", [
          scope,
        ])
        .map((row) => ({
          change: BackOfficeChangeSchema.parse(JSON.parse(String(row.data))),
          error: row.error,
        }));
      if (!pending.some((entry) => entry.change.kind === "model"))
        this.db.run(
          "INSERT INTO bo_models VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET data=excluded.data",
          [scope, JSON.stringify(snapshot.model)],
        );
      const pendingRecords = new Set(
        pending.flatMap((entry) =>
          entry.change.kind === "record"
            ? [BackOfficeRecordSchema.parse(entry.change.data).id]
            : [],
        ),
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
      const incoming = new Set(snapshot.records.map((record) => record.id));
      for (const row of this.db.all("SELECT id FROM bo_records WHERE scope=?", [
        scope,
      ])) {
        // A removed or no-longer-readable record leaves the managed replica, even with a queued draft.
        if (!incoming.has(String(row.id)) && !newDrafts.has(String(row.id)))
          this.db.run("DELETE FROM bo_records WHERE scope=? AND id=?", [
            scope,
            String(row.id),
          ]);
      }
      for (const record of snapshot.records) {
        if (pendingRecords.has(record.id) && this.raw(scope, record.id))
          continue;
        this.db.run(
          "INSERT INTO bo_records VALUES(?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET data=excluded.data",
          [scope, record.id, record.objectId, JSON.stringify(record)],
        );
      }
      if (!pending.some((entry) => entry.change.kind === "view")) {
        this.db.run("DELETE FROM bo_views WHERE scope=?", [scope]);
        for (const view of snapshot.views)
          this.db.run("INSERT INTO bo_views VALUES(?,?,?)", [
            scope,
            view.id,
            JSON.stringify(view),
          ]);
      }
      this.db.run(
        "INSERT INTO bo_sync(scope,cursor,enabled,last_error) VALUES(?,?,1,?) ON CONFLICT(scope) DO UPDATE SET cursor=excluded.cursor,last_error=excluded.last_error",
        [scope, snapshot.cursor, snapshot.conflicts[0]?.message ?? null],
      );
    });
  }
  syncError(scope: string, message: string) {
    this.db.run("UPDATE bo_sync SET last_error=? WHERE scope=?", [
      message,
      scope,
    ]);
  }
  suspendTeam(scope: string, message: string) {
    this.transaction(() => {
      for (const table of ["bo_records", "bo_models", "bo_views", "bo_audit"])
        this.db.run(`DELETE FROM ${table} WHERE scope=?`, [scope]);
      this.db.run("UPDATE bo_outbox SET error=? WHERE scope=?", [
        message,
        scope,
      ]);
      this.setSync(scope, false);
      this.syncError(scope, message);
    });
  }
  stagePublish(
    scope: string,
    actor: BackOfficeActor,
    source: BackOfficeRecord[],
  ) {
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
            .filter((field) => field.type === "relation" && field.required)
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
            (field.type !== "relation" || field.required) &&
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
      this.enqueue(scope, "record", 0, identity, Object.keys(values));
    }
    for (const record of source) {
      const object = model.objects.find(
        (object) => object.id === record.objectId,
      );
      if (!object) continue;
      const relations = Object.fromEntries(
        Object.entries(record.values).filter(
          ([id]) =>
            object.fields.find((field) => field.id === id)?.type === "relation",
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
        this.enqueue(scope, "record", 0, next, Object.keys(next.values));
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
  queuedRecordIntent(scope: string, operationId: string) {
    const pending = this.pending(scope, 0),
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
    const record = BackOfficeRecordSchema.parse(
      related[related.length - 1].change.data,
    );
    const fields = [
      ...new Set(
        related.flatMap(
          (entry) =>
            entry.change.changedFields ??
            Object.keys(BackOfficeRecordSchema.parse(entry.change.data).values),
        ),
      ),
    ];
    return { record, fields };
  }
  discardQueued(scope: string, operationId: string) {
    const entry = this.pending(scope, 0).find(
      (entry) => entry.change.id === operationId,
    );
    if (!entry)
      throw new ApiError(
        404,
        "back_office_pending",
        "The queued change is unavailable.",
      );
    this.transaction(() => {
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
            BackOfficeRecordSchema.parse(change.data).id === id
          )
            this.db.run("DELETE FROM bo_outbox WHERE id=?", [String(row.id)]);
        }
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
  clearTeam(scope: string) {
    this.transaction(() => {
      for (const table of [
        "bo_records",
        "bo_models",
        "bo_views",
        "bo_outbox",
        "bo_sync",
        "bo_audit",
      ])
        this.db.run(`DELETE FROM ${table} WHERE scope=?`, [scope]);
    });
  }
  close() {
    this.db.close();
  }
}
const instances = new Map<string, Promise<BackOfficeStore>>();
export function backOfficeStore(
  config: ServerConfig,
): Promise<BackOfficeStore> {
  const path = runtimeDbPath(config);
  let instance = instances.get(path);
  if (!instance) {
    instance = (async () => {
      await ensureDir(dirname(path));
      return new BackOfficeStore(await openSqlite(path));
    })();
    instances.set(path, instance);
  }
  return instance;
}
