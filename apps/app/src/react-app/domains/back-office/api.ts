import type { QueryClient } from "@tanstack/react-query";
import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { z } from "@legalwork/types/back-office";
import {
  BackOfficeModelSchema,
  BackOfficeRecordSchema,
  BackOfficeViewSchema,
} from "@legalwork/types/back-office";
import { t } from "@/i18n";
export const BackOfficeStateSchema = z.object({
  scope: z.string().default("local"),
  directoryId: z.string().optional(),
  model: BackOfficeModelSchema,
  records: z.array(BackOfficeRecordSchema),
  views: z.array(BackOfficeViewSchema),
  permissions: z.object({
    userId: z.string(),
    principalKey: z.string().optional(),
    replicaId: z.string().optional(),
    model: z.boolean(),
    edit: z.boolean(),
    finance: z.boolean(),
  }),
  localChoices: z.array(BackOfficeRecordSchema).optional(),
  localRows: z.array(BackOfficeRecordSchema).optional(),
  firstSync: z.object({ unassigned: z.number(), selection: z.string().nullable(), waiting: z.number(), firm: z.string() }).optional(),
  sync: z.object({
    enabled: z.boolean(),
    cursor: z.number(),
    pending: z.number(),
    error: z.string().nullable(),
  }),
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const recordIndex = z.array(z.tuple([z.string().uuid(), digest]));
const manifestSchema = BackOfficeStateSchema.omit({ records: true }).extend({
  version: digest, index: recordIndex.nullable(),
});
const pageSchema = z.object({
  directoryId: z.string(), permissions: BackOfficeStateSchema.shape.permissions,
  rows: z.array(z.object({ record: BackOfficeRecordSchema, digest })),
});
export type BackOfficeState = z.infer<typeof BackOfficeStateSchema> & {
  transfer?: { version: string; index: z.infer<typeof recordIndex> };
};

// A replica identifies a replaceable read cache. Writes target the directory and
// account, and the server checks current record and field access on every request.
export async function writeBackOfficeRecord(client: Pick<LegalworkServerClient, "backOffice">, state: BackOfficeState, values: Record<string, unknown>) {
  if (!state.directoryId) throw new Error(t("back_office.write.account_unavailable"));
  const body = { ...values, directoryId: state.directoryId, expectedUserId: state.permissions.userId, expectedPrincipalKey: state.permissions.principalKey };
  const post = () => client.backOffice("/records", { method: "POST", body });
  for (let attempt = 0; ; attempt++) {
    try { return await post(); }
    catch (error) {
      if (!(error instanceof LegalworkServerError)) throw error;
      // Retry only a retired server read context, always with the original identity.
      if (!attempt && error.code === "back_office_replica_changed") continue;
      if (["back_office_account_changed", "back_office_directory_changed", "back_office_permissions_changed"].includes(error.code))
        throw new Error(t("back_office.write.account_unavailable"));
      throw error;
    }
  }
}

export async function applySavedRecord(cache: QueryClient, baseUrl: string, state: BackOfficeState, record: z.infer<typeof BackOfficeRecordSchema>, localCopy = false) {
  const filter = { queryKey: ["back-office", baseUrl, "auto"], predicate: (query: { queryKey: readonly unknown[] }) => query.queryKey.length <= 4 };
  await cache.cancelQueries(filter);
  cache.setQueriesData<BackOfficeState>(filter, previous => {
    if (!previous || previous.directoryId !== state.directoryId || previous.permissions.userId !== state.permissions.userId ||
        previous.permissions.principalKey !== state.permissions.principalKey || previous.permissions.replicaId !== state.permissions.replicaId) return previous;
    const field = localCopy ? "localRows" : "records";
    const list = previous[field] ?? [];
    const latest = list.find(row => row.id === record.id);
    if (latest && latest.revision > record.revision) return previous;
    const rows = list.filter(row => row.id !== record.id);
    const transfer = previous.transfer && !localCopy ? { version: "", index: previous.transfer.index.filter(([id]) => id !== record.id) } : previous.transfer;
    return { ...previous, transfer, [field]: record.archivedAt ? rows : [...rows, record], ...(localCopy && previous.localChoices ? { localChoices: [...previous.localChoices.filter(row => row.id !== record.id), ...(record.archivedAt ? [] : [record])] } : {}) };
  });
  void cache.invalidateQueries({ queryKey: ["back-office", baseUrl] }, { cancelRefetch: false });
}

/** Publish the new directory only after every changed page matches its manifest. */
export async function loadBackOfficeState(client: Pick<LegalworkServerClient, "backOffice">, previous?: BackOfficeState, signal?: AbortSignal, archivedObject?: string, pendingLocalObject?: string): Promise<BackOfficeState> {
  const scopeQuery = archivedObject ? "&archivedObject=" + encodeURIComponent(archivedObject) : "";
  const localQuery = pendingLocalObject ? "&pendingLocalObject=" + encodeURIComponent(pendingLocalObject) : "";
  const manifest = (known: string) => client.backOffice(`?manifest=1&known=${known}${scopeQuery}${localQuery}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const known = previous?.transfer?.version ?? "";
    const response = await manifest(known);
    if (response && typeof response === "object" && "records" in response) {
      const state = BackOfficeStateSchema.parse(response);
      if (!archivedObject) return state;
      const archived = await client.backOffice(`/records/${encodeURIComponent(archivedObject)}?archived=true`, { team: state.scope !== "local" });
      return { ...state, ...BackOfficeStateSchema.pick({records:true}).parse(archived) };
    }
    const { version, index, ...metadata } = manifestSchema.parse(response);
    if (index === null) {
      if (previous?.transfer?.version === version) return { ...metadata, records: previous.records, transfer: previous.transfer };
      previous = undefined;
      continue;
    }
    const sameDirectory = previous?.directoryId === metadata.directoryId
      && previous?.permissions.userId === metadata.permissions.userId
      && previous?.permissions.principalKey === metadata.permissions.principalKey
      && previous?.permissions.replicaId === metadata.permissions.replicaId;
    const oldHashes = new Map(sameDirectory ? previous?.transfer?.index : []);
    const oldRecords = new Map((sameDirectory ? previous?.records ?? [] : []).map(row => [row.id, row]));
    const next = new Map<string, z.infer<typeof BackOfficeRecordSchema>>();
    const needed = index.filter(([id, hash]) => {
      const old = oldRecords.get(id);
      if (!old || oldHashes.get(id) !== hash) return true;
      next.set(id, old);
      return false;
    });
    for (let offset = 0; offset < needed.length; offset += 100) {
      signal?.throwIfAborted();
      const batch = needed.slice(offset, offset + 100);
      const page = pageSchema.parse(await client.backOffice(`/record-page?ids=${batch.map(([id]) => id).join(",")}${scopeQuery}`));
      if (page.directoryId !== metadata.directoryId || JSON.stringify(page.permissions) !== JSON.stringify(metadata.permissions)) break;
      const expected = new Map(batch);
      for (const { record, digest } of page.rows) {
        if (expected.get(record.id) === digest) next.set(record.id, record);
      }
      if (batch.some(([id]) => !next.has(id))) break;
    }
    if (next.size !== index.length) continue;
    if (needed.length) {
      signal?.throwIfAborted();
      const confirmed = manifestSchema.parse(await manifest(version));
      if (confirmed.version !== version || confirmed.index !== null) continue;
      const { index: _index, version: _version, ...currentMetadata } = confirmed;
      return { ...currentMetadata, records: index.map(([id]) => next.get(id)!), transfer: { version, index } };
    }
    return { ...metadata, records: index.map(([id]) => next.get(id)!), transfer: { version, index } };
  }
  // Heavy write traffic can invalidate both paged reads. Fetch one coherent
  // snapshot without asking the person editing to reload.
  return BackOfficeStateSchema.parse(await client.backOffice(`?snapshot=1${scopeQuery}${localQuery}`));
}

export const ModelPreviewSchema = z.object({
  changes: z.array(
    z.object({ object: z.string(), action: z.string(), records: z.number() }),
  ),
  valid: z.boolean(),
  errors: z.array(z.string()),
});
export type ModelPreview = z.infer<typeof ModelPreviewSchema>;
