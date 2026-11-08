import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, ChevronDown, X } from "lucide-react";
import { Button } from "twenty-ui/primitives/input";
import { Popover } from "twenty-ui/primitives/surfaces";
import { BackOfficeFieldSchema, isInternalBackOfficeObject } from "@legalwork/types/back-office";
import { matchesProjectReferenceFilters } from "@legalwork/types/workspace";
import type { ProjectField, ProjectRecordReference } from "@legalwork/types/workspace";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { onSyncPoke } from "@/react-app/kernel/sync-events";
import "../back-office/back-office.css";
import { BackOfficeStateSchema } from "../back-office/api";
import { BackOfficeTheme } from "../back-office/twenty-controls";
import { CellEditor } from "../back-office/cell-editor";
import { displayBackOfficeObject } from "../back-office/labels";

export function useProjectBackOffice(client?: LegalworkServerClient | null) {
  const cache = useQueryClient();
  useEffect(() => onSyncPoke(poke => {
    if (poke.backOffice || poke.resync || poke.policy || poke.reload)
      void cache.invalidateQueries({ queryKey: ["back-office", client?.baseUrl] });
  }), [cache, client?.baseUrl]);
  const query = useQuery({ queryKey: ["back-office", client?.baseUrl, "auto"], queryFn: async () => {
    if (!client) throw new Error("Back Office is unavailable.");
    return BackOfficeStateSchema.parse(await client.backOffice(""));
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
  const save = async (value: ProjectRecordReference | null) => { setError(""); await onSave(value); };
  const relation = BackOfficeFieldSchema.parse({ id: "projectReference", label: field.label, type: "relation", target: field.objectId, multiple: field.multiple });
  return <BackOfficeTheme><div className="flex min-h-8 min-w-0 flex-wrap items-center gap-1">
    {field.value?.recordIds.map(id => {
      const record = ids.includes(id) ? records.find(record => record.id === id && record.objectId === field.objectId) : null;
      return <Button key={id} type="button" size="sm" variant="ghost" disabled={!record} onClick={() => { if (record) navigate(`/back-office/${encodeURIComponent(record.objectId)}?record=${record.id}`); }} endIcon={record ? <ArrowUpRight size={12} /> : undefined}>{record ? String(record.values.name ?? object?.label ?? "") : t("projects.reference.unavailable")}</Button>;
    })}
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger render={<Button type="button" size="sm" variant="ghost" disabled={!object || !data?.directoryId} aria-label={t("projects.edit_value", { name: field.label })} endIcon={<ChevronDown size={12} />}>{field.value ? t("projects.edit") : t("projects.empty_value")}</Button>} />
      <Popover.Portal><Popover.Positioner align="start" sideOffset={4}>
        <Popover.Popup className="bo-editor-popup" style={{ width: 260 }}>
      <CellEditor key={`${field.id}:${data?.directoryId}:${open}`} field={relation} value={field.multiple ? ids : ids[0] ?? null} records={selectable} onCancel={() => setOpen(false)} onSave={async value => {
        const selected = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : typeof value === "string" ? [value] : [];
        if (!data?.directoryId) throw new Error(t("projects.reference.unavailable"));
        await save(selected.length ? { directoryId: data.directoryId, recordIds: selected } : null);
      }} />
        </Popover.Popup>
      </Popover.Positioner></Popover.Portal>
    </Popover.Root>
    {field.value && <Button type="button" size="sm" variant="ghost" aria-label={t("projects.clear_value")} onClick={() => { void save(null).catch(error => setError(error.message)); }} startIcon={<X size={12} />} />}
    {(error || directory.error) && <p role="alert" className="text-xs text-destructive">{error || directory.error?.message}</p>}
  </div></BackOfficeTheme>;
}
