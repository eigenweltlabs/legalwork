import { createHash, randomUUID } from "node:crypto";
import { firstSyncBatch, assignLocalRecords, firstSyncStatus, unknownRecords, connectFirstSyncProjects, stageFirstSync } from "./first-sync.js";
import { syncRecordFiles } from "./file-sync.js";
import { backOfficeAccess, refreshBackOfficeActor } from "./access.js";
import { backOfficeStore, existingBackOfficeStore } from "./store.js";
import { mergePublishModel } from "./publish-model.js";
import {
  BackOfficeRecordSchema,
  BackOfficeSnapshotSchema,
  BackOfficeDeltaSchema,
  directoryBuckets,
  directoryBucketHashes,
  expandDirectoryDelta,
  type BackOfficeRecord,
  type BackOfficeSnapshot,
  type BackOfficeActor,
} from "./schema.js";
import { intakeRequest, requireIntakeClient } from "../eigenwelt-intake.js";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { ensureFreshPlatformToken } from "../eigenwelt-refresh.js";
import { announceSyncChange } from "../app-sync-events.js";
import { ApiError } from "../errors.js";
import { projectSyncStore } from "../project-sync-store.js";
import type { ServerConfig } from "../types.js";
import { BackOfficeSyncRounds } from "./sync-rounds.js";
import { connectedBackOfficePrincipal, requireBackOfficePrincipal } from "./accounts.js";
import { backOfficeAuthorKey, backOfficeDirectoryKey, backOfficePrincipalKey } from "./principal.js";

const rounds = new BackOfficeSyncRounds(),
  scheduled = new Map<string, ReturnType<typeof setTimeout>>();
