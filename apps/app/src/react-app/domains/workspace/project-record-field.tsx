import { RecordCreationProvider } from "../back-office/record-creation-context";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ChevronDown, X } from "lucide-react";
import { Button } from "twenty-ui/primitives/input";
import { Popover } from "twenty-ui/primitives/surfaces";
import { BackOfficeFieldSchema, isInternalBackOfficeObject } from "@legalwork/types/back-office";
import { matchesProjectReferenceFilters, type ProjectField, type ProjectRecordReference } from "@legalwork/types/workspace";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { projectErrorMessage } from "./project-errors";
import { t } from "@/i18n";
import { onSyncPoke } from "@/react-app/kernel/sync-events";
import "../back-office/back-office.css";
import { loadBackOfficeState, type BackOfficeState } from "../back-office/api";
import { rememberMatter } from "./matter-picker-options";
import { BackOfficeTheme, DirectoryEditorPopup } from "../back-office/twenty-controls";
import { projectFieldLabel } from "./project-defaults-store";
import { CellEditor } from "../back-office/cell-editor";
import { displayBackOfficeObject } from "../back-office/labels";

export function useProjectBackOffice(client?: LegalworkServerClient | null) {
  const cache = useQueryClient();
  useEffect(() => onSyncPoke(poke => {
    if (poke.backOffice || poke.resync || poke.policy || poke.reload)
      void cache.invalidateQueries({ queryKey: ["back-office", client?.baseUrl] }, { cancelRefetch: Boolean(poke.policy || poke.reload) });
  }), [cache, client?.baseUrl]);
  const query = useQuery({ queryKey: ["back-office", client?.baseUrl, "auto"], queryFn: async ({signal}) => {
    if (!client) throw new Error("Back Office is unavailable.");
    return loadBackOfficeState(client, cache.getQueryData<BackOfficeState>(["back-office", client.baseUrl, "auto"]), signal);
  }, enabled: Boolean(client), retry: false, staleTime: 10_000, refetchInterval: 30_000 });
  return { ...query, data: query.isError ? undefined : query.data };
}

export function projectReferenceObjects(data: ReturnType<typeof useProjectBackOffice>["data"]) {
  return data?.model.objects.filter(object => !object.archived && !isInternalBackOfficeObject(object.id) && (data.permissions.finance || !["feeAgreements", "billingItems", "invoices"].includes(object.id))).map(displayBackOfficeObject) ?? [];
}

type RecordField = Extract<ProjectField, { type: "backoffice" }>;
type SaveReference = (value: ProjectRecordReference | null, previousSelection?: string[]) => Promise<void>;

export function ProjectRecordField({ field, client, onSave }: {
  field: RecordField; client?: LegalworkServerClient | null; onSave: SaveReference;
}) {
  const directory = useProjectBackOffice(client), navigate = useNavigate();
  const data = directory.data, object = projectReferenceObjects(data).find(object => object.id === field.objectId);
  const [edit, setEdit] = useState<{ field: RecordField; directoryId: string; onSave: SaveReference; version: number } | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const scope = JSON.stringify([client?.baseUrl, data?.directoryId, data?.permissions.userId, data?.permissions.principalKey, data?.permissions.edit, data?.permissions.finance, data?.model.revision]);
  useEffect(() => { setEdit(null); setError(""); }, [scope]);
  const foreign = Boolean(field.value && field.value.directoryId !== data?.directoryId);
  const begin = () => {
    if (!object || !data?.directoryId || foreign) return;
    const directoryId = data.directoryId;
    setEdit(current => ({ field, directoryId, onSave, version: (current?.version ?? 0) + 1 }));
    setError("");
  };
  const persist = async (save: SaveReference, value: ProjectRecordReference | null, previous?: string[]) => {
    saving.current = true; setBusy(true); setError("");
    try { await save(value, previous); }
    finally { saving.current = false; setBusy(false); }
  };
  const records = data?.records ?? [], label = projectFieldLabel(field);
  const canEdit = !busy && !foreign && Boolean(object && data?.directoryId);
  const selected = field.value?.recordIds ?? [];
  const selectable = edit && object ? records.filter(record => record.objectId === edit.field.objectId &&
    (selected.includes(record.id) || matchesProjectReferenceFilters(record, object, edit.field.filters))) : [];
  return <RecordCreationProvider client={client} state={data}><BackOfficeTheme>
    <Popover.Root open={edit !== null} onOpenChange={open => { if (!saving.current) { if (open) begin(); else setEdit(null); } }}>
      <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-1">
        {field.value?.recordIds.map(id => {
          const record = !foreign ? records.find(record => record.id === id && record.objectId === field.objectId) : undefined;
          const name = record ? String(record.values.name) : t("projects.reference.unavailable");
          return <span key={id} className="inline-flex max-w-full min-w-0 items-center">
            <Popover.Trigger render={<Button type="button" size="sm" variant="ghost" disabled={!canEdit} title={name} aria-label={`${t("projects.edit_value", { name: label })}: ${name}`} endIcon={<ChevronDown size={12} />}><span className="truncate">{name}</span></Button>} />
            {record && <Button type="button" size="sm" variant="ghost" aria-label={t("projects.reference.open_record", { name })} onClick={() => navigate(`/back-office/${encodeURIComponent(record.objectId)}?record=${record.id}`)} startIcon={<ArrowUpRight size={12} />} />}
            <Button type="button" size="sm" variant="ghost" disabled={busy} aria-label={t("projects.remove_reference", { name, field: label })} onClick={() => {
              if (saving.current || !field.value) return;
              const remaining = field.value.recordIds.filter(recordId => recordId !== id);
              void persist(onSave, remaining.length ? { ...field.value, recordIds: remaining } : null, field.multiple ? field.value.recordIds : undefined).catch(reason => setError(projectErrorMessage(reason)));
            }} startIcon={<X size={12} />} />
          </span>;
        })}
        {!field.value?.recordIds.length && <Popover.Trigger render={<Button type="button" size="sm" variant="ghost" disabled={!canEdit} aria-label={t("projects.edit_value", { name: label })} endIcon={<ChevronDown size={12} />}>{t("projects.empty_value")}</Button>} />}
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
      {edit && <Popover.Portal><Popover.Positioner align="start" sideOffset={4}><DirectoryEditorPopup>
        <div className="min-w-0"><CellEditor key={edit.version}
          field={BackOfficeFieldSchema.parse({ id: "projectReference", label: projectFieldLabel(edit.field), type: "relation", target: edit.field.objectId, multiple: edit.field.multiple })}
          value={edit.field.multiple ? selected : selected[0] ?? null} records={selectable} creationFilters={edit.field.filters}
          projectScope={scope}
          onCancel={() => { if (!saving.current) setEdit(null); }}
          onSave={async (value, previous) => {
            if (edit.directoryId !== data?.directoryId) throw new Error(t("projects.matters.selection_changed"));
            const ids = Array.isArray(value) ? value.filter(item => typeof item === "string") : typeof value === "string" ? [value] : [];
            try { await persist(previous ? onSave : edit.onSave, ids.length ? { directoryId: edit.directoryId, recordIds: ids } : null, previous); }
            catch (reason) {
              throw new Error(projectErrorMessage(reason));
            }
            if (edit.field.objectId === "matters") ids.forEach(id => rememberMatter(scope, id));
          }}
        /></div>
      </DirectoryEditorPopup></Popover.Positioner></Popover.Portal>}
    </Popover.Root>
  </BackOfficeTheme></RecordCreationProvider>;
}
