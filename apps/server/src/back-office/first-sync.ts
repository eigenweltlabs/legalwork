import { createHash } from "node:crypto";
import { ApiError } from "../errors.js";
import { readProjectDetails, updateProjectDetails } from "../project-store.js";
import { noteProjectDetailsSaved } from "../project-sync.js";
import { projectSyncStore } from "../project-sync-store.js";
import type { ServerConfig } from "../types.js";
import { mergePublishModel } from "./publish-model.js";
import { BackOfficeRecordSchema, isInternalBackOfficeObject, visibleBackOfficeRecord, readableBackOfficeRecord, canonicalBackOfficeAudit, validateBackOfficeValues, type BackOfficeActor, type BackOfficeModel, type BackOfficeRecord } from "./schema.js";
import type { BackOfficeStore } from "./store.js";

const unknownSource = " FROM bo_records r LEFT JOIN bo_first_sync s ON s.id=r.id WHERE r.scope='local' AND s.id IS NULL";
const ownedSource = " FROM bo_first_sync s JOIN bo_records r ON r.scope='local' AND r.id=s.id WHERE s.principal=? AND (s.staged IS NULL OR s.staged<>json_extract(r.data,'$.revision'))";

export function unknownRecords(store: BackOfficeStore) {
  return store.db.all("SELECT r.id,json_extract(r.data,'$.revision') AS revision" + unknownSource + " ORDER BY r.id");
}

// A presentation-only overlay on this device. These rows are not firm records or picker options.
export function pendingLocalRows(store: BackOfficeStore, scope: string, actor: BackOfficeActor, objectId: string, includeRelations = false, archived = false) {
  store.requireAccount(scope, actor);
  if (scope === "local" || !actor.principalKey || !actor.edit || isInternalBackOfficeObject(objectId)) return [];
  const local = store.model("local").objects.find(o => o.id === objectId && !o.archived);
  const shared = store.model(scope).objects.find(o => o.id === objectId && !o.archived);
  if (!local || !shared) return [];
  const candidates = store.db.all(`SELECT r.data, s.principal FROM bo_records r LEFT JOIN bo_first_sync s ON s.id=r.id
    WHERE r.scope='local' AND r.object_id=? AND (json_extract(r.data,'$.archivedAt') IS NOT NULL)=?
      AND (s.id IS NULL OR (s.principal=? AND s.staged IS NULL))
      AND NOT EXISTS (SELECT 1 FROM bo_records t WHERE t.scope=? AND t.id=r.id)`, [objectId, Number(archived), actor.principalKey, scope]);
  const readable = (record: BackOfficeRecord, principal: unknown) =>
    visibleBackOfficeRecord(record.ownerId === "local" && principal === actor.principalKey ? { ...record, ownerId: actor.userId } : record, actor);
  return candidates.flatMap(row => {
    const record = BackOfficeRecordSchema.parse(JSON.parse(String(row.data)));
    if (!readable(record, row.principal)) return [];
    const matter = record.values.matter;
    if (typeof matter === "string") {
      const parent = store.raw(scope, matter);
      if (parent) {
        if (!store.canRead(scope, parent, actor)) return [];
      } else {
        const localParent = store.raw("local", matter);
        const origin = store.db.get("SELECT principal,staged FROM bo_first_sync WHERE id=?", [matter]);
        if (!localParent || (origin && (origin.principal !== actor.principalKey || origin.staged != null)) || !readable(localParent, origin?.principal)) return [];
      }
    }
    const visible = readableBackOfficeRecord(readableBackOfficeRecord(record, local, actor), shared, actor);
    // References and files are scoped to their source directory.
    const values = Object.fromEntries(Object.entries(visible.values).filter(([id]) => {
      const field = local.fields.find(f => f.id === id);
      return field && field.type !== "file" && (field.type !== "relation" || includeRelations && field.target === shared.fields.find(f => f.id === id)?.target) && field.type === shared.fields.find(f => f.id === id)?.type;
    }));
    return [{ ...visible, values, members: [], sourceId: undefined }];
  });
}

