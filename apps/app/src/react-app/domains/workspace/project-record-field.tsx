import { RecordCreationProvider } from "../back-office/record-creation-context";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover } from "twenty-ui/primitives/surfaces";
import { BackOfficeFieldSchema, isInternalBackOfficeObject } from "@legalwork/types/back-office";
import { matchesProjectReferenceFilters } from "@legalwork/types/workspace";
import type { ProjectField, ProjectRecordReference } from "@legalwork/types/workspace";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { projectErrorMessage } from "./project-errors";
import { t } from "@/i18n";
import { onSyncPoke } from "@/react-app/kernel/sync-events";
import "../back-office/back-office.css";
import { loadBackOfficeState, type BackOfficeState } from "../back-office/api";
import { BackOfficeTheme, DirectoryEditorPopup } from "../back-office/twenty-controls";
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

export function ProjectRecordField({ field, client, onSave }: {
  field: Extract<ProjectField, { type: "backoffice" }>;
  client?: LegalworkServerClient | null;
  onSave: (value: ProjectRecordReference | null) => Promise<void>;
}) {
  const directory = useProjectBackOffice(client), navigate = useNavigate();
  const [open, setOpen] = useState(false), [error, setError] = useState("");
  const data = directory.isError ? undefined : directory.data, object = projectReferenceObjects(data).find(object => object.id === field.objectId);
  const ids = field.value?.directoryId === data?.directoryId ? field.value?.recordIds ?? [] : [];
  const records = data?.records ?? [];
  const selectable = object ? records.filter(record => record.objectId === field.objectId && (ids.includes(record.id) || matchesProjectReferenceFilters(record, object, field.filters))) : [];
  const [busy, setBusy] = useState(false), saving = useRef(false);
  const save = async (value: ProjectRecordReference | null) => {
    if (saving.current) return;
    saving.current = true; setBusy(true); setError("");
    try { await onSave(value); } finally { saving.current = false; setBusy(false); }
  };
  const relation = BackOfficeFieldSchema.parse({ id: "projectReference", label: field.label, type: "relation", target: field.objectId, multiple: field.multiple });
  return <RecordCreationProvider client={client} state={data}><BackOfficeTheme><Popover.Root open={open} onOpenChange={setOpen}><div className="flex min-h-8 min-w-0 flex-wrap items-center gap-1">
    {field.value?.recordIds.map(id => {
      const record = ids.includes(id) ? records.find(record => record.id === id && record.objectId === field.objectId) : null;
      const name = record ? String(record.values.name) : t("projects.reference.unavailable");
      return <span key={id} className="inline-flex max-w-full min-w-0 items-center gap-0.5 rounded-md border bg-muted/30 py-0.5 pl-1 pr-0.5">
        <Popover.Trigger render={<Button type="button" size="sm" variant="ghost" className="h-6 min-w-0 shrink justify-start px-1.5 text-xs font-normal" disabled={busy || !object || !data?.directoryId} aria-label={`${t("projects.edit_value", { name: field.label })}: ${name}`} title={name}><span className="truncate">{name}</span></Button>} />
        {record && <Button type="button" size="icon-xs" variant="ghost" className="shrink-0" aria-label={t("projects.reference.open_record", { name })} title={t("projects.reference.open_record", { name })} onClick={() => navigate(`/back-office/${encodeURIComponent(record.objectId)}?record=${record.id}`)}><ArrowUpRight className="size-3" /></Button>}
        <Button type="button" size="icon-xs" variant="ghost" className="shrink-0" disabled={busy} aria-label={t("projects.remove_reference", { name, field: field.label })} title={t("projects.remove_reference", { name, field: field.label })} onClick={() => {
          if (!field.value) return;
          const remaining = field.value.recordIds.filter(recordId => recordId !== id);
          void save(remaining.length ? { ...field.value, recordIds: remaining } : null).catch(error => setError(projectErrorMessage(error)));
        }}><X className="size-3" /></Button>
      </span>;
    })}
      {!field.value?.recordIds.length && <Popover.Trigger render={<Button type="button" size="sm" variant="ghost" className="h-6 min-w-0 truncate px-1.5 text-xs font-normal" disabled={busy || !object || !data?.directoryId} aria-label={t("projects.edit_value", { name: field.label })}>{t("projects.connections.choose_records")}<ChevronDown className="size-3" /></Button>} />}
      <Popover.Portal><Popover.Positioner align="start" sideOffset={4}>
        <DirectoryEditorPopup>
      <CellEditor key={`${field.id}:${data?.directoryId}:${open}`} field={relation} creationFilters={field.filters} value={field.multiple ? ids : ids[0] ?? null} records={selectable} onCancel={() => setOpen(false)} onSave={async value => {
        const selected = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : [];
        if (!data?.directoryId) throw new Error(t("projects.reference.unavailable"));
        await save(selected.length ? { directoryId: data.directoryId, recordIds: selected } : null);
      }} />
        </DirectoryEditorPopup>
      </Popover.Positioner></Popover.Portal>
    {(error || directory.error) && <p role="alert" className="text-xs text-destructive">{error || directory.error?.message}</p>}
  </div></Popover.Root></BackOfficeTheme></RecordCreationProvider>;
}
