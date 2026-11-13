import { scheduleTaskSync } from "../task-sync.js";
import { scheduleProjectSync } from "../project-sync.js";
import { announceSyncChange } from "../app-sync-events.js";
import { BackOfficeSyncRounds } from "./sync-rounds.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../errors.js";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { requireIntakeClient, intakeRequest } from "../eigenwelt-intake.js";
import { projectSyncStore } from "../project-sync-store.js";
import { taskStore } from "../task-store.js";
import { connectedTaskOrgId } from "../tasks-api.js";
import { calendarStore } from "../calendar/store.js";
import { calendarVisible } from "../calendar/service.js";
import type { ServerConfig } from "../types.js";
import { backOfficeStore, type BackOfficeStore } from "./store.js";
import { backOfficeAccess, backOfficeDirectoryIdentity } from "./access.js";
import type { SqliteHandle } from "../runtime-db.js";
import { isInternalBackOfficeObject, type BackOfficeActor } from "./schema.js";
import { requireBackOfficePrincipal } from "./accounts.js";

export const sourceSchema = z.object({
  kind: z.enum(["task", "deadline"]),
  sourceId: z.string().uuid(),
  projectKey: z.string().max(200),
});
const edgeSchema = sourceSchema.extend({ recordId: z.string().uuid() });
const storedSchema = edgeSchema.extend({ present: z.number(), stamp: z.string().nullable(), generation: z.string().uuid().nullable() });
type Source = z.infer<typeof sourceSchema>;
type Edge = z.infer<typeof edgeSchema>;
type Access = { scope: string; actor: BackOfficeActor };
const table = "native_directory_links";
const put = `INSERT INTO ${table}(account,kind,sourceId,projectKey,recordId,present,stamp) VALUES(?,?,?,?,?,?,?)
 ON CONFLICT(account,kind,sourceId,projectKey,recordId) DO UPDATE SET present=excluded.present,stamp=excluded.stamp`;
const identity = (e: Edge) => [e.kind, e.sourceId, e.projectKey, e.recordId];
const key = (e: Edge) => JSON.stringify(identity(e));
const accountKey = (a: Access) => a.actor.principalKey ?? "local";