export function localDirectoryRows(store: BackOfficeStore, scope: string, actor: BackOfficeActor, objectId: string, archived = false) {
  const rows = pendingLocalRows(store, scope, actor, objectId, true, archived);
  const choices = new Map<string, BackOfficeRecord>();
  if (rows.length) {
    const object = store.model(scope).objects.find(object => object.id === objectId);
    const relations = object?.fields.filter(field => field.type === "relation" && field.target) ?? [];
    for (const target of new Set(relations.map(field => field.target!))) {
      for (const row of pendingLocalRows(store, scope, actor, target)) choices.set(row.id, row);
      for (const row of store.records(scope, actor, target)) {
        const copy = store.raw("local", row.id);
        if (copy && !copy.archivedAt && copy.objectId === target) choices.set(row.id, row);
      }
    }
    for (const row of rows) for (const field of relations) {
      const value = row.values[field.id];
      if (Array.isArray(value)) row.values[field.id] = value.filter((id): id is string => typeof id === "string" && choices.has(id));
      else if (typeof value === "string" && !choices.has(value)) delete row.values[field.id];
    }
  }
  return { localRows: rows, localChoices: [...choices.values()].map(record => ({ ...record, values: { name: record.values.name }, members: [], sourceId: undefined })) };
}

export function createLocalRelated(store: BackOfficeStore, scope: string, actor: BackOfficeActor, source: { id: string; objectId: string; fields: string[] }, body: { id: string; objectId: string; values: BackOfficeRecord["values"] }) {
  return store.transaction(() => {
    const parent = pendingLocalRows(store, scope, actor, source.objectId).find(row => row.id === source.id);
    if (!parent) throw new ApiError(404, "back_office_record", "The record is unavailable.");
    const shared = store.model(scope), local = store.model("local");
    let target = parent.objectId;
    for (const id of source.fields) {
      const field = shared.objects.find(o => !o.archived && o.id === target)?.fields.find(f => f.id === id);
      const localField = local.objects.find(o => !o.archived && o.id === target)?.fields.find(f => f.id === id);
      if (!field?.target || field.type !== "relation" || localField?.target !== field.target ||
          field.visibility === "finance" && !actor.finance || field.visibility === "private" || isInternalBackOfficeObject(field.target))
        throw new ApiError(403, "back_office_relation", "This relationship is unavailable.");
      target = field.target;
    }
    if (target !== body.objectId) throw new ApiError(400, "back_office_relation", "Choose a record of the linked type.");
    const definition = shared.objects.find(o => !o.archived && o.id === target);
    if (!definition) throw new ApiError(404, "back_office_object", "The object is unavailable.");
    for (const [key,value] of Object.entries(body.values)) {
      const field = definition.fields.find(f => f.id === key);
      const sourceField = local.objects.find(o => o.id === target)?.fields.find(f => f.id === key);
      if (!field || sourceField?.type !== field.type || field.type === "file" || field.visibility === "finance" && !actor.finance)
        throw new ApiError(403, "back_office_field", "This field is unavailable.");
      if (field.type === "relation" && value) {
        const ids = new Set(pendingLocalRows(store, scope, actor, field.target!).map(row => row.id));
        for (const id of [value].flat()) if (typeof id !== "string" || !ids.has(id) && !store.records(scope, actor, field.target).some(row => row.id === id))
          throw new ApiError(400, "back_office_relation", "Choose an available record on this computer.");
      }
    }
    const record = store.saveRecord("local", actor, { ...body, create: true, revision: 0 });
    if (!store.db.get("SELECT 1 FROM bo_first_sync WHERE id=?", [source.id]))
      store.db.run("DELETE FROM bo_first_sync WHERE id=? AND principal=? AND staged IS NULL", [record.id, actor.principalKey!]);
    return { record: readableBackOfficeRecord(record, definition, actor), localCopy: true };
  }, { actor, action: "record.create" });
}

