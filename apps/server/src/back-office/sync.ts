import { createHash, randomUUID } from "node:crypto";
import { syncRecordFiles } from "./file-sync.js";
import { backOfficeAccess } from "./access.js";
import { backOfficeStore } from "./store.js";
import { mergePublishModel } from "./publish-model.js";
import {
  BackOfficeChangeSchema,
  BackOfficeRecordSchema,
  BackOfficeSnapshotSchema,
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
import { backOfficeAuthorKey, backOfficePrincipalKey } from "./principal.js";

const rounds = new BackOfficeSyncRounds(),
  scheduled = new Map<string, ReturnType<typeof setTimeout>>();
export async function backOfficePlatform(
  config: ServerConfig,
  changes: unknown[] = [],
  expectedPrincipal?: string,
): Promise<BackOfficeSnapshot> {
  const principal = expectedPrincipal ?? await connectedBackOfficePrincipal(config);
  if (!principal) throw new ApiError(403, "back_office_firm", "Sign in to your firm to open team records.");
  await ensureFreshPlatformToken(config);
  const client = requireIntakeClient(await requireBackOfficePrincipal(config, principal));
  const snapshot = BackOfficeSnapshotSchema.parse(
    await intakeRequest(client, "POST", "/api/back-office", {
      protocol: 1,
      changes,
      cursor: 0,
    }),
  );
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
    if (!store.syncState(scope).enabled) return;
    try {
      store.restrictTeamAccess(scope, actor);
      const pending = store.pending(scope, 100, actor),
        firstBlocked = pending.findIndex((entry) => entry.error);
      const batch = pending
        .slice(0, firstBlocked < 0 ? pending.length : firstBlocked)
        .map((entry) => BackOfficeChangeSchema.parse(entry.change));
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
      let accepted = false;
      do {
        // A file field must exist on the platform before its bytes are prepared.
        // Preserve operation order while splitting model changes from record batches.
        const modelIndex = batch.findIndex((change) => change.kind === "model");
        const chunk = batch.splice(
          0,
          modelIndex === 0 ? 1 : modelIndex > 0 ? modelIndex : batch.length,
        );
        await syncRecordFiles(config, chunk, actor.principalKey);
        const snapshot = await backOfficePlatform(config, chunk, actor.principalKey);
        const localLinks = links.links().filter((link) => link.orgId === scope);
        for (const record of snapshot.records.filter(
          (record) => record.objectId === "projectLinks",
        )) {
          const local = localLinks.find(
            (link) => link.projectId === record.values.projectId,
          );
          if (local) record.values.projectId = local.workspaceId;
        }
        store.receive(scope, snapshot, actor);
        accepted ||= snapshot.accepted.length > 0;
        if (
          snapshot.conflicts.length ||
          snapshot.accepted.length < chunk.length
        )
          break;
      } while (batch.length);
      if (accepted && store.pending(scope, 100, actor).some((entry) => !entry.error))
        scheduleBackOfficeSync(config);
      announceSyncChange(config, "backOffice");
    } catch (error) {
      if (await connectedBackOfficePrincipal(config) !== initialPrincipal) return;
      const message =
        error instanceof Error
          ? error.message
          : "The team directory is temporarily unavailable.";
      if (
        error instanceof ApiError &&
        (error.status === 401 || error.status === 403)
      )
        store.suspendTeam(scope, message);
      else store.syncError(scope, message);
    }
  });
}
export function scheduleBackOfficeSync(config: ServerConfig) {
  const key = config.configPath ?? "default";
  if (scheduled.has(key)) return;
  const timer = setTimeout(() => {
    scheduled.delete(key);
    void syncBackOffice(config);
  }, 1000);
  timer.unref?.();
  scheduled.set(key, timer);
}
const publishPlans = new Map<
  string,
  {
    scope: string;
    actor: string;
    revision: number;
    fingerprint: string;
    ids: string[];
    expires: number;
  }
