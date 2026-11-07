import { randomUUID } from "node:crypto";
import { ApiError } from "../errors.js";
import { intakeRequest, requireIntakeClient } from "../eigenwelt-intake.js";
import { ensureFreshPlatformToken } from "../eigenwelt-refresh.js";
import { syncBackOffice } from "./sync.js";
import { connectedBackOfficePrincipal, requireBackOfficePrincipal } from "./accounts.js";
import type { ServerConfig } from "../types.js";
import type { BackOfficeStore } from "./store.js";
import {
  BackOfficeModelSchema,
  BackOfficeStoredRecordSchema,
  BackOfficeRecordSchema,
  pageBackOfficeHistory,
  readableBackOfficeHistory,
  BackOfficeHistoryPageSchema,
  BackOfficeHistoryExportSchema,
  type BackOfficeActor,
  type BackOfficeHistoryTarget,
} from "./schema.js";
import {
  signBackOfficeHistoryExport,
  verifyBackOfficeHistoryExport,
} from "./history-export.js";

function localHistory(
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
  target: BackOfficeHistoryTarget,
) {
  store.model(scope);
  store.journal.storage.acquire();
  try {
    store.db.exec("BEGIN");
    try {
      store.journal.verify();
      if (target.type === "model" && !actor.model)
        throw new ApiError(
          403,
          "back_office_history",
          "Model administrator permission is required.",
        );
      if (target.type === "record") {
        const record = store.raw(scope, target.id);
        if (!record || !store.canRead(scope, record, actor))
          throw new ApiError(
            404,
            "back_office_history",
            "The record history is unavailable.",
          );
      }
      const row = store.db.get("SELECT data FROM bo_models WHERE scope=?", [
        scope,
      ]);
      const model = BackOfficeModelSchema.parse(JSON.parse(String(row?.data)));
      const views = store.views(scope);
      if (target.type === "view") {
        const view = views.find((view) => view.id === target.id);
        if (
          !view ||
          (!actor.finance &&
            ["feeAgreements", "billingItems", "invoices"].includes(
              view.objectId,
            ))
        )
          throw new ApiError(
            404,
            "back_office_history",
            "The view history is unavailable.",
          );
      }
      const records = store.db
        .all("SELECT data FROM bo_records WHERE scope=?", [scope])
        .map((row) =>
          BackOfficeStoredRecordSchema.parse(JSON.parse(String(row.data))),
        );
      const projectIds = new Set(
        records
          .filter(
            (record) =>
              record.objectId === "projectLinks" &&
              store.canRead(scope, BackOfficeRecordSchema.parse(record), actor),
          )
          .flatMap((record) =>
            typeof record.values.projectId === "string"
              ? [record.values.projectId]
              : [],
          ),
      );
      const evidence = store.journal.evidence(scope);
      const items = readableBackOfficeHistory({
        entries: evidence.entries,
        model,
        records,
        views,
        actor,
        target,
        projectIds,
      });
      store.db.exec("COMMIT");
      return { ...evidence, items };
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    store.journal.storage.release();
  }
}

export function localBackOfficeHistoryPage(
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
  target: BackOfficeHistoryTarget,
  limit = 50,
  cursor?: string | null,
) {
  const evidence = localHistory(store, scope, actor, target);
  try {
    return {
      ...pageBackOfficeHistory(evidence.items, limit, cursor),
      heads: evidence.heads,
      source: "local",
      independentlyAcknowledged: false,
    };
  } catch (error) {
    throw new ApiError(
      409,
      "back_office_history_cursor",
      error instanceof Error ? error.message : "Refresh the history.",
    );
  }
}

export function localBackOfficeHistoryExport(
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
  target: BackOfficeHistoryTarget,
) {
  const evidence = localHistory(store, scope, actor, target);
  return signBackOfficeHistoryExport(
    {
      format: "legalwork.back-office.history.v2",
      exportId: randomUUID(),
      exportedAt: new Date().toISOString(),
      scope,
      target,
      source: "local",
      exportedBy: store.journal.actor(actor),
      heads: evidence.heads,
      proofs: evidence.proofs,
      items: evidence.items,
      withheldPayloads:
        evidence.proofs.length -
        evidence.items.filter((item) => item.payload !== null).length,
    },
    store.journal.storage.identity,
  );
}

/** Shared history always uses the platform's current permissions and authors.
 * An old or unreachable platform never causes a fallback to stale team data. */
export async function platformBackOfficeHistory(
  config: ServerConfig,
  store: BackOfficeStore,
  scope: string,
  target: BackOfficeHistoryTarget,
  options: { limit: number; cursor: string | null; export: boolean },
  expectedPrincipal?: string,
) {
  const principal = expectedPrincipal ?? await connectedBackOfficePrincipal(config);
  if (!principal) throw new ApiError(403, "back_office_firm", "Sign in to your firm to open team history.");
  await ensureFreshPlatformToken(config);
  const connection = await requireBackOfficePrincipal(config, principal);
  if (connection.account?.orgId !== scope)
    throw new ApiError(409, "back_office_account_changed", "The requested directory belongs to another connected account.");
  const client = requireIntakeClient(connection);
  const query = new URLSearchParams({
    type: target.type,
    id: target.id,
    limit: String(options.limit),
    export: String(options.export),
  });
  if (options.cursor) query.set("cursor", options.cursor);
  try {
    const result = await intakeRequest(
      client,
      "GET",
      `/api/back-office/history?${query}`,
    );
    await requireBackOfficePrincipal(config, principal);
    if (options.export) {
      const exported = BackOfficeHistoryExportSchema.parse(result);
      verifyBackOfficeHistoryExport(exported);
      if (
        exported.body.scope !== scope ||
        exported.body.target.type !== target.type ||
        exported.body.target.id !== target.id ||
        exported.body.source !== "platform"
      )
        throw new Error(
          "The shared history export belongs to a different target.",
        );
      return exported;
    }
    return BackOfficeHistoryPageSchema.parse(result);
  } catch (error) {
    if (await connectedBackOfficePrincipal(config) !== principal) throw error;
    if (error instanceof ApiError && error.status === 401)
      store.suspendAccount(scope, principal, error.message, principal);
    else if (
      error instanceof ApiError &&
      (error.status === 403 || error.status === 404)
    ) {
      // A history-only permission denial must not disconnect a person who can
      // still use the directory. The normal sync confirms wider revocation.
      await syncBackOffice(config);
    }
    throw error;
  }
}
