import { isLocalDraftServer } from "./draft-file-actions";
import { artifactDocumentKey, registerUnsavedDocument } from "@/react-app/domains/session/artifacts/docx-document-state";
import { useEffect, useId, useRef, useState } from "react";
import { getToolName, type DynamicToolUIPart, type ToolUIPart } from "ai";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, CalendarDays, Check, ChevronDown, Clock3, Download, Loader2, MapPin, SlidersHorizontal, Users } from "lucide-react";
import { CalendarEventDraftInputSchema, CalendarEventDraftSchema, type CalendarEventDraft } from "@legalwork/types/calendar-event-draft";
import { openDesktopPath, openDesktopUrl } from "@/app/lib/desktop";
import { isElectronRuntime } from "@/app/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Surface } from "@/react-app/design-system/surface";
import { useMessageList } from "./message-list-provider";
import { calendarComposeLink, calendarDraftLocalValue, calendarDraftModeTimes } from "./calendar-event-draft-links";
import { ConnectorDraftActions, connectorDraftTool, draftToolConflict, draftToolPayload } from "./connector-draft-actions";
import { DraftReplacedNotice, useDraftAutosave } from "./draft-autosave";

const invalidFieldLabels: Record<string, string> = { title: "title", start: "start time", end: "end time", timeZone: "time zone", organizer: "organizer", attendees: "guest emails", url: "event link", reminders: "reminder" };