export function editLocalCopy(store: BackOfficeStore, scope: string, actor: BackOfficeActor, body: {
  id: string; objectId: string; revision: number; values: BackOfficeRecord["values"]; expectedValues?: BackOfficeRecord["values"]; archived?: boolean;
}) {
  return store.transaction(() => {
    const directory = localDirectoryRows(store, scope, actor, body.objectId, Boolean(store.raw("local", body.id)?.archivedAt));
    if (!directory.localRows.some(row => row.id === body.id)) {
      if (scope !== "local" && store.raw(scope, body.id)) return { record: store.saveRecord(scope, actor, body), localCopy: false };
      throw new ApiError(404, "back_office_record", "The record is unavailable.");
    }
    const object = store.model(scope).objects.find(object => object.id === body.objectId)!;
    const source = store.model("local").objects.find(object => object.id === body.objectId)!;
    for (const [key, value] of Object.entries(body.values)) {
      const field = object.fields.find(field => field.id === key), local = source.fields.find(field => field.id === key);
      if (!field || !local || local.type !== field.type || field.type === "file" || field.visibility === "finance" && !actor.finance ||
          field.visibility === "private" && store.raw("local", body.id)?.ownerId !== actor.userId)
        throw new ApiError(403, "back_office_field", "This field is unavailable.");
      if (field.type === "relation" && (field.target !== local.target || value != null && [value].flat().some(id =>
        !directory.localChoices.some(row => row.id === id && row.objectId === field.target))))
        throw new ApiError(400, "back_office_relation", "Choose an available record on this computer.");
    }
    // A hidden reference must survive editing other fields or adding a visible relation.
    const original = store.raw("local", body.id)!;
    const visible = directory.localRows.find(row => row.id === body.id)!;
    for (const field of object.fields.filter(field => field.type === "relation" && field.id in body.values)) {
      if (canonicalBackOfficeAudit(original.values[field.id] ?? null) !== canonicalBackOfficeAudit(visible.values[field.id] ?? null))
        throw new ApiError(403, "back_office_relation", "Some links are outside your access.");
    }
    try {
      const saved = store.saveRecord("local", actor, body);
      const projection = localDirectoryRows(store, scope, actor, body.objectId, Boolean(saved.archivedAt)).localRows.find(row => row.id === saved.id);
      return { record: projection ?? { ...visible, archivedAt: saved.archivedAt, revision: saved.revision }, localCopy: true };
    } catch (error) {
      if (error instanceof ApiError && error.code === "back_office_field_conflict")
        throw new ApiError(409, error.code, error.message, { record: visible, fields: Object.keys(body.values) });
      throw error;
    }
  }, { actor, action: "record.write" });
}
export function firstSyncStatus(store: BackOfficeStore, actor: BackOfficeActor) {
  const unknown = unknownRecords(store);
  return {
    unassigned: unknown.length,
    selection: unknown.length ? createHash("sha256").update(JSON.stringify(unknown)).digest("hex") : null,
    waiting: Number(store.db.get("SELECT count(*) AS n" + ownedSource, [actor.principalKey!])?.n ?? 0),
  };
}

export function assignLocalRecords(store: BackOfficeStore, scope: string, actor: BackOfficeActor, selection: string) {
  store.transaction(() => {
    store.requireAccount(scope, actor);
    if (!actor.edit || !actor.principalKey) throw new ApiError(403, "back_office_forbidden", "Directory editor access is required.");
    if (firstSyncStatus(store, actor).selection !== selection)
      throw new ApiError(409, "back_office_records_changed", "The records on this computer changed. Review them again.");
    store.db.run("INSERT INTO bo_first_sync(id,principal) SELECT r.id,?" + unknownSource, [actor.principalKey]);
  }, { actor, action: "directory.assign" });
}

// Hold dependent operations in order, but keep syncing unrelated records.
export function firstSyncBatch(store: BackOfficeStore, scope: string, actor: BackOfficeActor) {
  const first = store.pending(scope, 100, actor);
  if (!first.some(entry => entry.error)) return first.map(entry => entry.change);
  const blocked = new Set<string>(), result = [];
  const model = store.model(scope);
  for (const { change, error } of store.pending(scope, 0, actor)) {
    if (change.kind !== "record") {
      if (error || blocked.size) break;
    } else {
      const data = BackOfficeRecordSchema.parse(change.data);
      const fields = model.objects.find(o => o.id === data.objectId)?.fields ?? [];
      if (error || blocked.has(data.id) || fields.some(f => f.type === "relation" && [data.values[f.id]].flat().some(id => typeof id === "string" && blocked.has(id)))) {
        blocked.add(data.id);
        continue;
      }
    }
    result.push(change);
    if (result.length === 100) break;
  }
  return result;
}

function fingerprints(record: BackOfficeRecord): Record<string,string> {
  const hash = (value: Parameters<typeof canonicalBackOfficeAudit>[0]) =>
    createHash("sha256").update(canonicalBackOfficeAudit(value)).digest("hex");
  return {
    ...Object.fromEntries(Object.entries(record.values).map(([id,value]) => ["field:" + id, hash(value)])),
    sharing: hash([record.access, [...record.members].sort()]), archive: hash(record.archivedAt ?? null), source: hash(record.sourceId ?? null),
  };
}

