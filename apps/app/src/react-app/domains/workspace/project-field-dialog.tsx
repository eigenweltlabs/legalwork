import { useRef, useState } from "react";
import { BackOfficeFieldSchema } from "@legalwork/types/back-office";
import { projectFieldsSchema, type ProjectField } from "@legalwork/types/workspace";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { isMacPlatform } from "@/app/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";
import { RecordCreationProvider } from "../back-office/record-creation-context";
import { RecordCreateRelation } from "../back-office/record-create-relation";
import { useProjectBackOffice } from "./project-record-field";
import { hasProjectFieldValue } from "./project-connections";
import { projectFieldLabel } from "./project-defaults-store";
import { parseProjectOptions } from "./project-field-editing";
import { projectErrorMessage } from "./project-errors";

export function ProjectFieldDialog({ client, field, onSave, onClose }: {
  client: LegalworkServerClient | null; field?: ProjectField;
  onSave: (field: ProjectField) => Promise<void>; onClose: () => void;
}) {
  const directory = useProjectBackOffice(client);
  const [draft, setDraft] = useState<ProjectField>(() => field ?? { id: crypto.randomUUID(), label: "", labelSource: "custom", type: "text", value: null });
  const [options, setOptions] = useState(""), [busy, setBusy] = useState(false), [creating, setCreating] = useState(false), [error, setError] = useState("");
  const saving = useRef(false);
  const label = field ? projectFieldLabel(field) : draft.label;
  const save = async () => {
    if (saving.current || creating || !draft.label.trim() || !hasProjectFieldValue(draft)) return;
    saving.current = true; setBusy(true); setError("");
    try { const [validated] = projectFieldsSchema.parse([{ ...draft, label: draft.label.trim() }]); await onSave(validated); onClose(); }
    catch (error) { setError(projectErrorMessage(error)); }
    finally { saving.current = false; setBusy(false); }
  };
  const types = { text: t("projects.type_text"), number: t("projects.type_number"), date: t("projects.type_date"), select: t("projects.type_select") };
  return <Dialog open onOpenChange={open => { if (!open && !saving.current && !creating) onClose(); }}>
    <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-md" showCloseButton={!busy && !creating} onKeyDown={event => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && !creating) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) void save(); }
    }}>
      <DialogHeader><DialogTitle>{field ? label : t("projects.new_field")}</DialogTitle><DialogDescription className="sr-only">{t("projects.field_value_hint")}</DialogDescription></DialogHeader>
      <RecordCreationProvider client={client} state={directory.data}>
        {!field && <>
          <label className="space-y-1 text-sm">{t("projects.field_name")}<Input autoFocus aria-label={t("projects.field_name")} value={draft.label} maxLength={100} disabled={busy} onChange={event => setDraft({ ...draft, label: event.target.value })} /></label>
          <Select value={draft.type} disabled={busy} onValueChange={type => {
            if (type === "text" || type === "number" || type === "date" || type === "select") setDraft({ id: draft.id, label: draft.label, labelSource: "custom", type, value: null, ...(type === "select" ? { options: parseProjectOptions(options) } : {}) });
          }}><SelectTrigger aria-label={t("projects.field_type")}><SelectValue /></SelectTrigger><SelectContent>{Object.entries(types).map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}</SelectContent></Select>
          {draft.type === "select" && <Input aria-label={t("projects.options")} placeholder={t("projects.options")} value={options} disabled={busy} onChange={event => { setOptions(event.target.value); setDraft({ ...draft, options: parseProjectOptions(event.target.value), value: null }); }} />}
        </>}
        {draft.type === "backoffice" ? <RecordCreateRelation inline field={BackOfficeFieldSchema.parse({ id: draft.id, label, type: "relation", target: draft.objectId, multiple: draft.multiple })}
          value={draft.value?.directoryId === directory.data?.directoryId ? draft.value?.recordIds ?? [] : []} creationFilters={draft.filters} disabled={busy} onCreatingChange={setCreating}
          onChange={value => { if (directory.data?.directoryId) setDraft({ ...draft, value: { directoryId: directory.data.directoryId, recordIds: Array.isArray(value) ? value.filter(item => typeof item === "string") : typeof value === "string" ? [value] : [] } }); }} onSubmit={() => void save()} />
          : draft.type === "select" ? <Select value={typeof draft.value === "string" ? draft.value : ""} disabled={busy} onValueChange={value => setDraft({ ...draft, value })}><SelectTrigger aria-label={t("projects.field_value")}><SelectValue placeholder={t("projects.choose_value")} /></SelectTrigger><SelectContent>{draft.options?.map(option => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent></Select>
          : <label className="space-y-1 text-sm">{t("projects.field_value")}<Input autoFocus={Boolean(field)} aria-label={t("projects.field_value")} type={draft.type} step="any" value={draft.value === null ? "" : String(draft.value)} disabled={busy} onChange={event => setDraft({ ...draft, value: event.target.value === "" ? null : draft.type === "number" ? Number(event.target.value) : event.target.value })} /></label>}
      </RecordCreationProvider>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!creating && <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t("projects.cancel")}</Button><Button type="button" disabled={busy || !draft.label.trim() || !hasProjectFieldValue(draft)} aria-keyshortcuts={isMacPlatform() ? "Meta+Enter" : "Control+Enter"} onClick={() => void save()}>{t(busy ? "projects.saving" : draft.type === "backoffice" ? "projects.connections.link" : "projects.save")}</Button></DialogFooter>}
    </DialogContent>
  </Dialog>;
}