export function isCalendarEventDraftTool(part: ToolUIPart | DynamicToolUIPart) { return ["legalwork_calendar_event_draft", "legalwork_calendar_event_draft_update"].includes(getToolName(part)) || connectorDraftTool(part, "calendar"); }
export function parseCalendarEventDraftCard(output: unknown) {
  try {
    const payload = draftToolPayload(output);
    const parsed = CalendarEventDraftSchema.safeParse(payload && typeof payload === "object" && "draft" in payload ? payload.draft : null);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
export function CalendarEventDraftToolCard({ part }: { part: ToolUIPart | DynamicToolUIPart }) {
  if (part.state !== "output-available" && part.state !== "output-error") return <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Preparing event draft…</p>;
  const initial = part.state === "output-available" ? parseCalendarEventDraftCard(part.output) : null;
  if (initial) return <CalendarEventDraftCard key={initial.id} initial={initial} />;
  return draftToolConflict(part.output) ? <p className="text-sm text-muted-foreground">The event was edited meanwhile, so this change was not applied.</p> : <p role="alert" className="text-sm text-destructive">Could not create the event draft.</p>;
}

function CalendarEventDraftCard({ initial }: { initial: CalendarEventDraft }) {
  const { legalworkClient: client, workspaceId, sessionId } = useMessageList();
  const cache = useQueryClient();
  const key = ["calendar-event-draft", client?.baseUrl, workspaceId, initial.id];
  const available = Boolean(client && workspaceId === initial.workspaceId);
  const query = useQuery({ queryKey: key, enabled: available, queryFn: async () => {
    if (!client) throw new Error("Connect to this project to edit the event.");
    return client.calendarEventDraft(workspaceId, initial.id);
  } });
  const calendarKey = ["calendar", client?.baseUrl, workspaceId, "draft", initial.id];
  const calendarQuery = useQuery({ queryKey: calendarKey, enabled: available, queryFn: async () => {
    if (!client) throw new Error("Connect to this project to add the event.");
    return client.calendarEventDraftStatus(workspaceId, initial.id);
  } });
  const [draft, setDraft] = useState<CalendarEventDraft | null>(null), [baseline, setBaseline] = useState<CalendarEventDraft | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const busyRef = useRef(false), fieldId = useId();
  const [allDay, setAllDay] = useState(initial.start.length === 10);
  const dirty = draft !== baseline;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const autosave = useDraftAutosave(draft, baseline, {
    enabled: available && !query.isError && !busy && !draft?.delivery,
    save: async next => { if (!client) throw new Error("The event is unavailable."); return (await client.saveCalendarEventDraft(workspaceId, next)).draft; },
    load: async () => { if (!client) throw new Error("The event is unavailable."); return (await client.calendarEventDraft(workspaceId, initial.id)).draft; },
    setDraft, setError, setBaseline: saved => { setBaseline(saved); cache.setQueryData(key, { draft: saved }); },
    invalid: next => { const field = CalendarEventDraftInputSchema.safeParse(next).error?.issues[0]?.path[0]; return field === undefined ? null : `Check the ${invalidFieldLabels[String(field)] ?? "event details"}`; },
  });
  useEffect(() => registerUnsavedDocument(artifactDocumentKey(workspaceId, sessionId, `${initial.id}:${fieldId}`), initial.title, () => dirtyRef.current), [workspaceId, sessionId, initial.id, initial.title, fieldId]);
  useEffect(() => { if (query.data && !dirty) { setDraft(query.data.draft); setBaseline(query.data.draft); setAllDay(query.data.draft.start.length === 10); } }, [query.data, dirty]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  if (!draft) return <Surface className="my-3 w-full max-w-2xl p-5"><p role={query.isError || !available ? "alert" : "status"}>{query.isError || !available ? "Connect to this project to load the event draft." : "Loading event draft…"}</p></Surface>;
  const current = draft;
  const update = current.googleCalendar?.update;
  const conference = current.googleCalendar?.conference;
  const actionable = available && !query.isError && !busy;
  const editable = actionable && !draft.delivery;
  const change = (patch: Partial<CalendarEventDraft>) => { setDraft(previous => previous && { ...previous, ...patch }); setError(null); };
  const added = !dirty && calendarQuery.data?.savedRevision === current.revision;
  const run = async (action: "legalwork" | "system" | "download" | "google" | "outlook" | "provider-save" | "provider-open" | "provider-refresh") => {
    if (!client || !actionable || busyRef.current) return;
    const popup = (action === "google" || action === "outlook" || action === "provider-open") && !isElectronRuntime() ? window.open("about:blank", "_blank") : null;
    if (popup) popup.opener = null;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const saved = await autosave.flush();
      if (!saved) throw new Error("The event is unavailable.");
      if (action === "provider-save") {
        const result = await client.deliverCalendarEventDraft(workspaceId, saved);
        setDraft(result.draft); setBaseline(result.draft); cache.setQueryData(key, result);
      } else if (action === "provider-refresh") {
        const result = await client.refreshCalendarEventDraft(workspaceId, saved);
        setDraft(result.draft); setBaseline(result.draft); cache.setQueryData(key, result);
      } else if (action === "provider-open") {
        const link = saved.delivery?.webUrl ?? (saved.connectorTarget?.connectorId === "google-calendar" ? "https://calendar.google.com" : "https://outlook.office.com/calendar");
        if (popup) popup.location.href = link; else await openDesktopUrl(link);
      } else if (action === "legalwork") {
        if (!calendarQuery.data) throw new Error("Could not load the LegalWork calendar. Try again.");
        const result = await client.addCalendarEventDraft(workspaceId, saved.id, { draftRevision: saved.revision, calendarRevision: calendarQuery.data.item?.revision, ...(sessionId ? { sessionId } : {}) });
        cache.setQueryData(calendarKey, result);
        void cache.invalidateQueries({ queryKey: ["calendar"] });
      } else if (action === "google" || action === "outlook") {
        const link = calendarComposeLink(saved, action);
        if (link.length > 8000) throw new Error("This event is too long for a calendar link. Download the .ics instead.");
        if (popup) popup.location.href = link; else await openDesktopUrl(link);
      } else {
        // .ics is the portable system-calendar handoff; local desktop projects
        // can open it directly, while web/remote clients download it to import.
        const workspaces = action === "system" && isElectronRuntime() ? await client.listWorkspaces() : null;
        const workspace = workspaces?.items.find(item => item.id === workspaceId);
        if (workspace?.workspaceType === "local" && client && isLocalDraftServer(client.baseUrl)) await openDesktopPath(`${workspace.path.replace(/[/\\]+$/, "")}/${saved.path}`);
        else {
          const result = await client.downloadWorkspaceFile(workspaceId, saved.path);
          const url = URL.createObjectURL(new Blob([result.data], { type: "text/calendar" }));
          const anchor = document.createElement("a"); anchor.href = url; anchor.download = "calendar-event.ics"; anchor.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 10000);
        }
      }
    } catch (problem) { popup?.close(); setError(problem instanceof Error ? problem.message : "Could not save or open the event."); if (action === "legalwork") void calendarQuery.refetch(); if (current.connectorTarget) void query.refetch(); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const localStart = calendarDraftLocalValue(current.start, current.timeZone);
  const localEnd = calendarDraftLocalValue(current.end, current.timeZone);
  const date = new Date(`${localStart.slice(0, 10)}T12:00:00Z`);
  const validDate = Number.isFinite(date.getTime());
  const dateLabel = validDate ? new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" }).format(date) : "Choose a date";
  const month = validDate ? new Intl.DateTimeFormat(undefined, { month: "short", timeZone: "UTC" }).format(date) : "Date";
  const days = Math.round((Date.parse(current.end) - Date.parse(current.start)) / 86400000);
  const timeLabel = allDay ? `All day${days > 1 ? ` · ${days} days` : ""}` : `${localStart.slice(11)} to ${localStart.slice(0, 10) === localEnd.slice(0, 10) ? localEnd.slice(11) : localEnd.replace("T", " ")}`;
  const guests = current.attendees.split(",").filter(value => value.trim()).length;
  const optionalFields: Array<{ key: "attendees" | "organizer" | "timeZone" | "url"; label: string }> = [
    { key: "attendees", label: "Guests" }, { key: "organizer", label: "Organizer" },
    { key: "timeZone", label: "Time zone" }, { key: "url", label: "Event link" },
  ];
  return <Surface className="my-3 w-full max-w-2xl overflow-hidden rounded-2xl shadow-[0_2px_12px_-5px_rgb(0_0_0/0.12)]">
    <div className="flex items-center gap-2 border-b border-border/60 bg-muted/25 px-5 py-3">
      <CalendarDays className="size-3.5 text-muted-foreground" />
      <h3 className="flex-1 text-xs font-medium text-muted-foreground">{update ? "Google Calendar update" : current.connectorTarget?.connectorId === "google-calendar" ? "Google Calendar draft" : current.connectorTarget ? "Outlook Calendar draft" : "Event draft"}</h3>
      <span role="status" className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80">
        {busy ? <><Loader2 className="size-3 animate-spin" />Working…</> : dirty && (error || autosave.invalid) ? <><span className="size-1.5 rounded-full bg-amber-500" />{autosave.invalid ?? "Not saved"}</> : current.delivery ? <><Check className="size-3" />{current.delivery.state === "saved" ? update ? "Updated in calendar" : "Added to calendar" : "Check calendar"}</> : null}
      </span>
      <Button variant="ghost" size="icon-xs" className="-mr-1 ml-1" aria-label="Event options" title="Guests, reminders and event details" aria-expanded={optionsOpen} aria-controls={`${fieldId}-options`} onClick={() => setOptionsOpen(!optionsOpen)}><SlidersHorizontal /></Button>
    </div>
    {update && <div className="border-b border-border/60 px-5 py-3 text-xs text-muted-foreground"><p>{update.recurringEventId ? "Update this occurrence only." : "Update this existing event."} Guests stay unchanged. Calendar notifications are disabled.</p>{!current.delivery && <p className="mt-1">Currently: {update.original.title} · {calendarDraftLocalValue(update.original.start, update.original.timeZone).replace("T", " ")} to {calendarDraftLocalValue(update.original.end, update.original.timeZone).replace("T", " ")}</p>}</div>}
    <fieldset disabled={!editable} onBlur={() => { if (dirty && !autosave.invalid) void autosave.flush().catch(() => undefined); }} className={`min-w-0 px-5 pb-5 pt-5 sm:px-6 ${current.delivery ? "[&_input:disabled]:opacity-100 [&_textarea:disabled]:opacity-100 [&_button:disabled]:opacity-100" : ""}`}>
      <label htmlFor={`${fieldId}-title`} className="sr-only">Title</label>
      <Textarea id={`${fieldId}-title`} value={current.title} onChange={event => change({ title: event.target.value })} placeholder="Event title" rows={1} className="mb-5 min-h-0 rounded-sm border-transparent bg-transparent p-0 text-lg font-medium leading-snug tracking-tight shadow-none hover:enabled:border-transparent focus-visible:ring-0 md:text-lg" />
      <button type="button" disabled={!editable} aria-label="Edit date and time" aria-expanded={scheduleOpen} aria-controls={`${fieldId}-schedule`} className="group flex w-full items-center gap-4 rounded-xl p-1 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50" onClick={() => setScheduleOpen(!scheduleOpen)}>
        <span className="flex h-16 w-14 shrink-0 flex-col items-center justify-center rounded-xl border border-border/70 bg-muted/30"><span className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground">{month}</span><span className="mt-0.5 text-2xl font-medium leading-none tracking-tight">{validDate ? date.getUTCDate() : "?"}</span></span>
        <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{dateLabel}</span><span className="mt-1 block text-xs text-muted-foreground">{timeLabel}</span><span className="mt-1 block text-[11px] text-muted-foreground/70">{current.timeZone.replace(/_/g, " ")}</span></span>
        <ChevronDown className={`mr-2 size-3.5 text-muted-foreground transition-transform ${scheduleOpen ? "rotate-180" : ""}`} />
      </button>
      {scheduleOpen && <div id={`${fieldId}-schedule`} className="mt-3 space-y-3 rounded-xl border border-border/60 bg-muted/20 p-3">
        <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">All day<Switch checked={allDay} onCheckedChange={checked => { change(calendarDraftModeTimes(current, checked)); setAllDay(checked); }} /></label>
        {(["start", "end"] satisfies Array<"start" | "end">).map(key => <div key={key} className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-2"><label htmlFor={`${fieldId}-${key}`} className="text-xs text-muted-foreground">{key === "start" ? "Starts" : allDay ? "Ends before" : "Ends"}</label><Input id={`${fieldId}-${key}`} type={allDay ? "date" : "datetime-local"} value={allDay ? current[key] : calendarDraftLocalValue(current[key], current.timeZone)} onChange={event => change({ [key]: allDay || !event.target.value ? event.target.value : `${event.target.value}:00` })} className="h-8 text-xs" /></div>)}
        {allDay && <p className="text-[11px] text-muted-foreground">For a one-day event, choose the following day as the end date.</p>}
      </div>}
      {(current.location || optionsOpen) && <div className="mt-4 flex items-center gap-3"><MapPin className="size-3.5 shrink-0 text-muted-foreground" /><label htmlFor={`${fieldId}-location`} className="sr-only">Location</label><Input id={`${fieldId}-location`} value={current.location} onChange={event => change({ location: event.target.value })} placeholder="Add a location" className="h-7 rounded-sm border-transparent bg-transparent px-0 text-sm shadow-none hover:enabled:border-transparent focus-visible:ring-0" /></div>}
      {guests > 0 && !optionsOpen && <button type="button" onClick={() => setOptionsOpen(true)} className="mt-2 flex items-center gap-3 text-xs text-muted-foreground transition-colors hover:text-foreground"><Users className="size-3.5" />{guests === 1 ? current.attendees.trim() : `${guests} guests`}</button>}
      {(current.description || optionsOpen) && <div className="mt-5 border-t border-border/50 pt-4"><label htmlFor={`${fieldId}-description`} className="sr-only">Description</label><Textarea id={`${fieldId}-description`} value={current.description} onChange={event => change({ description: event.target.value })} className="min-h-12 rounded-sm border-transparent bg-transparent p-0 text-sm leading-6 text-muted-foreground shadow-none hover:enabled:border-transparent focus-visible:ring-0" placeholder="Add a note…" /></div>}
      {optionsOpen && <div id={`${fieldId}-options`} className="mt-4 space-y-2 rounded-xl border border-border/60 bg-muted/20 p-3">
        {optionalFields.filter(({ key }) => !current.connectorTarget || (key !== "attendees" && key !== "organizer")).map(({ key, label }) => <div key={key} className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2"><label htmlFor={`${fieldId}-${key}`} className="text-xs text-muted-foreground">{label}</label><Input id={`${fieldId}-${key}`} value={current[key]} onChange={event => change({ [key]: event.target.value })} className="h-8 text-xs" placeholder={key === "attendees" ? "Email addresses, separated by commas" : "Optional"} /></div>)}
        <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2"><label htmlFor={`${fieldId}-reminder`} className="flex items-center gap-1.5 text-xs text-muted-foreground"><Clock3 className="size-3" />Reminder</label><Input id={`${fieldId}-reminder`} type="number" min={0} value={current.reminders[0] ?? ""} className="h-8 text-xs" placeholder="Minutes before" onChange={event => change({ reminders: event.target.value ? [Number(event.target.value)] : [] })} /></div>
      </div>}
    </fieldset>
    {current.connectorTarget?.connectorId === "google-calendar" && <div className="mx-5 mb-4 rounded-xl border border-border/60 p-3 text-xs">
      {conference?.url ? <a href={conference.url} target="_blank" rel="noopener noreferrer" className="text-primary underline">{conference.type === "hangoutsMeet" ? "Open Google Meet" : "Open conference"}</a> : conference?.status === "pending" ? <div className="flex items-center justify-between gap-2"><p role="status">{current.delivery ? "Event saved. " : ""}Google Meet is being created.</p>{current.delivery?.state === "saved" && <Button size="xs" variant="outline" disabled={!actionable} onClick={() => void run("provider-refresh")}>Refresh Meet status</Button>}</div> : conference?.status === "failure" ? <p role="alert">{current.delivery ? "Event saved. " : ""}Google Meet could not be created. Open Google Calendar to add a meeting link.</p> : conference?.status === "success" ? <p>This event already has a conference. Manage it in Google Calendar.</p> : current.googleCalendar?.canAddMeet === false ? <p className="text-muted-foreground">Google Meet is unavailable for this calendar.</p> : <label className="flex items-center justify-between gap-2">Add Google Meet<Switch checked={current.googleMeet} disabled={!editable} onCheckedChange={checked => change({ googleMeet: checked })} /></label>}
    </div>}
    {error && <div role="alert" className="mx-5 mb-4 rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}<Button size="xs" variant="ghost" className="mt-1 text-destructive" disabled={busy} onClick={() => void query.refetch().then(result => { if (result.data) { setDraft(result.data.draft); setBaseline(result.data.draft); setAllDay(result.data.draft.start.length === 10); setError(null); autosave.keepMine(); } })}>Discard edits and reload</Button></div>}
    {autosave.replaced && <DraftReplacedNotice onUseAssistant={autosave.takeAssistantVersion} onKeepMine={autosave.keepMine} />}
    <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-4 py-3">
      {!update && <Button size="sm" variant="ghost" disabled={!actionable || calendarQuery.isPending || added} className="gap-2" onClick={() => void run("legalwork")}>{added ? <Check className="size-3.5" /> : <CalendarDays className="size-3.5" />}{added ? "Added to LegalWork calendar" : calendarQuery.data?.item ? "Update LegalWork calendar" : "Add to LegalWork calendar"}</Button>}
      {current.connectorTarget && !update && <Button variant="ghost" size="icon-sm" disabled={!actionable} aria-label="Download .ics" title="Download .ics" onClick={() => void run("download")}><Download className="size-4" /></Button>}
      {current.connectorTarget ? <ConnectorDraftActions draft={current} disabled={!actionable} onSave={() => void run("provider-save")} onOpen={() => void run("provider-open")} /> : <div className="ml-auto flex items-center gap-0">
        <Button size="sm" disabled={!editable} className="gap-2 rounded-l-lg rounded-r-none border-r-0 bg-clip-border px-3.5 motion-safe:active:not-aria-[haspopup]:translate-y-0" onClick={() => void run("system")}>Open in Calendar<ArrowUpRight className="size-3.5" /></Button>
        <DropdownMenu><DropdownMenuTrigger render={<Button size="icon-sm" className="rounded-l-none rounded-r-lg border-l-background/20 bg-clip-border" disabled={!editable} aria-label="Open event in…"><ChevronDown className="size-3.5" /></Button>} /><DropdownMenuContent align="end" className="w-64">
          <DropdownMenuItem onClick={() => void run("google")}><CalendarDays />Open in Google Calendar</DropdownMenuItem>
          <DropdownMenuItem onClick={() => void run("outlook")}><CalendarDays />Open in Outlook</DropdownMenuItem>
          <DropdownMenuItem onClick={() => void run("download")}><Download />Download .ics</DropdownMenuItem>
        </DropdownMenuContent></DropdownMenu>
      </div>}
    </div>
  </Surface>;
}
