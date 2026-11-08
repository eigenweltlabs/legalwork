import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { z } from "@legalwork/types/back-office";
import {
  BackOfficeModelSchema,
  BackOfficeRecordSchema,
  BackOfficeViewSchema,
} from "@legalwork/types/back-office";
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

/** Publish the new directory only after every changed page matches its manifest. */
export async function loadBackOfficeState(client: Pick<LegalworkServerClient, "backOffice">, previous?: BackOfficeState, signal?: AbortSignal, archivedObject?: string): Promise<BackOfficeState> {
  const scopeQuery = archivedObject ? "&archivedObject=" + encodeURIComponent(archivedObject) : "";
  const manifest = (known: string) => client.backOffice(`?manifest=1&known=${known}${scopeQuery}`);
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
      throw new Error("The directory changed while loading.");
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
  throw new Error("The directory changed while loading. Refresh to try again.");
}

export const ModelPreviewSchema = z.object({
  changes: z.array(
    z.object({ object: z.string(), action: z.string(), records: z.number() }),
  ),
  valid: z.boolean(),
  errors: z.array(z.string()),
});
export type ModelPreview = z.infer<typeof ModelPreviewSchema>;
