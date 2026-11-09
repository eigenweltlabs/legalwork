import { useRef, useState } from "react";
import { projectFieldsSchema, type ProjectField } from "@legalwork/types/workspace";
import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { isMacPlatform } from "@/app/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { RecordCreationProvider } from "../back-office/record-creation-context";
import { useProjectBackOffice } from "./project-record-field";
import { ProjectFieldEditor } from "./project-field-editor";
import { projectErrorMessage } from "./project-errors";

export function ProjectFieldDialog({ client, field, onSave, onClose, onReload }: {
  client: LegalworkServerClient | null; field?: ProjectField;
  onSave: (field: ProjectField) => Promise<void>; onClose: () => void;
  onReload?: () => void;
}) {
  const directory = useProjectBackOffice(client);
  const [draft, setDraft] = useState<ProjectField>(() => field ?? { id: crypto.randomUUID(), label: "", labelSource: "custom", type: "text", value: null });
  const [busy, setBusy] = useState(false), [creating, setCreating] = useState(false), [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const saving = useRef(false), form = useRef<HTMLFormElement>(null);
  const save = async () => {
    if (saving.current || creating || conflict || !form.current?.reportValidity()) return;
    saving.current = true; setBusy(true); setError("");
    try { const [validated] = projectFieldsSchema.parse([{ ...draft, label: draft.label.trim() }]); await onSave(validated); onClose(); }
    catch (error) { setConflict(error instanceof LegalworkServerError && error.code === "project_changed"); setError(projectErrorMessage(error)); }
    finally { saving.current = false; setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !saving.current && !creating) onClose(); }}>
    <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg" showCloseButton={!busy && !creating}>
      <DialogHeader><DialogTitle>{t(field ? "projects.edit_field" : "projects.new_field")}</DialogTitle><DialogDescription>{t("projects.field_value_hint")}</DialogDescription></DialogHeader>
      <form ref={form} className="space-y-5" onSubmit={event => { if (event.target !== event.currentTarget) return; event.preventDefault(); event.stopPropagation(); void save(); }} onKeyDown={event => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); if (!event.repeat) void save(); }
      }}>
        <RecordCreationProvider client={client} state={directory.data}>
          <ProjectFieldEditor field={draft} state={directory.data} disabled={busy} autoFocus={!field} onChange={next => { setDraft(next); setError(""); }} onCreatingChange={setCreating} onSubmit={() => void save()} />
        </RecordCreationProvider>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {conflict && onReload && <Button type="button" variant="outline" onClick={onReload}>{t("projects.reload_fields")}</Button>}
        {!creating && <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{t("projects.cancel")}</Button><Button type="submit" disabled={busy || conflict || !draft.label.trim()} aria-keyshortcuts={isMacPlatform() ? "Meta+Enter" : "Control+Enter"}>{t(busy ? "projects.saving" : "projects.save")}</Button></DialogFooter>}
      </form>
    </DialogContent>
  </Dialog>;
}
