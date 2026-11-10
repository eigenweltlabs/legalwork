import { projectErrorMessage } from "./project-errors";
import { useRef, useState } from "react";
import { CalendarDays, Hash, ListFilter, Pencil, Type, X } from "lucide-react";
import type { ProjectField } from "@legalwork/types/workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";

import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { ProjectRecordField } from "./project-record-field";
import { projectFieldLabel } from "./project-defaults-store";
import { isProjectQuickAction } from "./project-connections";
import { ObjectIcon } from "../back-office/object-icon";

const fieldIcons = { text: Type, number: Hash, date: CalendarDays, select: ListFilter };

function displayValue(field: ProjectField) {
  if (field.value === null || field.value === "") return "–";
  if (field.type === "number" && typeof field.value === "number") return field.value.toLocaleString(currentLocale());
  if (field.type === "date") return new Date(`${field.value}T00:00:00`).toLocaleDateString(currentLocale());
  return String(field.value);
}

export function ProjectProperties({ fields, onSave, className, client }: {
  fields: ProjectField[];
  client?: LegalworkServerClient | null;
  className?: string;
  onSave: (id: string, value: ProjectField["value"]) => Promise<void>;
}) {
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const saving = useRef(false);
  const cancelled = useRef(false);
  const editSnapshot = useRef<{ field: ProjectField; onSave: typeof onSave } | null>(null);
  const save = async (field: ProjectField, draft: string) => {
    if (saving.current || cancelled.current || conflict === field.id) return;
    const snapshot = editSnapshot.current?.field.id === field.id ? editSnapshot.current : { field, onSave };
    field = snapshot.field;
    const value = draft === "" ? null : field.type === "number" ? Number(draft) : draft;
    if (value === field.value || (value === null && field.value === "")) { setEditing(null); return; }
    saving.current = true;
    setBusy(true);
    try { await snapshot.onSave(field.id, value); setEditing(null); }
    catch (error) {
      if (error instanceof LegalworkServerError && error.code === "project_changed") setConflict(field.id);
      toast.error(projectErrorMessage(error));
    }
    finally { saving.current = false; setBusy(false); }
  };
  return <dl className={cn("space-y-1", className)}>
    {fields.map((field) => {
      const label = projectFieldLabel(field);
      if (field.type === "backoffice") return <div key={field.id} className="grid min-h-9 grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] items-start gap-2 text-xs">
        <dt className={isProjectQuickAction(field) && !field.value ? "sr-only" : "flex min-w-0 items-center gap-2 py-2 text-muted-foreground"}><ObjectIcon id={field.objectId} className="size-3.5 shrink-0 opacity-70" /><span>{label}</span></dt>
        <dd className={cn("min-w-0", isProjectQuickAction(field) && !field.value && "col-span-2")}><ProjectRecordField field={field} client={client} onSave={value => onSave(field.id, value)} /></dd>
      </div>;
      const Icon = fieldIcons[field.type];
      const empty = field.value === null || field.value === "";
      const edit = () => { cancelled.current = false; setConflict(null); editSnapshot.current = { field, onSave }; setEditing({ id: field.id, draft: String(field.value ?? "") }); };
      return <ContextMenu key={field.id} disabled={editing?.id === field.id}>
      <ContextMenuTrigger onContextMenu={(event) => event.stopPropagation()} render={<div className="grid min-h-9 grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] items-start gap-2 text-xs" />}>
        <dt className="flex min-w-0 items-center gap-2 py-2 text-muted-foreground" title={label}><Icon className="size-3.5 shrink-0 opacity-70" /><span className="break-words leading-4">{label}</span></dt>
        <dd className="min-w-0">
          {editing?.id === field.id ? field.type === "select" ? (
            <Select open value={editing.draft} onOpenChange={(open) => { if (!open && !saving.current) setEditing(null); }} onValueChange={(value) => { void save(field, value ?? ""); }}>
              <SelectTrigger aria-label={label} className="h-8 w-full px-2 text-xs" disabled={busy}><SelectValue placeholder={t("projects.empty_value")} /></SelectTrigger>
              <SelectContent><SelectItem value="">{t("projects.empty_value")}</SelectItem>{field.options?.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
            </Select>
          ) : (
            <Input autoFocus aria-label={label} type={field.type === "text" ? "text" : field.type} lang={currentLocale()} step="any" maxLength={4000} className="h-8 px-2 text-xs md:text-xs" value={editing.draft} disabled={busy}
              onChange={(event) => setEditing({ id: field.id, draft: event.target.value })}
              onBlur={(event) => { if (event.currentTarget.validity.valid) void save(field, event.currentTarget.value); }}
              onKeyDown={(event) => {
                if (event.key === "Escape") { cancelled.current = true; setEditing(null); }
                if (event.key === "Enter") { event.preventDefault(); if (event.currentTarget.reportValidity()) void save(field, event.currentTarget.value); }
              }} />
          ) : <Button type="button" variant="ghost" disabled={busy} className={cn("h-auto min-h-8 w-full justify-start whitespace-normal break-words px-2 py-1.5 text-left text-xs font-normal text-foreground", empty && "text-muted-foreground")} aria-label={t("projects.edit_value", { name: label })} onClick={edit}>{empty ? t("projects.enter_content") : displayValue(field)}</Button>}
          {conflict === field.id && <Button type="button" variant="link" size="sm" className="px-2 text-xs" onClick={edit}>{t("projects.load_latest_value")}</Button>}
        </dd>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={busy} onClick={edit}><Pencil />{t("projects.edit_value", { name: label })}</ContextMenuItem>
        <ContextMenuItem disabled={busy || empty} onClick={() => { cancelled.current = false; editSnapshot.current = null; void save(field, ""); }}><X />{t("projects.clear_value")}</ContextMenuItem>
      </ContextMenuContent>
      </ContextMenu>;
    })}
  </dl>;
}