// Pull the firm snapshot before choosing new rows. Store the queue and its receipts in
// one SQLite transaction so a restart can only resend the original operation IDs.
export function stageFirstSync(store: BackOfficeStore, scope: string, actor: BackOfficeActor, sharedProjects: Set<string>) {
  if (!actor.edit || !actor.principalKey || !store.db.get("SELECT 1" + ownedSource + " LIMIT 1", [actor.principalKey])) return false;
  return store.transaction(() => {
    store.requireAccount(scope, actor);
    const principal = actor.principalKey!;
    const team = store.model(scope), local = store.model("local");
    const candidates = new Map<string, BackOfficeRecord>();
    const updates: { record: BackOfficeRecord; remote: BackOfficeRecord; values: BackOfficeRecord["values"]; conflict: boolean; baseline: Record<string,string> }[] = [];
    const adopted: BackOfficeRecord[] = [];
    const identicalModels = JSON.stringify(local.objects) === JSON.stringify(team.objects);
    let model = team;
    const known = new Set(store.db.all("SELECT id FROM bo_records WHERE scope=?", [scope]).map(row => String(row.id)));
    for (const row of store.db.all("SELECT r.data,s.staged,s.baseline,s.operation" + ownedSource, [principal])) {
      const record = BackOfficeRecordSchema.parse(JSON.parse(String(row.data)));
      if (row.operation) continue;
      const remote = known.has(record.id) ? store.raw(scope, record.id) : null;
      if ((row.staged != null && !remote) || (remote && remote.objectId !== record.objectId)) continue;
      if (record.objectId === "projectLinks" && !sharedProjects.has(String(record.values.projectId))) continue;
      const object = local.objects.find(o => o.id === record.objectId);
      if (!object || object.archived || !actor.finance && (["invoices", "feeAgreements", "billingItems"].includes(object.id)
        || object.fields.some(f => f.visibility === "finance" && record.values[f.id] != null))) continue;
      // A local model may contain definitions belonging to another firm. Only take
      // the fields required by this record, and leave incompatible records on disk.
      const fields = object.fields.filter(f => f.required || Object.hasOwn(record.values, f.id));
      let merged: BackOfficeModel;
      try {
        merged = identicalModels ? model : mergePublishModel({ ...local, objects: [{ ...object, fields }] }, model);
        const target = merged.objects.find(o => o.id === object.id)!;
        if (target.archived || (!actor.model && merged !== model && JSON.stringify(merged.objects) !== JSON.stringify(model.objects))) continue;
        validateBackOfficeValues(target, record.values);
      } catch { continue; }
      if (remote) {
        if (!store.canRead(scope, remote, actor)) continue;
        const current = fingerprints(remote), desired = fingerprints(record);
        if (!row.baseline) {
          // A server copy predating first-sync receipts can only be adopted if its
          // identity and contents agree. Equal names alone never identify a record.
          if (remote.createdAt === record.createdAt && remote.ownerId === actor.userId &&
              Object.keys(desired).every(key => current[key] === desired[key])) {
            adopted.push(record);
          } else {
            const values = Object.fromEntries(Object.entries(record.values).filter(([id]) => current["field:" + id] !== desired["field:" + id]));
            updates.push({ record, remote, conflict: true, baseline: current, values });
            model = merged;
          }
          continue;
        }
        const baseline: Record<string,string> = JSON.parse(String(row.baseline));
        const changed = Object.keys(desired).filter(key => baseline[key] !== desired[key]);
        const conflict = changed.some(key => current[key] !== baseline[key] && current[key] !== desired[key]);
        updates.push({ record, remote, conflict, baseline, values: Object.fromEntries(Object.entries(record.values).filter(([id]) => changed.includes("field:" + id))) });
      } else {
        candidates.set(record.id, record);
      }
      model = merged;
    }
    if (model !== team && JSON.stringify(model.objects) !== JSON.stringify(team.objects)) {
      try { store.saveModel(scope, actor, model, team.revision); }
      catch (error) {
        if (!(error instanceof ApiError && [400,403,409].includes(error.status))) throw error;
        // A firm may already have required fields or different custom relations.
        // Continue with rows that fit its existing schema.
        model = team;
        const fits = (record: BackOfficeRecord) => {
          const object = team.objects.find(o => o.id === record.objectId && !o.archived);
          if (!object) return false;
          try { validateBackOfficeValues(object, record.values); return true; } catch { return false; }
        };
        for (const record of candidates.values()) if (!fits(record)) candidates.delete(record.id);
        for (let i = updates.length - 1; i >= 0; i--) if (!fits(updates[i].record)) updates.splice(i, 1);
      }
    }
    // An unresolvable required cycle must not stop independent records.
    const available = new Set(known);
    const remaining = new Map(candidates);
    while (remaining.size) {
      const size = remaining.size;
      for (const [id, record] of remaining) {
        const object = model.objects.find(o => o.id === record.objectId)!;
        const ready = object.fields.filter(f => f.type === "relation" && (f.required || f.id === "matter")).every(f =>
          [record.values[f.id]].flat().every(value => value == null || typeof value === "string" && available.has(value)));
        if (ready) { available.add(id); remaining.delete(id); }
      }
      if (remaining.size === size) break;
    }
    for (const id of remaining.keys()) candidates.delete(id);
    // Do not detach links or broaden matter access to make a partial import fit.
    let removed: boolean;
    do {
      removed = false;
      for (const record of candidates.values()) {
        const object = model.objects.find(o => o.id === record.objectId)!;
        const missing = object.fields.some(f => {
          const value = record.values[f.id];
          return f.type === "relation" && value != null && (Array.isArray(value) ? value : [value])
            .some(id => typeof id === "string" && !known.has(id) && !candidates.has(id));
        });
        if (missing) { candidates.delete(record.id); removed = true; }
      }
    } while (removed);
    if (!candidates.size && !updates.length && !adopted.length) return false;
    const staged = [...candidates.values()];
    if (staged.length) store.stagePublish(scope, actor, staged);
    for (const { record, remote, values, conflict, baseline } of updates) {
      const desired = fingerprints(record);
      try {
        if (conflict) {
          const metadata = (["sharing", "archive", "sourceId"] as const).filter(key => {
            const hashKey = key === "sourceId" ? "source" : key;
            return baseline[hashKey] !== desired[hashKey];
          });
          store.holdFirstSyncConflict(scope, actor, record, remote.revision, Object.keys(values), metadata);
          staged.push(record);
          continue;
        }
        store.saveRecord(scope, actor, {
          id: record.id, objectId: record.objectId, revision: remote.revision, values,
          ...(baseline.sharing !== desired.sharing ? { access: record.access, members: record.members } : {}),
          ...(baseline.archive !== desired.archive ? { archived: !!record.archivedAt } : {}),
          ...(baseline.source !== desired.source ? { sourceId: record.sourceId ?? null } : {}),
        });
        staged.push(record);
      } catch (error) {
        if (!(error instanceof ApiError && [400,403,404,409].includes(error.status))) throw error;
      }
    }
    const operations = new Map<string,string>();
    for (const row of store.db.all("SELECT id,json_extract(data,'$.data.id') AS recordId FROM bo_outbox WHERE scope=? AND json_extract(data,'$.kind')='record' ORDER BY seq",[scope]))
      operations.set(String(row.recordId), String(row.id));
    for (const record of [...staged, ...adopted])
      store.db.run("UPDATE bo_first_sync SET staged=?,baseline=?,operation=?,confirmed=CASE WHEN ? IS NULL THEN 1 ELSE confirmed END WHERE id=? AND principal=?",
        [record.revision,JSON.stringify(fingerprints(record)),operations.get(record.id) ?? null,operations.get(record.id) ?? null,record.id,principal]);
    return staged.length > 0;
  }, { actor, action: "directory.first_sync" });
}