export async function nativeSources(config: ServerConfig, source?: Pick<Source, "kind" | "projectKey">) {
  const org = connectedTaskOrgId(await readEigenweltConnection(config));
  const [tasks, calendars, projects] = await Promise.all([
    taskStore(config),
    calendarStore(config),
    projectSyncStore(config),
  ]);
  const visibleProjects = new Map(config.workspaces.map((w) => [w.id, w]));
  const taskVisible = (task: { projectId?: string | null; sync: { orgId: string | null } }) => {
    if (task.sync.orgId && task.sync.orgId !== org) return false;
    if (!task.projectId) return true;
    if (!visibleProjects.has(task.projectId)) return false;
    const project = projects.linkByWorkspace(task.projectId);
    return (
      !project ||
      (project.role === "owner" && project.orgId === org) ||
      (project.orgId === org && project.state === "active" && project.settings.scope.tasks)
    );
  };
  const calendarProjects = (
    await Promise.all(config.workspaces.filter(w => !source || (source.kind === "deadline" && w.id === source.projectKey)).map(async (w) => ((await calendarVisible(config, w)) ? w : null)))
  ).filter((w) => w !== null);
  const allowed = (s: Source) => {
    if (s.kind === "task") {
      const task = tasks.getTask(s.sourceId);
      return !s.projectKey && task && !task.deletedAt && taskVisible(task);
    }
    if (!calendarProjects.some((w) => w.id === s.projectKey)) return false;
    const project = projects.linkByWorkspace(s.projectKey);
    if (project && project.orgId !== org) return false;
    try {
      const item = calendars.get(s.projectKey, s.sourceId);
      return !item.deletedAt && item.kind === "deadline";
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return false;
      throw error;
    }
  };
  return { org, tasks, calendars, projects, calendarProjects, taskVisible, allowed };
}
function targetAccess(store: BackOfficeStore, { scope, actor }: Access) {
  store.requireAccount(scope, actor);
  const objects = new Set(
    store
      .model(scope)
      .objects.filter((o) => !o.archived && !isInternalBackOfficeObject(o.id))
      .map((o) => o.id),
  );
  const results = new Map<string, boolean>();
  return (id: string) => {
    const cached = results.get(id);
    if (cached !== undefined) return cached;
    const record = store.raw(scope, id);
    const readable =
      !!record && !record.archivedAt && objects.has(record.objectId) && store.canRead(scope, record, actor);
    results.set(id, readable);
    return readable;
  };
}
export function visibleNativeLinks(
  store: BackOfficeStore,
  access: Access,
  sources: Awaited<ReturnType<typeof nativeSources>>,
  filter?: { recordId: string } | { kind: Source["kind"] } | Source,
) {
  const where = !filter ? "" : "recordId" in filter ? " AND recordId=?" : "sourceId" in filter
    ? " AND kind=? AND projectKey=? AND sourceId=?" : " AND kind=?";
  const params = !filter ? [] : "recordId" in filter ? [filter.recordId] : "sourceId" in filter
    ? [filter.kind, filter.projectKey, filter.sourceId] : [filter.kind];
  const viewer = store.connectedPrincipalKey();
  const localOwner = access.scope === "local" ? " AND (stamp IS NULL OR stamp=? OR stamp=?)" : "";
  const rows = store.db.all(`SELECT * FROM ${table} WHERE account=? AND present=1` + where + localOwner, [
    accountKey(access), ...params, ...(localOwner ? [viewer, viewer ? "shared:" + viewer : null] : []),
  ]);
  if (!rows.length) return [];
  const canReadTarget = targetAccess(store, access);
  return rows
    .map((row) => edgeSchema.parse(row))
    .filter((e) => canReadTarget(e.recordId) && sources.allowed(e));
}
export function changeNativeLinks(
  store: BackOfficeStore,
  access: Access,
  sources: Awaited<ReturnType<typeof nativeSources>>,
  source: Source,
  add: string[],
  remove: string[],
) {
  if (!sources.allowed(source)) throw new ApiError(404, "native_link_missing", "This record is unavailable.");
  store.transaction(() => writeLinkChanges(store.db, store, access, source, add, remove));
}

function writeLinkChanges(db: SqliteHandle, store: BackOfficeStore, access: Access, source: Source, add: string[], remove: string[]) {
  store.requireAccount(access.scope, access.actor);
  if (!access.actor.edit)
    throw new ApiError(403, "native_link_access", "Directory editing permission is required.");
  const canReadTarget = targetAccess(store, access);
  if ([...add, ...remove].some(id => !canReadTarget(id)))
    throw new ApiError(404, "native_link_missing", "This record is unavailable.");
  const account = accountKey(access);
  for (const [ids, present] of [
    [add, 1],
    [remove, 0],
  ] as const)
    for (const recordId of ids) {
      const edge = { ...source, recordId };
      if (!present && access.scope === "local")
        db.run(
          `DELETE FROM ${table} WHERE account=? AND kind=? AND sourceId=? AND projectKey=? AND recordId=?`,
          [account, ...identity(edge)],
        );
      else
        db.run(put, [
          account,
          ...identity(edge),
          present,
          access.scope === "local" ? store.connectedPrincipalKey() : randomUUID(),
        ]);
    }
}

export const linkChangesSchema = z.object({
  directoryId: z.string(), userId: z.string(), add: z.array(z.uuid()).max(1000), remove: z.array(z.uuid()).max(1000),
});

