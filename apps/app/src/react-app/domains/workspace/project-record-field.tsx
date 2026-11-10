import { RecordCreationProvider } from "../back-office/record-creation-context";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { BackOfficeFieldSchema, isInternalBackOfficeObject, type BackOfficeValue } from "@legalwork/types/back-office";
import type { ProjectField, ProjectRecordReference } from "@legalwork/types/workspace";
import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { projectErrorMessage } from "./project-errors";
import { t } from "@/i18n";
import { onSyncPoke } from "@/react-app/kernel/sync-events";
import "../back-office/back-office.css";
import { loadBackOfficeState, type BackOfficeState } from "../back-office/api";
import { rememberMatter } from "./matter-picker-options";
import { projectQuickActionLabel } from "./project-connections";
import { ObjectIcon } from "../back-office/object-icon";
import { projectFieldLabel } from "./project-defaults-store";
import { RecordCreateRelation } from "../back-office/record-create-relation";
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
type SaveReference = (value: ProjectRecordReference | null) => Promise<void>;

export function ProjectRecordField({ field, client, onSave }: {
  field: RecordField; client?: LegalworkServerClient | null; onSave: SaveReference;
}) {
  const directory = useProjectBackOffice(client), navigate = useNavigate();
  const data = directory.data, object = projectReferenceObjects(data).find(object => object.id === field.objectId);
  const [edit, setEdit] = useState<{ field: RecordField; value: BackOfficeValue; onSave: SaveReference; directoryId: string } | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [creating, setCreating] = useState(false), [conflict, setConflict] = useState(false);
  const saving = useRef(false);
  const scope = JSON.stringify([client?.baseUrl, data?.directoryId, data?.permissions.userId, data?.permissions.principalKey, data?.permissions.replicaId]);
  useEffect(() => { setEdit(null); setError(""); setConflict(false); }, [scope]);
  const begin = () => {
    if (!data?.directoryId) return;
    setEdit({ field, value: field.value?.directoryId === data.directoryId ? field.value.recordIds : [], onSave, directoryId: data.directoryId });
    setError(""); setConflict(false);
  };
  const save = async (value: ProjectRecordReference | null, persist: SaveReference, close = false) => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try {
      await persist(value);
      if (close) {
        if (edit?.field.objectId === "matters") value?.recordIds.forEach(id => rememberMatter(scope, id));
        setEdit(null);
      }
    }
    catch (error) { setConflict(error instanceof LegalworkServerError && error.code === "project_changed"); setError(projectErrorMessage(error)); }
    finally { saving.current = false; setBusy(false); }
  };
  const apply = () => {
    if (!edit || creating || conflict) return;
    const ids = Array.isArray(edit.value) ? edit.value.filter(item => typeof item === "string") : typeof edit.value === "string" ? [edit.value] : [];
    void save(ids.length ? { directoryId: edit.directoryId, recordIds: ids } : null, edit.onSave, true);
  };
  const records = data?.records ?? [], label = projectFieldLabel(field);
  const foreign = Boolean(field.value && field.value.directoryId !== data?.directoryId);
  return <RecordCreationProvider client={client} state={data}>
    <Popover open={edit !== null} onOpenChange={open => { if (saving.current) return; if (open) begin(); else setEdit(null); }}>
      <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-1">
        {field.value?.recordIds.map(id => {
          const record = !foreign ? records.find(record => record.id === id && record.objectId === field.objectId) : undefined;
          const name = record ? String(record.values.name) : t("projects.reference.unavailable");
          return <span key={id} className="inline-flex max-w-full min-w-0 items-center gap-0.5 rounded-md border bg-muted/30 py-0.5 pl-1 pr-0.5">
            <PopoverTrigger render={<Button type="button" size="sm" variant="ghost" className="h-6 min-w-0 shrink justify-start px-1.5 text-xs font-normal" disabled={busy || foreign || !object || !data?.directoryId} aria-label={`${t("projects.edit_value", { name: label })}: ${name}`} title={name}><span className="truncate">{name}</span></Button>} />
            {record && <Button type="button" size="icon-xs" variant="ghost" className="shrink-0" aria-label={t("projects.reference.open_record", { name })} title={t("projects.reference.open_record", { name })} onClick={() => navigate(`/back-office/${encodeURIComponent(record.objectId)}?record=${record.id}`)}><ArrowUpRight className="size-3" /></Button>}
            <Button type="button" size="icon-xs" variant="ghost" className="shrink-0" disabled={busy} aria-label={t("projects.remove_reference", { name, field: label })} title={t("projects.remove_reference", { name, field: label })} onClick={() => {
              if (!field.value) return;
              const remaining = field.value.recordIds.filter(recordId => recordId !== id);
              void save(remaining.length ? { ...field.value, recordIds: remaining } : null, onSave);
            }}><X className="size-3" /></Button>
          </span>;
        })}
        {!field.value && <PopoverTrigger render={field.quickAction
          ? <Button type="button" size="sm" variant="outline" disabled={busy || !object || !data?.directoryId}><ObjectIcon id={field.objectId} size={14} />{projectQuickActionLabel(field)}</Button>
          : <Button type="button" size="sm" variant="ghost" className="h-6 min-w-0 truncate px-1.5 text-xs font-normal" disabled={busy || !object || !data?.directoryId} aria-label={t("projects.edit_value", { name: label })}>{t("projects.connections.choose_records")}<ChevronDown className="size-3" /></Button>} />}
        {!edit && error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      </div>
      <PopoverContent align="start" className="w-[min(400px,calc(100vw-32px))] max-h-[70vh] overflow-y-auto p-2">
        {edit && <RecordCreateRelation inline field={BackOfficeFieldSchema.parse({ id: "projectReference", label: projectFieldLabel(edit.field), type: "relation", target: edit.field.objectId, multiple: edit.field.multiple })}
          value={edit.value} creationFilters={edit.field.filters} disabled={busy} onChange={value => setEdit(current => current ? { ...current, value } : null)} onCreatingChange={setCreating} onSubmit={apply} />}
        {error && <p role="alert" className="p-2 text-xs text-destructive">{error}</p>}
        {conflict && <Button type="button" variant="outline" size="sm" onClick={begin}>{t("projects.reload_fields")}</Button>}
        {!creating && <div className="mt-2 flex justify-end gap-2 border-t pt-2"><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setEdit(null)}>{t("projects.cancel")}</Button><Button type="button" size="sm" disabled={busy || conflict} onClick={apply}>{t("projects.save")}</Button></div>}
      </PopoverContent>
    </Popover>
  </RecordCreationProvider>;
}