>();
export async function previewBackOfficePublish(config: ServerConfig) {
  const { scope, actor } = await backOfficeAccess(config, true),
    store = await backOfficeStore(config);
  store.setSync(scope, true);
  await syncBackOffice(config);
  const local = store.records("local", {
    userId: "local",
    model: true,
    edit: true,
    finance: true,
  });
  const team = store.records(scope, actor),
    ids = local
      .filter((record) => !team.some((other) => other.id === record.id))
      .map((record) => record.id);
  const teamModel = store.model(scope),
    publishingModel = mergePublishModel(store.model("local"), teamModel);
  const planId = randomUUID();
  for (const [key, plan] of publishPlans)
    if (plan.expires < Date.now()) publishPlans.delete(key);
  publishPlans.set(planId, {
    scope,
    actor: backOfficeAuthorKey(actor),
    revision: store.model("local").revision,
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify(local.map((record) => [record.id, record.revision])),
      )
      .digest("hex"),
    ids,
    expires: Date.now() + 600000,
  });
  return {
    planId,
    count: ids.length,
    records: local
      .filter((record) => ids.includes(record.id))
      .map((record) => ({
        id: record.id,
        objectId: record.objectId,
        name: record.values.name,
        duplicate: team.some(
          (other) =>
            other.objectId === record.objectId &&
            other.values.name === record.values.name,
        ),
      })),
    needsModelUpdate:
      JSON.stringify(publishingModel.objects) !==
      JSON.stringify(teamModel.objects),
  };
}
export async function publishBackOffice(config: ServerConfig, planId: string) {
  const { scope, actor } = await backOfficeAccess(config, true),
    store = await backOfficeStore(config),
    plan = publishPlans.get(planId);
  if (
    !actor.edit ||
    !plan ||
    plan.scope !== scope ||
    plan.actor !== backOfficeAuthorKey(actor) ||
    plan.expires < Date.now() ||
    plan.revision !== store.model("local").revision
  )
    throw new ApiError(
      409,
      "back_office_publish",
      "Preview publishing your directory again.",
    );
  const sourceRecords = store.records("local", {
    userId: "local",
    model: true,
    edit: true,
    finance: true,
  });
  if (
    plan.fingerprint !==
    createHash("sha256")
      .update(
        JSON.stringify(
          sourceRecords.map((record) => [record.id, record.revision]),
        ),
      )
      .digest("hex")
  )
    throw new ApiError(
      409,
      "back_office_publish",
      "Local records changed. Preview publishing again.",
    );
  const local = sourceRecords.filter((record) => plan.ids.includes(record.id));
  if (
    !actor.finance &&
    local.some((record) =>
      ["feeAgreements", "billingItems", "invoices"].includes(record.objectId),
    )
  )
    throw new ApiError(
      403,
      "back_office_finance",
      "Billing permission is required to publish your billing records.",
    );
  const model = store.model(scope),
    source = mergePublishModel(store.model("local"), model);
  if (
    JSON.stringify(model.objects) !== JSON.stringify(source.objects) &&
    !actor.model
  )
    throw new ApiError(
      403,
      "back_office_model",
      "A model administrator must approve the additional fields before publishing.",
    );
  store.transaction(() => {
    if (JSON.stringify(model.objects) !== JSON.stringify(source.objects))
      store.saveModel(
        scope,
        actor,
        { ...source, revision: model.revision },
        model.revision,
      );
    // Create identities first, then attach relations so cyclic contact links remain valid.
    store.stagePublish(scope, actor, local);
    store.setSync(scope, true);
  });
  publishPlans.delete(planId);
  await syncBackOffice(config);
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
  const principalKey = backOfficePrincipalKey(connection.platformURL, scope, account.userId);
  await syncBackOffice(config);
  if (await connectedBackOfficePrincipal(config) !== principalKey) return 0;
  const store = await backOfficeStore(config);
  const actor: BackOfficeActor = { userId: account.userId, principalKey, edit: false, model: false, finance: false };
  const pending = store.syncState(scope, actor).pending;
  if (pending && !options.force) return pending;
  if (options.apply) store.clearTeam(scope, actor);
  return 0;
}
