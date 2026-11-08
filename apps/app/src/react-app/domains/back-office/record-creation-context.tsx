import { createContext, useContext, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z, BackOfficeRecordSchema, validateBackOfficeValues, type BackOfficeRecord } from "@legalwork/types/back-office";
import { matchesProjectReferenceFilters, type ProjectReferenceFilters } from "@legalwork/types/workspace";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { BackOfficeStateSchema, type BackOfficeState } from "./api";
import { creatableRecordObject } from "./record-creation-values";

type CreationContext = {
  client: LegalworkServerClient;
  state: BackOfficeState;
  create: (record: BackOfficeRecord, filters?: ProjectReferenceFilters | null) => Promise<BackOfficeRecord>;
};
const Context = createContext<CreationContext | null>(null);
export const useRecordCreation = () => useContext(Context);

export function RecordCreationProvider({ client, state, children }: { client?: LegalworkServerClient | null; state?: BackOfficeState; children: ReactNode }) {
  const cache = useQueryClient();
  const identity = JSON.stringify([client?.baseUrl, state?.directoryId, state?.permissions.userId, state?.permissions.principalKey, state?.permissions.replicaId, state?.permissions.edit, state?.permissions.finance]);
  return <Context.Provider key={identity} value={client && state ? { client, state, create: async (record, filters) => {
    const current = BackOfficeStateSchema.parse(await client.backOffice(""));
    if (!state.directoryId || current.directoryId !== state.directoryId || current.permissions.userId !== state.permissions.userId || current.permissions.principalKey !== state.permissions.principalKey || current.permissions.replicaId !== state.permissions.replicaId) throw new Error(t("back_office.create.directory_changed"));
    const object = creatableRecordObject(current, record.objectId);
    if (!object) throw new Error(t("back_office.create.unavailable"));
    validateBackOfficeValues(object, record.values);
    if (!matchesProjectReferenceFilters(record, object, filters)) throw new Error(t("back_office.create.filter_mismatch"));
    const result = z.object({ record: BackOfficeRecordSchema }).parse(await client.backOffice("/records", {
      method: "POST", team: current.scope !== "local", body: { id: record.id, create: true, objectId: object.id, revision: 0, values: record.values, directoryId: state.directoryId },
    }));
    cache.setQueryData<BackOfficeState>(["back-office", client.baseUrl, "auto"], previous => previous && previous.directoryId === state.directoryId ? { ...previous, records: [...previous.records.filter(item => item.id !== result.record.id), result.record] } : previous);
    void cache.invalidateQueries({ queryKey: ["back-office", client.baseUrl] });
    return result.record;
  } } : null}>{children}</Context.Provider>;
}