export async function connectFirstSyncProjects(config: ServerConfig, store: BackOfficeStore, scope: string, actor: BackOfficeActor, directoryId: string) {
  const principal = actor.principalKey!;
  const count = Number(store.db.get("SELECT count(*) AS n FROM bo_first_sync WHERE principal=? AND confirmed=1", [principal])?.n);
  if (!count) return;
  const localId = "local:" + store.journal.storage.identity.deviceId;
  const links = await projectSyncStore(config);
  const done = new Set(store.db.all("SELECT workspace FROM bo_first_sync_projects WHERE principal=? AND generation=?", [principal, count]).map(row => row.workspace));
  for (const workspace of config.workspaces) {
    if (done.has(workspace.id) || !workspace.path) continue;
    const link = links.linkByWorkspace(workspace.id);
    if (link && link.orgId !== scope) continue;
    try {
      const details = await readProjectDetails(workspace.path);
      const fields = details.fields.map(field => {
        if (field.type !== "backoffice" || field.value?.directoryId !== localId || !field.value.recordIds.length) return field;
        const shared = field.value.recordIds.every(id => store.db.get("SELECT 1 FROM bo_first_sync WHERE id=? AND principal=? AND confirmed=1", [id,principal]));
        return shared ? { ...field, value: { ...field.value, directoryId } } : field;
      });
      store.requireAccount(scope, actor);
      if (fields.some((field,i) => field !== details.fields[i])) {
        await updateProjectDetails(workspace.path, { revision: details.revision, fields }, async () => store.requireAccount(scope, actor));
        await noteProjectDetailsSaved(config, workspace.id, details.fields, fields);
      }
      store.db.run("INSERT OR REPLACE INTO bo_first_sync_projects VALUES(?,?,?)", [principal, workspace.id, count]);
    } catch (error) {
      if (!(error instanceof ApiError && [404,409].includes(error.status))) throw error;
      // A disconnected drive or concurrent project edit is retried on the next sync.
    }
  }
}
