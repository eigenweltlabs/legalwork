import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, ChevronRight, Loader2, Plus, Timer } from "lucide-react";
import type { CalendarItem, CalendarOccurrence } from "@legalwork/types/calendar";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { toast } from "@/components/ui/sonner";
import { SectionHeading, Surface } from "@/react-app/design-system/surface";
import { cn } from "@/lib/utils";
import { workspaceCalendarRoute } from "../../shell/workspace-routes";
import { t } from "@/i18n";
import { deadlineReviewLabel, calendarDay, calendarError, formatCalendarDay, isActive, occurrenceDay, shiftDay } from "./calendar-format";
import { useCalendarOccurrences, useCalendarRefresh } from "./calendar-queries";
import { calendarProjectColor } from "./calendar-colors";
import { DeadlineDialog } from "./deadline-dialog";

export function UpcomingDeadlines(props: { client: LegalworkServerClient; workspaceId: string; projectId: string; projectName: string }) {
  const navigate = useNavigate(), refresh = useCalendarRefresh();
  const color = calendarProjectColor(props.projectId);
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
  return <section className="flex min-w-0" aria-label={t("calendar.upcoming")}>
    <Surface className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border-border/60 shadow-none">
    <SectionHeading className="items-center border-b border-border/50 px-4 py-3" title={t("calendar.upcoming")} action={<>
      <Button variant="ghost" size="icon-sm" aria-label={t("calendar.add")} title={t("calendar.add")} onClick={() => setEditing("new")}><Plus className="size-4" /></Button>
    </>} />
    <div className="flex min-h-36 flex-1 flex-col">
      {query.isPending ? <p role="status" className="flex items-center gap-2 p-4 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("calendar.loading")}</p>
        : query.isError ? <div role="alert" className="flex items-center justify-between gap-3 p-4 text-xs"><span>{calendarError(query.error)}</span><Button variant="ghost" size="sm" onClick={refresh}>{t("workspace_files.try_again")}</Button></div>
        : items.length ? <div className="space-y-1 p-2">{items.map(item => <Button key={item.id} variant="ghost" className="group h-auto w-full min-w-0 justify-start gap-3 rounded-lg px-2 py-3 text-left font-normal" disabled={opening} onClick={() => void open(item)}>
          <time dateTime={occurrenceDay(item)} aria-label={formatCalendarDay(occurrenceDay(item), { dateStyle: "full" })} className={cn("flex size-11 shrink-0 flex-col items-center justify-center rounded-lg border tabular-nums", color.card, color.accent)}>
            <span className="text-[10px] leading-3 font-medium uppercase">{formatCalendarDay(occurrenceDay(item), { month: "short" })}</span>
            <span className="text-lg leading-6 font-semibold">{formatCalendarDay(occurrenceDay(item), { day: "numeric" })}</span>
          </time>
          <span className="min-w-0 flex-1"><span className="block truncate text-[13px] leading-5 font-medium text-foreground">{item.title}</span><span className="mt-0.5 block text-xs text-muted-foreground">{occurrenceDay(item) === from ? `${t("calendar.today")} · ` : ""}{deadlineReviewLabel(item)}</span></span>
          <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-foreground" />
        </Button>)}</div>
        : <Empty variant="ghost" className="gap-3 rounded-none p-5 sm:p-5">
          <EmptyHeader className="gap-1.5"><EmptyMedia className="mb-0 text-muted-foreground"><Timer className="size-5" /></EmptyMedia><EmptyTitle className="text-sm">{t("calendar.no_upcoming")}</EmptyTitle></EmptyHeader>
          <Button variant="outline" size="sm" className="text-xs" onClick={() => setEditing("new")}>{t("calendar.add")}</Button>
        </Empty>}
    </div>
    <footer className="mt-auto border-t border-border/50">
      <Button variant="ghost" className="h-10 w-full justify-between rounded-none px-4 text-xs text-muted-foreground" onClick={() => navigate(workspaceCalendarRoute(props.projectId))}>{t("projects.view_all")}<ArrowUpRight className="size-3.5" /></Button>
    </footer>
    </Surface>
    {editing && <DeadlineDialog key={typeof editing === "string" ? "new" : editing.id} client={props.client} workspaceId={props.workspaceId} projectId={props.projectId} projectName={props.projectName} item={editing === "new" ? null : editing} day={from} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refresh(); }} />}
  </section>;
}