// The native store calls write inside its own SQLite transaction, so both the item
// and its links roll back if a selected record or its permissions have changed.
export async function prepareFormLinks(config: ServerConfig, raw: unknown, kind: Source["kind"], project: string) {
  if (raw === undefined) return;
  const changes = linkChangesSchema.parse(raw);
  const access = await backOfficeAccess(config);
  const store = await backOfficeStore(config);
  store.checkIntegrity();
  if (changes.directoryId !== await backOfficeDirectoryIdentity(config, access.scope, store) || changes.userId !== access.actor.userId)
    throw new ApiError(409, "native_link_account", "The account changed.");
  const projectKey = kind === "deadline" ? project : "";
  const sources = await nativeSources(config, { kind, projectKey });
  store.model(access.scope); // Finish any lazy schema upgrade before entering the native store transaction.
  const canLink = kind === "task" ? sources.taskVisible({ projectId: project || null, sync: { orgId: null } })
    : sources.calendarProjects.some(w => w.id === project) && (sources.projects.linkByWorkspace(project)?.orgId ?? sources.org) === sources.org;
  if (!canLink) throw new ApiError(404, "native_link_missing", "This record is unavailable.");
  return {
    write: (db: SqliteHandle, sourceId: string) => writeLinkChanges(db, store, access, { kind, sourceId, projectKey }, changes.add, changes.remove),
    committed: () => {
      announceSyncChange(config, "backOffice");
      if (access.scope !== "local") scheduleNativeLinkSync(config, store, access.scope, access.actor);
    },
  };
}