export async function backOfficePlatform(
  config: ServerConfig,
  changes: unknown[] = [],
  expectedPrincipal?: string,
  baseline?: BackOfficeRecord[],
): Promise<BackOfficeSnapshot> {
  const principal = expectedPrincipal ?? await connectedBackOfficePrincipal(config);
  if (!principal) throw new ApiError(403, "back_office_firm", "Sign in to your firm to open team records.");
  await ensureFreshPlatformToken(config);
  const client = requireIntakeClient(await requireBackOfficePrincipal(config, principal));
  const buckets = baseline && directoryBuckets(baseline);
  const response = await intakeRequest(client, "POST", "/api/back-office", {
    protocol: 1, changes, cursor: 0,
    recordBuckets: buckets && directoryBucketHashes(buckets, text => createHash("sha256").update(text).digest("hex")),
  });
  const snapshot = buckets && response && typeof response === "object" && "recordDelta" in response
    ? expandDirectoryDelta(buckets, BackOfficeDeltaSchema.parse(response))
    : BackOfficeSnapshotSchema.parse(response);
  await requireBackOfficePrincipal(config, principal);
  return snapshot;
}
export async function syncBackOffice(config: ServerConfig): Promise<void> {
  const connection = await readEigenweltConnection(config);
  if (!connection.account || !connection.platformURL || !connection.platformToken) return;
  const initialPrincipal = backOfficePrincipalKey(connection.platformURL, connection.account.orgId, connection.account.userId);
  const key = `${config.configPath}:${initialPrincipal}`;
  return rounds.run(key, async () => {
    let scope: string;
    let actor: BackOfficeActor;
    try {
      ({ scope, actor } = await backOfficeAccess(config, true));
      if (actor.principalKey !== initialPrincipal) return;
    } catch (error) {
      if (error instanceof ApiError && error.status === 403)
        (await backOfficeStore(config)).suspendAccount(
          connection.account!.orgId,
          initialPrincipal,
          error.message,
          initialPrincipal,
        );
      return;
    }
    const store = await backOfficeStore(config);
    try {
      store.restrictTeamAccess(scope, actor);
      const before = store.syncState(scope, actor);
      const replicaBefore = store.replicaId(scope);
      const batch = firstSyncBatch(store, scope, actor);
      // Every queued project reference must name a project already shared with this firm.
      const links = await projectSyncStore(config);
      for (const change of batch) {
        if (change.kind !== "record") continue;
        const record = BackOfficeRecordSchema.parse(change.data);
        if (record.objectId !== "projectLinks") continue;
        const localId = record.values.projectId;
        const project =
          typeof localId === "string" ? links.linkByWorkspace(localId) : null;
        if (project && project.orgId === scope) {
          record.values.projectId = project.projectId;
          change.data = record;
        } else if (typeof localId === "string" && localId.startsWith("ws_"))
          throw new ApiError(
            409,
            "back_office_project_sync",
            "Share the linked project before sending this matter link to the team.",
          );
      }
      let accepted = false, conflicted = false;
      do {
        // A file field must exist on the platform before its bytes are prepared.
        // Preserve operation order while splitting model changes from record batches.
        const modelIndex = batch.findIndex((change) => change.kind === "model");
        const chunk = batch.splice(
          0,
          modelIndex === 0 ? 1 : modelIndex > 0 ? modelIndex : batch.length,
        );
        store.requireAccount(scope, actor);
        await syncRecordFiles(config, chunk, actor.principalKey);
        store.requireAccount(scope, actor);
        const baseline = [...store.records(scope, actor), ...store.records(scope, actor, undefined, true)];
        const snapshot = await backOfficePlatform(config, chunk, actor.principalKey, baseline);
        const localLinks = links.links().filter((link) => link.orgId === scope);
        for (const record of snapshot.records.filter(
          (record) => record.objectId === "projectLinks",
        )) {
          const local = localLinks.find(
            (link) => link.projectId === record.values.projectId,
          );
          if (local) record.values.projectId = local.workspaceId;
        }
        const replicaId = store.receive(scope, snapshot, actor);
        if (replicaId) actor = { ...actor, replicaId };
        accepted ||= snapshot.accepted.length > 0;
        conflicted ||= snapshot.conflicts.length > 0;
        if (
          snapshot.conflicts.length ||
          snapshot.accepted.length < chunk.length
        )
          break;
      } while (batch.length);
      store.requireAccount(scope, actor);
      const staged = stageFirstSync(store, scope, actor, new Set(links.links().filter(link => link.orgId === scope && link.state === "active").flatMap(link => [link.workspaceId, link.projectId])));
      if (staged || ((accepted || conflicted) && firstSyncBatch(store, scope, actor).length > 0))
        scheduleBackOfficeSync(config);
      await connectFirstSyncProjects(config, store, scope, actor, backOfficeDirectoryKey(connection.platformURL!, scope));
      retryDelay.delete(config.configPath ?? "default");
      const after = store.syncState(scope, actor);
      if (accepted || staged || before.cursor !== after.cursor || before.pending !== after.pending ||
          before.enabled !== after.enabled || before.error !== after.error || replicaBefore !== store.replicaId(scope))
        announceSyncChange(config, "backOffice");
    } catch (error) {
      if (await connectedBackOfficePrincipal(config) !== initialPrincipal) return;
      if (actor.replicaId && actor.replicaId !== store.replicaId(scope)) return;
      if (error instanceof ApiError && ["back_office_replica_changed", "back_office_snapshot_stale"].includes(error.code)) return;
      const message =
        error instanceof Error
          ? error.message
          : "The team directory is temporarily unavailable.";
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403)
      )
        store.suspendTeam(scope, message);
      else {
        store.syncError(scope, message);
        const key = config.configPath ?? "default";
        const delay = Math.min((retryDelay.get(key) ?? 1000) * 2, 60_000);
        retryDelay.set(key, delay);
        scheduleBackOfficeSync(config, delay);
      }
    }
  });
}
const retryDelay = new Map<string, number>();
export function cancelScheduledBackOfficeSync(config: ServerConfig) {
  const key = config.configPath ?? "default";
  retryDelay.delete(key);
  clearTimeout(scheduled.get(key));
  scheduled.delete(key);
}
export function scheduleBackOfficeSync(config: ServerConfig, delay = 1000) {
  const key = config.configPath ?? "default";
  if (scheduled.has(key)) return;
  const timer = setTimeout(() => {
    scheduled.delete(key);
    void syncBackOffice(config).catch(error => console.warn("[back-office] Background sync failed", error instanceof Error ? error.message : "unknown error"));
  }, delay);
  timer.unref?.();
  scheduled.set(key, timer);
}
// Compatibility for clients which still use the two-step publish endpoints.
const publishPlans = new Map<string, { principal: string; selection: string | null; revision: number; expires: number }>();
export async function previewBackOfficePublish(config: ServerConfig) {
  const { scope, actor } = await backOfficeAccess(config, true), store = await backOfficeStore(config);
  store.requireAccount(scope, actor);
  const { selection } = firstSyncStatus(store, actor);
  const records = unknownRecords(store).map(row => store.raw("local", String(row.id))!);
  const team = store.records(scope, actor);
  const planId = randomUUID(), now = Date.now();
  for (const [id, plan] of publishPlans) if (plan.expires < now) publishPlans.delete(id);
  const local = store.model("local"), shared = store.model(scope);
  publishPlans.set(planId, { principal: backOfficeAuthorKey(actor), selection, revision: local.revision, expires: now + 600000 });
  return { planId, count: records.length,
    records: records.map(record => ({ id: record.id, objectId: record.objectId, name: record.values.name,
      duplicate: team.some(other => other.objectId === record.objectId && other.values.name === record.values.name) })),
    needsModelUpdate: records.length > 0 && JSON.stringify(mergePublishModel(local, shared).objects) !== JSON.stringify(shared.objects),
  };
}
export async function publishBackOffice(config: ServerConfig, planId: string) {
  const { scope, actor } = await backOfficeAccess(config, true), store = await backOfficeStore(config);
  const plan = publishPlans.get(planId);
  if (!actor.edit || !plan || plan.principal !== backOfficeAuthorKey(actor) || plan.expires < Date.now() || plan.revision !== store.model("local").revision)
    throw new ApiError(409, "back_office_publish", "Preview publishing your directory again.");
  if (plan.selection) assignLocalRecords(store, scope, actor, plan.selection);
  publishPlans.delete(planId);
  await syncBackOffice(config);
  await refreshBackOfficeActor(config, scope, actor);
  return store.syncState(scope, actor);
}

export async function signOutBackOffice(
  config: ServerConfig,
  options: { force: boolean; apply: boolean },
) {
  const connection = await readEigenweltConnection(config),
    scope = connection?.account?.orgId;
  const account = connection.account;
  if (!scope || !account || !connection.platformURL) return 0;
  let store;
  try {
    store = await existingBackOfficeStore(config);
    if (!store) return 0;
    store.checkIntegrity();
  } catch {
    // Preserve blocked Back Office evidence; do not turn its integrity error
    // into an app-wide sign-out lock. Connection cleanup also fails closed.
    console.warn("[back-office] Back Office is blocked; its preserved data will not prevent account sign-out.");
    return 0;
  }
  const replicaId = store.replicaId(scope);
  const principalKey = backOfficePrincipalKey(connection.platformURL, scope, account.userId);
  await syncBackOffice(config);
  if (await connectedBackOfficePrincipal(config) !== principalKey) return 0;
  if (store.replicaId(scope) !== replicaId) return 0;
  const actor: BackOfficeActor = { userId: account.userId, principalKey, edit: false, model: false, finance: false };
  const pending = store.accountPendingCount(scope, actor);
  if (pending && !options.force) return pending;
  if (options.apply) store.clearTeam(scope, actor);
  return 0;
}
