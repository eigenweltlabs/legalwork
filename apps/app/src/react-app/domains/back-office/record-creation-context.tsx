import { createContext, useContext, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z, BackOfficeRecordSchema, validateBackOfficeValues, type BackOfficeRecord } from "@legalwork/types/back-office";
import { matchesProjectReferenceFilters, type ProjectReferenceFilters } from "@legalwork/types/workspace";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { applySavedRecord, writeBackOfficeRecord, type BackOfficeState } from "./api";
import { creatableRecordObject } from "./record-creation-values";

export type LocalSource = { id: string; objectId: string; fields: string[] };
export const LocalCreationScope = createContext<LocalSource | undefined>(undefined);

type CreationContext = {
  client: LegalworkServerClient;
  state: BackOfficeState;
  create: (record: BackOfficeRecord, filters?: ProjectReferenceFilters | null, localSource?: LocalSource) => Promise<BackOfficeRecord>;
};
const Context = createContext<CreationContext | null>(null);
export const useRecordCreation = () => useContext(Context);

export function RecordCreationProvider({ client, state, children }: { client?: LegalworkServerClient | null; state?: BackOfficeState; children: ReactNode }) {
  const cache = useQueryClient();
  const identity = JSON.stringify([client?.baseUrl, state?.directoryId, state?.permissions.userId, state?.permissions.principalKey, state?.model.revision, state?.permissions.model, state?.permissions.edit, state?.permissions.finance]);
  return <Context.Provider key={identity} value={client && state ? { client, state, create: async (record, filters, localSource) => {
    const object = creatableRecordObject(state, record.objectId);
    if (!object) throw new Error(t("back_office.create.unavailable"));
    validateBackOfficeValues(object, record.values);
    if (!matchesProjectReferenceFilters(record, object, filters)) throw new Error(t("back_office.create.filter_mismatch"));
    const result = z.object({ record: BackOfficeRecordSchema }).parse(await writeBackOfficeRecord(client, state, {
      localSource, id: record.id, create: true, objectId: object.id, revision: 0, values: record.values,
    }));
    await applySavedRecord(cache, client.baseUrl, state, result.record, Boolean(localSource));
    return result.record;
  } } : null}>{children}</Context.Provider>;
}