// Rotate the queue when one endpoint has not reached the platform yet.
const lastAttempt = new Map<string, number>();
export async function syncNativeLinks(
  config: ServerConfig,
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
) {
  const account = actor.principalKey;
  if (!account) return false;
  const sources = await nativeSources(config);
  const canReadTarget = targetAccess(store, { scope, actor });
  const sharedProjects = sources.projects
    .links()
    .filter(
      (p) => p.orgId === scope && p.confirmed && p.state === "active" && p.settings.scope.calendar !== false,
    );
  const projectsByWorkspace = new Map(sharedProjects.map((p) => [p.workspaceId, p.projectId]));
  function wireProject(e: Source) {
    if (!sources.allowed(e)) return undefined;
    if (e.kind === "deadline") return projectsByWorkspace.get(e.projectKey);
    const task = sources.tasks.getTask(e.sourceId);
    if (task?.sync.orgId !== scope) return undefined;
    if (task.projectId) {
      const project = sources.projects.linkByWorkspace(task.projectId);
      if (!project || project.orgId !== scope || !project.confirmed || project.state !== "active" || !project.settings.scope.tasks) return undefined;
    }
    return "";
  }
  // Promote links only after both their native source and their CRM record were shared.
  // A disconnected author's work cannot be published by a different signed-in firm.
  if (actor.edit && store.db.get(`SELECT 1 FROM ${table} WHERE account='local' AND present=1 AND (stamp IS NULL OR stamp=?) LIMIT 1`,[account]))
    store.transaction(() => {
      const eligible = store.db.all(
        `SELECT l.* FROM ${table} l JOIN bo_first_sync f ON f.id=l.recordId
      WHERE l.account='local' AND l.present=1 AND (l.stamp IS NULL OR l.stamp=?) AND f.confirmed=1 AND f.principal=?`,
        [account, account],
      );
      for (const row of eligible) {
        const e = edgeSchema.parse(row);
        if (!canReadTarget(e.recordId) || wireProject(e) === undefined) continue;
        store.db.run(
          `INSERT OR IGNORE INTO ${table}(account,kind,sourceId,projectKey,recordId,present,stamp) VALUES(?,?,?,?,?,1,?)`,
          [account, ...identity(e), randomUUID()],
        );
        store.db.run(
          `UPDATE ${table} SET stamp=? WHERE account='local' AND kind=? AND sourceId=? AND projectKey=? AND recordId=?`,
          ["shared:" + account, ...identity(e)],
        );
      }
    });
  const queueKey = JSON.stringify([config.configPath, account]);
  const pending = store.db
    .all(`SELECT rowid AS ordinal,* FROM ${table} WHERE account=? AND stamp IS NOT NULL ORDER BY (rowid <= ?), rowid`, [account, lastAttempt.get(queueKey) ?? 0])
    .map(row => ({ ...storedSchema.parse(row), ordinal: Number(row.ordinal) }));
  const changes = pending
    .flatMap((e) => {
      if (!actor.edit || !canReadTarget(e.recordId)) return [];
      const projectKey = wireProject(e);
      return projectKey === undefined ? [] : [{ ...e, projectKey, present: Boolean(e.present) }];
    })
    .slice(0, 200);
  if (changes.length) lastAttempt.set(queueKey, changes[changes.length - 1].ordinal);
  else lastAttempt.delete(queueKey);
  const client = requireIntakeClient(await requireBackOfficePrincipal(config, account));
  let response;
  try {
    response = await intakeRequest(client, "POST", "/api/back-office/native-links", { changes, generations: true });
  } catch (error) {
    // Older platforms still serve the ordinary directory. Retain pending local links.
    if (error instanceof ApiError && error.status === 404) return false;
    throw error;
  }
  const result = z
    .object({ links: z.array(edgeSchema), accepted: z.array(z.string().uuid()),
      states: z.array(edgeSchema.extend({ present: z.boolean(), generation: z.uuid().nullable() })).optional() })
    .parse(response);
  await requireBackOfficePrincipal(config, account);
  store.requireAccount(scope, actor);
  type Remote = Edge & { present: boolean; generation: string | null };
  const incoming = new Map<string, Remote>();
  for (const row of result.states ?? result.links.map(link => ({ ...link, present: true, generation: null }))) {
    const project = sharedProjects.find((p) => p.projectId === row.projectKey);
    if (row.kind === "deadline" && !project) continue;
    const local = { ...row, projectKey: project?.workspaceId ?? "" };
    incoming.set(key(local), local);
  }
  if (!incoming.size && !result.accepted.length && !store.db.get(`SELECT 1 FROM ${table} WHERE account=? LIMIT 1`,[account])) return false;
  return store.transaction(() => {
    let changed = false;
    for (const stamp of result.accepted)
      store.db.run(`UPDATE ${table} SET stamp=NULL WHERE account=? AND stamp=?`, [account, stamp]);
    const ownRemovals = new Set(changes.filter(change => !change.present && change.stamp && result.accepted.includes(change.stamp)).map(change => change.stamp));
    for (const row of store.db.all(`SELECT * FROM ${table} WHERE account=?`, [account])) {
      const existing = storedSchema.parse(row);
      const remote = incoming.get(key(existing));
      if (existing.stamp) {
        // A second click may precede the acknowledgement of our own removal.
        if (remote?.generation && ownRemovals.has(remote.generation))
          store.db.run(`UPDATE ${table} SET generation=? WHERE account=? AND stamp=?`, [remote.generation, account, existing.stamp]);
        incoming.delete(key(existing));
      } else if (!remote) {
        store.db.run(`DELETE FROM ${table} WHERE account=? AND kind=? AND sourceId=? AND projectKey=? AND recordId=?`, [account, ...identity(existing)]);
        changed ||= Boolean(existing.present);
      } else if (Boolean(existing.present) === remote.present && existing.generation === remote.generation) {
        incoming.delete(key(existing));
      }
    }
    for (const e of incoming.values()) {
      store.db.run(`INSERT INTO ${table}(account,kind,sourceId,projectKey,recordId,present,stamp,generation) VALUES(?,?,?,?,?,?,NULL,?)
        ON CONFLICT(account,kind,sourceId,projectKey,recordId) DO UPDATE SET present=excluded.present,stamp=NULL,generation=excluded.generation`,
        [account, ...identity(e), Number(e.present), e.generation]);
      changed = true;
      if (e.present && !sources.allowed(e)) {
        if (e.kind === "task") scheduleTaskSync(config);
        else scheduleProjectSync(config);
      }
    }
    if (changes.length === 200 && result.accepted.length) scheduleNativeLinkSync(config, store, scope, actor);
    return changed;
  });
}

const rounds = new BackOfficeSyncRounds();
export function scheduleNativeLinkSync(
  config: ServerConfig,
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
) {
  const key = JSON.stringify([config.configPath, scope, actor.principalKey]);
  void rounds
    .run(key, async () => {
      if (await syncNativeLinks(config, store, scope, actor)) announceSyncChange(config, "backOffice");
    })
    .catch((error) => {
      if (
        error instanceof ApiError &&
        ["back_office_account_changed", "back_office_replica_changed"].includes(error.code)
      )
        return;
      console.warn(
        "[back-office] Native links will sync again on the next directory update.",
        error instanceof Error ? error.message : "Sync failed",
      );
    });
}
