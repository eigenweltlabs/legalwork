import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, ChevronLeft, ChevronRight, Download, Plus, Upload } from "lucide-react";
import { toast } from "sonner";
import type { CalendarItem, CalendarOccurrence } from "@legalwork/types/calendar";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { onSyncPoke } from "../../kernel/sync-events";
import { useTaskMembers } from "../tasks/tasks-queries";

const dayString = (day: Date) => `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
const shifted = (day: Date, offset: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset);
const itemDay = (item: CalendarOccurrence) => item.allDay ? item.start : new Intl.DateTimeFormat("en-CA", { timeZone: item.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(item.start));
const errorText = (error: unknown) => error instanceof Error ? error.message : t("calendar.failed");

export function CalendarView(props: { client: LegalworkServerClient | null; workspaceId?: string; onOpenProject?: (id: string) => void; onOpenTask?: (id: string, projectId: string | null) => void; remoteSources?: { id: string; name: string; workspaceId: string; client: LegalworkServerClient }[] }) {
  const [month, setMonth] = useState(() => new Date()), [view, setView] = useState<"month" | "agenda">("month");
  const [kind, setKind] = useState("all"), [status, setStatus] = useState("active"), [project, setProject] = useState("all"), [assignee, setAssignee] = useState("all");
  const [trashOpen, setTrashOpen] = useState(false);
  const [editing, setEditing] = useState<CalendarItem | "new" | null>(null), [chosenDay, setChosenDay] = useState(dayString(new Date()));
  const client = props.client, cache = useQueryClient();
  const first = new Date(month.getFullYear(), month.getMonth(), 1), start = shifted(first, -((first.getDay() + 6) % 7)), end = shifted(start, 42);
  const from = dayString(start), to = dayString(end), members = useTaskMembers({ client, workspaceId: props.workspaceId ?? "" });
  const query = useQuery({ queryKey: ["calendar", client?.baseUrl, props.workspaceId ?? "home", (props.remoteSources ?? []).map(source => `${source.id}:${source.client.baseUrl}`).join(","), from, to], queryFn: async () => {
    const sources = props.workspaceId ? [] : props.remoteSources ?? [];
    const responses = await Promise.allSettled([client!.calendarOccurrences(props.workspaceId ?? null, from, to), ...sources.map(source => source.client.calendarOccurrences(source.workspaceId, from, to))]);
    const local = responses[0]; if (local.status === "rejected") throw local.reason;
    const occurrences = [...local.value.occurrences], unavailable: string[] = [];
    responses.slice(1).forEach((response, index) => {
      const source = sources[index];
      if (response.status === "rejected") { unavailable.push(source.name); return; }
      occurrences.push(...response.value.occurrences.map(item => ({ ...item, id: `${source.id}:${item.id}`, projectId: source.id, projectName: source.name })));
    });
    return { occurrences: occurrences.sort((a, b) => a.start.localeCompare(b.start)), unavailable };
  }, enabled: Boolean(client), refetchInterval: 60000 });
  useEffect(() => onSyncPoke(() => { void cache.invalidateQueries({ queryKey: ["calendar"] }); }), [cache]);
  const records = useQuery({ queryKey: ["calendar", client?.baseUrl, props.workspaceId, "items"], queryFn: () => client!.calendarItems(props.workspaceId!, true), enabled: Boolean(client && props.workspaceId), refetchInterval: 60000 });
  const all = query.data?.occurrences ?? [], projects = [...new Map(all.map(item => [item.projectId ?? "inbox", item.projectName])).entries()];
  const items = all.filter(item => (kind === "all" || kind === item.kind) && (project === "all" || project === (item.projectId ?? "inbox")) &&
    (assignee === "all" || assignee === (item.assigneeUserId ?? "unassigned")) && (status === "all" || (status === "active" ? !["done", "completed", "cancelled"].includes(item.status) : ["done", "completed"].includes(item.status))));
  const refresh = () => { void cache.invalidateQueries({ queryKey: ["calendar"] }); };
  const open = async (item: CalendarOccurrence) => {
    if (item.kind === "task") { props.onOpenTask?.(item.itemId, item.projectId); return; }
    if (!props.workspaceId && item.projectId) { props.onOpenProject?.(item.projectId); return; }
    if (!client || !props.workspaceId) return;
    try { setEditing((await client.calendarItem(props.workspaceId, item.itemId)).item); } catch (error) { toast.error(errorText(error)); }
  };
  const download = async () => {
    if (!client || !props.workspaceId) return;
    try {
      const content = await client.calendarExport(props.workspaceId), url = URL.createObjectURL(new Blob([content], { type: "text/calendar;charset=utf-8" }));
      const a = document.createElement("a"); a.href = url; a.download = "calendar.ics"; a.click(); URL.revokeObjectURL(url);
    } catch (error) { toast.error(errorText(error)); }
  };
  return <div className="h-full overflow-auto bg-background"><div className="lw-page-content lw-page-top pb-8">
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <h1 className="flex items-center gap-2 text-xl"><CalendarDays className="size-5" />{t(props.workspaceId ? "calendar.title" : "calendar.all_projects")}</h1>
      {props.workspaceId && <div className="flex gap-2">
        <Button variant="ghost" size="sm" onClick={() => setTrashOpen(true)}>{t("calendar.trash")}</Button>
        <Button variant="outline" size="sm" onClick={() => void download()}><Download className="size-4" />{t("calendar.export")}</Button>
        <label className="relative"><Button variant="outline" size="sm" tabIndex={-1}><Upload className="size-4" />{t("calendar.import")}</Button>
          <input className="absolute inset-0 w-full cursor-pointer opacity-0" type="file" accept=".ics,text/calendar" aria-label={t("calendar.import")} onChange={async event => {
            const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (!file || !client) return;
            try { await client.calendarWrite(props.workspaceId!, "/import", { ical: await file.text(), source: file.name }); refresh(); } catch (error) { toast.error(errorText(error)); }
          }} /></label>
        <Button size="sm" onClick={() => { setChosenDay(dayString(new Date())); setEditing("new"); }}><Plus className="size-4" />{t("calendar.add")}</Button>
      </div>}
    </div>
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Button variant="ghost" size="icon" aria-label={t("calendar.previous")} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft /></Button>
      <h2 className="min-w-40 text-center">{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
      <Button variant="ghost" size="icon" aria-label={t("calendar.next")} onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight /></Button>
      <Button variant="outline" size="sm" onClick={() => setMonth(new Date())}>{t("calendar.today")}</Button>
      <Button variant={view === "month" ? "secondary" : "ghost"} size="sm" onClick={() => setView("month")}>{t("calendar.month")}</Button>
      <Button variant={view === "agenda" ? "secondary" : "ghost"} size="sm" onClick={() => setView("agenda")}>{t("calendar.agenda")}</Button>
    </div>
    <div className="mb-4 flex flex-wrap gap-2 text-sm">
      <select className="rounded-md border bg-background p-2" aria-label={t("calendar.type")} value={kind} onChange={event => setKind(event.target.value)}>{["all", "deadline", "task", "event", "journal", "freebusy"].map(value => <option key={value} value={value}>{t(`calendar.${value}`)}</option>)}</select>
      <select className="rounded-md border bg-background p-2" aria-label={t("calendar.status")} value={status} onChange={event => setStatus(event.target.value)}>{["active", "completed", "all"].map(value => <option key={value} value={value}>{t(`calendar.${value}`)}</option>)}</select>
      {!props.workspaceId && <select className="rounded-md border bg-background p-2" aria-label={t("calendar.project")} value={project} onChange={event => setProject(event.target.value)}><option value="all">{t("calendar.all_projects")}</option>{projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>}
      <select className="rounded-md border bg-background p-2" aria-label={t("calendar.assignee")} value={assignee} onChange={event => setAssignee(event.target.value)}><option value="all">{t("calendar.all_assignees")}</option><option value="unassigned">{t("calendar.unassigned")}</option>{members.data?.map(member => <option key={member.userId} value={member.userId}>{member.name || member.email}</option>)}</select>
    </div>
    {records.data?.conflicts.map(remote => {
      const current = records.data.items.find(item => item.id === remote.id); if (!current) return null;
      return <div key={remote.id} role="alert" className="mb-4 rounded-lg border border-amber-500/50 p-4 text-sm"><p>{t("calendar.conflict")}</p><div className="my-2 grid grid-cols-2 gap-3"><div><strong>{t("calendar.mine")}</strong><p>{current.title} · {current.start}</p><p>{t(`calendar.${current.provenance.kind}`)}</p></div><div><strong>{t("calendar.theirs")}</strong><p>{remote.title} · {remote.start}</p><p>{t(`calendar.${remote.provenance.kind}`)}</p></div></div><details><summary>{t("calendar.calculation")}</summary><pre className="overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify({ mine: current.provenance, theirs: remote.provenance }, null, 2)}</pre></details><div className="mt-3 flex gap-2">{["mine", "theirs"].map(keep => <Button key={keep} size="sm" variant="outline" onClick={async () => { try { await client?.calendarWrite(props.workspaceId!, `/${current.id}/conflict`, { revision: current.revision, keep }); refresh(); } catch (error) { toast.error(errorText(error)); } }}>{t(`calendar.keep_${keep}`)}</Button>)}</div></div>;
    })}
    {trashOpen && <Dialog open onOpenChange={setTrashOpen}><DialogContent><DialogHeader><DialogTitle>{t("calendar.trash")}</DialogTitle><DialogDescription>{t("calendar.trash_hint")}</DialogDescription></DialogHeader>{records.data?.items.filter(item => item.deletedAt).map(item => <div key={item.id} className="flex items-center justify-between gap-3"><span>{item.title} · {item.start?.slice(0, 10)}</span><Button size="sm" variant="outline" onClick={async () => { try { await client?.calendarWrite(props.workspaceId!, `/${item.id}/restore`, { revision: item.revision }); refresh(); } catch (error) { toast.error(errorText(error)); } }}>{t("calendar.restore")}</Button></div>)}</DialogContent></Dialog>}
    {query.isPending && <p className="text-muted-foreground">{t("calendar.loading")}</p>}
    {query.data?.unavailable.length ? <p role="alert" className="text-muted-foreground">{t("calendar.unavailable_projects", { projects: query.data.unavailable.join(", ") })}</p> : null}
    {query.isError && <p role="alert" className="text-destructive">{errorText(query.error)}</p>}
    {view === "month" ? <div className="grid grid-cols-7 overflow-hidden rounded-lg border">
      {Array.from({ length: 7 }, (_, index) => <div key={index} className="border-b bg-muted/30 p-2 text-center text-xs text-muted-foreground">{shifted(start, index).toLocaleDateString(undefined, { weekday: "short" })}</div>)}
      {Array.from({ length: 42 }, (_, index) => {
        const day = shifted(start, index), key = dayString(day), entries = items.filter(item => itemDay(item) === key);
        return <div key={key} className={cn("min-h-28 border-b border-r p-1.5", day.getMonth() !== month.getMonth() && "bg-muted/20")}>
          <button className={cn("mb-1 grid size-6 place-items-center rounded-full text-xs", key === dayString(new Date()) && "bg-primary text-primary-foreground")} aria-label={day.toLocaleDateString()} onClick={() => { if (props.workspaceId) { setChosenDay(key); setEditing("new"); } }}>{day.getDate()}</button>
          {entries.map(item => <button key={item.id} onClick={() => void open(item)} title={`${item.projectName}: ${item.title}`} className={cn("mb-1 block w-full truncate rounded px-1.5 py-1 text-left text-xs", item.kind === "deadline" ? "bg-amber-500/15 text-amber-800 dark:text-amber-300" : "bg-muted", ["done", "completed"].includes(item.status) && "opacity-60 line-through")}>
            {item.kind === "deadline" ? "◆ " : ""}{item.title}
          </button>)}
        </div>;
      })}
    </div> : <div className="divide-y rounded-lg border">{items.length === 0 && <p className="p-6 text-muted-foreground">{t("calendar.empty")}</p>}{items.map(item => <button key={item.id} className="flex w-full items-center gap-4 p-3 text-left hover:bg-muted/40" onClick={() => void open(item)}><time className="w-24 shrink-0 text-sm tabular-nums">{itemDay(item)}</time><div className="min-w-0 flex-1"><div className="truncate">{item.title}</div><div className="text-xs text-muted-foreground">{item.projectName} · {t(`calendar.${item.kind}`)} · {t(`calendar.${item.provenance?.kind ?? "task"}`)}</div></div>{!item.verified && item.kind === "deadline" && <span className="text-xs text-amber-700">{t("calendar.unverified")}</span>}</button>)}</div>}
    {editing && client && props.workspaceId && <DeadlineEditor key={typeof editing === "string" ? chosenDay : editing.id} client={client} workspaceId={props.workspaceId} item={editing === "new" ? null : editing} day={chosenDay} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
  </div></div>;
}

function DeadlineEditor(props: { client: LegalworkServerClient; workspaceId: string; item: CalendarItem | null; day: string; onClose: () => void; onSaved: () => void }) {
  const item = props.item, [title, setTitle] = useState(item?.title ?? ""), [day, setDay] = useState(item?.start?.slice(0, 10) ?? props.day);
  const [source, setSource] = useState(item?.provenance.kind === "manual" ? item.provenance.source : ""), [reason, setReason] = useState("");
  const [timeZone, setTimeZone] = useState(item?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone), [saving, setSaving] = useState(false);
  const [kind, setKind] = useState<"deadline" | "event">(item?.kind === "event" ? "event" : "deadline"), [status, setStatus] = useState(item?.status ?? "active");
  const [verified, setVerified] = useState(item?.verified ?? false), [reminder, setReminder] = useState(item?.reminders[0] ?? 1440);
  const [assignee, setAssignee] = useState(item?.assigneeUserId ?? "");
  const members = useTaskMembers({ client: props.client, workspaceId: props.workspaceId });
  const advanced = Boolean(item && (item.start?.length !== 10 || /(?:RRULE|RDATE)[;:]/i.test(item.ical)));
  const save = async () => {
    setSaving(true);
    try {
      const body = item ? { revision: item.revision, title, status, verified,
        ...(day !== item.start?.slice(0, 10) ? { start: day, end: null, reason } : {}), ...(timeZone !== item.timeZone ? { timeZone, reason } : {}),
        ...(source && item.provenance.kind === "manual" ? { source } : {}), assigneeUserId: assignee || null,
        ...(reminder !== (item.reminders[0] ?? 1440) ? { reminders: [reminder] } : {}) }
        : { title, start: day, timeZone, kind, source, assigneeUserId: assignee || null, reminders: [reminder] };
      await props.client.calendarWrite(props.workspaceId, item ? `/${item.id}` : "", body, item ? "PATCH" : "POST"); props.onSaved();
    } catch (error) { toast.error(errorText(error)); } finally { setSaving(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open) props.onClose(); }}><DialogContent className="max-h-[85vh] overflow-auto"><DialogHeader><DialogTitle>{t(item ? "calendar.edit" : "calendar.add")}</DialogTitle><DialogDescription>{t("calendar.manual_hint")}</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="block space-y-1 text-sm">{t("calendar.name")}<Input autoFocus required value={title} onChange={event => setTitle(event.target.value)} /></label>
      {!item && <label className="block space-y-1 text-sm">{t("calendar.type")}<select className="block w-full rounded-md border bg-background p-2" value={kind} onChange={event => setKind(event.target.value === "event" ? "event" : "deadline")}><option value="deadline">{t("calendar.deadline")}</option><option value="event">{t("calendar.event")}</option></select></label>}
      <label className="block space-y-1 text-sm">{t("calendar.day")}<Input type="date" required disabled={advanced} value={day} onChange={event => setDay(event.target.value)} /></label>
      <label className="block space-y-1 text-sm">{t("calendar.timezone")}<Input required disabled={advanced} value={timeZone} onChange={event => setTimeZone(event.target.value)} /></label>
      {advanced && <p className="text-xs text-muted-foreground">{t("calendar.advanced_hint")}</p>}
      {(!item || item.provenance.kind === "manual") && <label className="block space-y-1 text-sm">{t("calendar.source")}<Input value={source} onChange={event => setSource(event.target.value)} /></label>}
      {item?.provenance.kind === "calculated" && <><label className="block space-y-1 text-sm">{t("calendar.override_reason")}<Input value={reason} onChange={event => setReason(event.target.value)} /></label><details className="rounded border p-3 text-xs"><summary>{t("calendar.calculation")}</summary><p className="mt-2">{item.provenance.calculation.rule} · {item.provenance.calculation.version}</p><p>{item.provenance.calculation.cutoff} ({item.provenance.calculation.timeZone})</p><pre className="my-2 whitespace-pre-wrap">{JSON.stringify(item.provenance.calculation.input, null, 2)}</pre>{item.provenance.calculation.trace.map((line, index) => <p key={index}>{line}</p>)}{item.provenance.calculation.sources.map(url => <a key={url} className="mt-1 block underline" href={url} target="_blank" rel="noreferrer">{url}</a>)}</details></>}
      <label className="block space-y-1 text-sm">{t("calendar.assignee")}<select className="block w-full rounded-md border bg-background p-2" value={assignee} onChange={event => setAssignee(event.target.value)}><option value="">{t("calendar.unassigned")}</option>{members.data?.map(member => <option key={member.userId} value={member.userId}>{member.name || member.email}</option>)}</select></label>
      <label className="block space-y-1 text-sm">{t("calendar.reminder")}<select className="block w-full rounded-md border bg-background p-2" value={reminder} onChange={event => setReminder(Number(event.target.value))}>{[0, 60, 1440, 10080].map(minutes => <option key={minutes} value={minutes}>{minutes === 0 ? t("calendar.at_start") : t("calendar.minutes_before", { count: minutes })}</option>)}</select></label>
      {item && <><label className="block space-y-1 text-sm">{t("calendar.status")}<select className="block w-full rounded-md border bg-background p-2" value={status} onChange={event => setStatus(event.target.value === "completed" ? "completed" : event.target.value === "cancelled" ? "cancelled" : "active")}>{["active", "completed", "cancelled"].map(value => <option key={value} value={value}>{t(`calendar.${value}`)}</option>)}</select></label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={verified} onChange={event => setVerified(event.target.checked)} />{t("calendar.verified")}</label></>}
      <div className="flex justify-between gap-2">{item && <Button type="button" variant="ghost" disabled={saving} onClick={async () => { try { await props.client.calendarWrite(props.workspaceId, `/${item.id}/delete`, { revision: item.revision }); props.onSaved(); } catch (error) { toast.error(errorText(error)); } }}>{t("calendar.delete")}</Button>}<Button className="ml-auto" disabled={saving} type="submit">{t("calendar.save")}</Button></div>
    </form>
  </DialogContent></Dialog>;
}
