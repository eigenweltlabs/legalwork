import { useRef, useState } from "react";
import { CalendarDays, Hash, ListFilter, Type } from "lucide-react";
import type { ProjectField } from "@legalwork/types/workspace";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/sonner";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";

const fieldIcons = { text: Type, number: Hash, date: CalendarDays, select: ListFilter };

function displayValue(field: ProjectField) {
  if (field.value === null || field.value === "") return "–";
  if (field.type === "number" && typeof field.value === "number") return field.value.toLocaleString(currentLocale());
  if (field.type === "date") return new Date(`${field.value}T00:00:00`).toLocaleDateString(currentLocale());
  return String(field.value);
}

export function ProjectProperties({ fields, onSave }: {
  fields: ProjectField[];
  onSave: (id: string, value: ProjectField["value"]) => Promise<void>;
}) {
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const cancelled = useRef(false);
  const save = async (field: ProjectField, draft: string) => {
    if (saving.current || cancelled.current) return;
    const value = draft === "" ? null : field.type === "number" ? Number(draft) : draft;
    if (value === field.value || (value === null && field.value === "")) { setEditing(null); return; }
    saving.current = true;
    setBusy(true);
    try { await onSave(field.id, value); setEditing(null); }
    catch { toast.error(t("projects.failed")); }
    finally { saving.current = false; setBusy(false); }
  };
  return <dl className="space-y-1">
    {fields.map((field) => {
      const Icon = fieldIcons[field.type];
      const empty = field.value === null || field.value === "";
      return <div key={field.id} className="grid min-h-9 grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] items-start gap-2 text-xs">
        <dt className="flex min-w-0 items-center gap-2 py-2 text-muted-foreground" title={field.label}><Icon className="size-3.5 shrink-0 opacity-70" /><span className="break-words leading-4">{field.label}</span></dt>
        <dd className="min-w-0">
          {editing?.id === field.id ? field.type === "select" ? (
            <Select open value={editing.draft} onOpenChange={(open) => { if (!open && !saving.current) setEditing(null); }} onValueChange={(value) => { void save(field, value ?? ""); }}>
              <SelectTrigger aria-label={field.label} className="h-8 w-full px-2 text-xs" disabled={busy}><SelectValue placeholder={t("projects.empty_value")} /></SelectTrigger>
              <SelectContent><SelectItem value="">{t("projects.empty_value")}</SelectItem>{field.options?.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}</SelectContent>
            </Select>
          ) : (
            <Input autoFocus aria-label={field.label} type={field.type === "text" ? "text" : field.type} lang={currentLocale()} step="any" maxLength={4000} className="h-8 px-2 text-xs md:text-xs" value={editing.draft} disabled={busy}
              onChange={(event) => setEditing({ id: field.id, draft: event.target.value })}
              onBlur={(event) => { if (event.currentTarget.validity.valid) void save(field, event.currentTarget.value); }}
              onKeyDown={(event) => {
                if (event.key === "Escape") { cancelled.current = true; setEditing(null); }
                if (event.key === "Enter") { event.preventDefault(); if (event.currentTarget.reportValidity()) void save(field, event.currentTarget.value); }
              }} />
          ) : <Button variant="ghost" disabled={busy} className={cn("h-auto min-h-8 w-full justify-start whitespace-normal break-words px-2 py-1.5 text-left text-xs font-normal text-foreground", empty && "text-muted-foreground/60")} title={empty ? t("projects.empty_value") : undefined} aria-label={t("projects.edit_value", { name: field.label })} onClick={() => { cancelled.current = false; setEditing({ id: field.id, draft: String(field.value ?? "") }); }}>{displayValue(field)}</Button>}
        </dd>
      </div>;
    })}
  </dl>;
}
