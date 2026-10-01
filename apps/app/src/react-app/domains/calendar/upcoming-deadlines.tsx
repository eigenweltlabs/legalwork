import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, Loader2, Plus, Timer } from "lucide-react";
import type { CalendarItem, CalendarOccurrence } from "@legalwork/types/calendar";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { SectionHeading, Surface } from "@/react-app/design-system/surface";
import { workspaceCalendarRoute } from "../../shell/workspace-routes";
import { t } from "@/i18n";
import { deadlineReviewLabel, calendarDay, calendarError, formatCalendarDay, isActive, occurrenceDay, shiftDay } from "./calendar-format";
import { useCalendarOccurrences, useCalendarRefresh } from "./calendar-queries";
import { DeadlineDialog } from "./deadline-dialog";

export function UpcomingDeadlines(props: { client: LegalworkServerClient; workspaceId: string; projectId: string; projectName: string }) {
  const navigate = useNavigate(), refresh = useCalendarRefresh();
  const today = new Date(), from = calendarDay(today), to = calendarDay(shiftDay(today, 90));
  const query = useCalendarOccurrences(props, from, to);
  const items = (query.data?.occurrences ?? []).filter(item => item.kind === "deadline" && isActive(item) && occurrenceDay(item) >= from).slice(0, 5);
  const [editing, setEditing] = useState<CalendarItem | "new" | null>(null), [opening, setOpening] = useState(false);
  const open = async (item: CalendarOccurrence) => {
    if (opening) return;
    setOpening(true);
    try { setEditing((await props.client.calendarItem(props.workspaceId, item.itemId)).item); }
    catch (error) { toast.error(calendarError(error)); } finally { setOpening(false); }
  };
  return <section className="min-w-0" aria-label={t("calendar.upcoming")}>
    <SectionHeading title={t("calendar.upcoming")} action={<>
      <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={() => navigate(workspaceCalendarRoute(props.projectId))}>{t("projects.view_all")}<ArrowUpRight className="size-3.5" /></Button>
      <Button variant="ghost" size="icon-sm" aria-label={t("calendar.add")} title={t("calendar.add")} onClick={() => setEditing("new")}><Plus className="size-4" /></Button>
    </>} />
    <Surface className="mt-3 overflow-hidden rounded-xl border-border/60 shadow-none">
      {query.isPending ? <p role="status" className="flex items-center gap-2 p-4 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("calendar.loading")}</p>
        : query.isError ? <div role="alert" className="flex items-center justify-between gap-3 p-4 text-xs"><span>{calendarError(query.error)}</span><Button variant="ghost" size="sm" onClick={refresh}>{t("workspace_files.try_again")}</Button></div>
        : items.length ? <div className="divide-y divide-border/60">{items.map(item => <Button key={item.id} variant="ghost" className="h-auto w-full justify-start gap-3 rounded-none px-4 py-3 text-left font-normal" disabled={opening} onClick={() => void open(item)}>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-3/40 text-amber-11"><Timer className="size-4" /></span>
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{item.title}</span><span className="mt-0.5 block text-xs text-muted-foreground">{deadlineReviewLabel(item)}</span></span>
          <time dateTime={occurrenceDay(item)} className="shrink-0 text-xs tabular-nums text-muted-foreground">{occurrenceDay(item) === from ? t("calendar.today") : formatCalendarDay(occurrenceDay(item))}</time>
        </Button>)}</div>
        : <div className="flex min-h-24 flex-wrap items-center gap-3 px-4 py-4"><span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-amber-3/40 text-amber-11"><Timer className="size-4" /></span><p className="min-w-36 flex-1 text-xs leading-5 text-muted-foreground">{t("calendar.no_upcoming")}</p><Button variant="ghost" size="sm" className="text-xs" onClick={() => setEditing("new")}><Plus className="size-3.5" />{t("calendar.add")}</Button></div>}
    </Surface>
    {editing && <DeadlineDialog key={typeof editing === "string" ? "new" : editing.id} client={props.client} workspaceId={props.workspaceId} projectId={props.projectId} projectName={props.projectName} item={editing === "new" ? null : editing} day={from} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
  </section>;
}
