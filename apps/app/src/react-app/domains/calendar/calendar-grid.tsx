import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MoveHorizontal, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { CalendarDisplayOccurrence } from "./connected-calendars";
import { CalendarEntry, CalendarTimeBlock } from "./calendar-entries";
import { calendarDay, formatCalendarDay, occursOnDay, shiftDay } from "./calendar-format";
import { CALENDAR_HOUR_HEIGHT, layoutCalendarDay } from "./calendar-layout";

type GridProps = {
  view: "day" | "week" | "month"; anchor: Date; start: Date; items: CalendarDisplayOccurrence[];
  projectId?: string; showProjects: boolean; timeZone: string;
  onOpen: (item: CalendarDisplayOccurrence) => void; onDay: (day: Date) => void; onWeekChange?: (direction: number) => void; onCreate?: (day: string) => void;
};

export function CalendarGrid(props: GridProps) {
  return <div className="@container/calendar-grid flex h-full min-h-0 flex-col gap-2">
    {props.view !== "day" && <p className={cn("flex items-center gap-2 text-xs text-muted-foreground", props.view === "month" && "@min-[700px]/calendar-grid:hidden")}><MoveHorizontal className="size-3.5 shrink-0" />{t(props.view === "week" ? "calendar.scroll_weeks" : "calendar.scroll_days")}</p>}
    {props.view === "month" ? <MonthGrid {...props} /> : <TimeGrid {...props} />}
  </div>;
}

function TimeGrid(props: GridProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<number | null>(null);
  const measuredWidth = useRef(0);
  const paging = useRef(false);
  const week = props.view === "week";
  const count = week ? 21 : 1;
  const days = Array.from({ length: count }, (_, index) => shiftDay(props.start, index - (week ? 7 : 0)));
  const today = calendarDay(new Date());
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 8 * CALENDAR_HOUR_HEIGHT - 12; }, []);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    measuredWidth.current = element.clientWidth;
    element.scrollLeft = week ? pendingScroll.current ?? (element.scrollWidth - 52) / 3 : 0;
    pendingScroll.current = null;
    paging.current = false;
  }, [props.anchor, week]);
  useEffect(() => {
    const element = scroller.current;
    if (!element || !week) return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth !== width) {
        width = element.clientWidth;
        measuredWidth.current = width;
        element.scrollLeft = (element.scrollWidth - 52) / 3;
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [week]);
  const timeZoneLabel = new Intl.DateTimeFormat(currentLocale(), { timeZone: props.timeZone, timeZoneName: "short" }).formatToParts(props.start).find(part => part.type === "timeZoneName")?.value;
  const columns = `52px repeat(${count}, minmax(0, 1fr))`;
  const hasAllDay = props.items.some(item => item.allDay && days.some(day => occursOnDay(item, calendarDay(day))));
  const hourLabel = (hour: number) => new Date(2000, 0, 1, hour).toLocaleTimeString(currentLocale(), { hour: "numeric", minute: "2-digit" });
  const minute = now.getHours() * 60 + now.getMinutes();
  return <div ref={scroller} tabIndex={0} role="region" aria-label={t(props.view === "day" ? "calendar.day_view" : "calendar.week")}
    onScroll={event => {
      if (!week || !props.onWeekChange || paging.current) return;
      const element = event.currentTarget, width = (element.scrollWidth - 52) / 3;
      // ResizeObserver recenters after layout. A resize-induced scroll event
      // must not be mistaken for a gesture into another week.
      if (element.clientWidth !== measuredWidth.current) return;
      const direction = Math.round(element.scrollLeft / width) - 1;
      if (!direction) return;
      paging.current = true;
      pendingScroll.current = element.scrollLeft - direction * width;
      props.onWeekChange(direction);
    }}
    className="min-h-0 flex-1 overflow-auto rounded-xl border border-border/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
    <div style={week ? { width: "calc(300% - 104px)", minWidth: 2176 } : undefined}>
      <div className="sticky top-0 z-20 border-b border-border/70 bg-background shadow-[0_1px_0_var(--border)]">
        <div className="grid" style={{ gridTemplateColumns: columns }}>
          <div className="sticky left-0 z-30 flex items-end justify-center bg-background pb-2 text-[9px] text-muted-foreground" title={props.timeZone}>{timeZoneLabel}</div>
          {days.map(day => {
            const key = calendarDay(day), isToday = key === today;
            return <div key={key} className={cn("group/day flex items-center justify-between gap-1 border-l border-border/60 px-2 py-2", isToday && "bg-primary/[0.025]")}>
              <button type="button" onClick={() => props.onDay(day)} aria-label={t("calendar.view_day", { date: formatCalendarDay(key, { dateStyle: "full" }) })}
                className="flex min-w-0 items-center gap-2 rounded-md text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring">
                <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-lg font-medium tabular-nums", isToday && "bg-foreground text-background")}>{day.getDate()}</span>
                <span className={cn("text-[11px]", isToday ? "font-medium text-foreground" : "text-muted-foreground")}>{day.toLocaleDateString(currentLocale(), { weekday: props.view === "day" ? "long" : "short" })}</span>
              </button>
              {props.onCreate && <DayAdd day={key} onCreate={props.onCreate} />}
            </div>;
          })}
        </div>
        {hasAllDay && <div className="grid" style={{ gridTemplateColumns: columns }}>
          <div className="sticky left-0 z-30 bg-background px-1 pt-2 text-center text-[9px] leading-4 text-muted-foreground">{t("calendar.all_day")}</div>
          {days.map(day => {
            const key = calendarDay(day), entries = props.items.filter(item => item.allDay && occursOnDay(item, key));
            const visible = props.view === "day" ? entries : entries.slice(0, 2);
            return <div key={key} className={cn("min-h-9 space-y-0.5 border-l border-border/60 p-1", key === today && "bg-primary/[0.025]", props.view === "day" && "max-h-32 overflow-y-auto")}>
              {visible.map(item => <CalendarEntry key={item.id} item={item} projectId={props.projectId} compact showProject={props.showProjects} onOpen={() => props.onOpen(item)} />)}
              {entries.length > visible.length && <MoreEntries count={entries.length - visible.length} day={day} onDay={props.onDay} />}
            </div>;
          })}
        </div>}
      </div>
      <div className="grid" style={{ gridTemplateColumns: columns }}>
        <div aria-hidden="true" className="sticky left-0 z-10 bg-background" style={{ height: 24 * CALENDAR_HOUR_HEIGHT }}>
          {Array.from({ length: 24 }, (_, hour) => <span key={hour} className="absolute right-2 -translate-y-1/2 text-[9px] leading-none whitespace-nowrap text-muted-foreground tabular-nums" style={{ top: hour * CALENDAR_HOUR_HEIGHT }}>{hourLabel(hour)}</span>)}
        </div>
        {days.map(day => {
          const key = calendarDay(day);
          return <div key={key} className={cn("relative min-w-0 border-l border-border/60", key === today && "bg-primary/[0.015]", day.getDay() % 6 === 0 && "bg-muted/15")} style={{ height: 24 * CALENDAR_HOUR_HEIGHT }}>
            {Array.from({ length: 48 }, (_, halfHour) => <div aria-hidden="true" key={halfHour} className={cn("pointer-events-none absolute inset-x-0 border-t", halfHour % 2 === 0 ? "border-border/60" : "border-border/25")} style={{ top: halfHour * CALENDAR_HOUR_HEIGHT / 2 }} />)}
            {layoutCalendarDay(props.items, key).map(segment => <CalendarTimeBlock key={segment.item.id} item={segment.item} projectId={props.projectId}
              height={(segment.displayEnd - segment.displayStart) * CALENDAR_HOUR_HEIGHT / 60 - 2}
              style={{ top: segment.displayStart * CALENDAR_HOUR_HEIGHT / 60, left: `calc(${segment.column / segment.columns * 100}% + 2px)`, width: `calc(${segment.span / segment.columns * 100}% - 4px)` }} onOpen={() => props.onOpen(segment.item)} />)}
            {key === today && <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 z-10 border-t border-red-9" style={{ top: minute * CALENDAR_HOUR_HEIGHT / 60 }}><span className="absolute -left-1 -top-1 size-2 rounded-full bg-red-9" /></div>}
          </div>;
        })}
      </div>
    </div>
  </div>;
}

function MonthGrid(props: GridProps) {
  const today = calendarDay(new Date());
  const first = new Date(props.anchor.getFullYear(), props.anchor.getMonth(), 1);
  const weeks = Math.ceil(((first.getDay() + 6) % 7 + new Date(props.anchor.getFullYear(), props.anchor.getMonth() + 1, 0).getDate()) / 7);
  return <div tabIndex={0} role="region" aria-label={t("calendar.month")} className="min-h-0 flex-1 overflow-auto rounded-xl border border-border/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40">
    <div className="grid h-full min-w-[700px] grid-cols-7" style={{ gridTemplateRows: `32px repeat(${weeks}, minmax(100px, 1fr))` }}>
      {Array.from({ length: 7 }, (_, index) => <div key={index} className="sticky top-0 z-10 border-b border-r border-border/60 bg-background px-3 py-2 text-[11px] text-muted-foreground last:border-r-0">{shiftDay(props.start, index).toLocaleDateString(currentLocale(), { weekday: "short" })}</div>)}
      {Array.from({ length: weeks * 7 }, (_, index) => {
        const day = shiftDay(props.start, index), key = calendarDay(day);
        const entries = props.items.filter(item => occursOnDay(item, key)).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
        return <div key={key} className={cn("group/day min-h-0 min-w-0 overflow-hidden border-b border-r border-border/60 p-1 nth-[7n]:border-r-0", day.getMonth() !== props.anchor.getMonth() && "bg-muted/25", key === today && "bg-primary/[0.025]")}>
          <div className="mb-1 flex items-center justify-between px-1">
            <button type="button" aria-label={t("calendar.view_day", { date: formatCalendarDay(key, { dateStyle: "full" }) })} onClick={() => props.onDay(day)} className={cn("flex size-6 items-center justify-center rounded-full text-xs tabular-nums outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring", key === today && "bg-foreground text-background hover:bg-foreground/80", day.getMonth() !== props.anchor.getMonth() && "text-muted-foreground")}>{day.getDate()}</button>
            {props.onCreate && <DayAdd day={key} onCreate={props.onCreate} />}
          </div>
          <div className="space-y-0.5">{entries.slice(0, 2).map(item => <CalendarEntry key={item.id} item={item} projectId={props.projectId} compact showProject={props.showProjects} onOpen={() => props.onOpen(item)} />)}</div>
          {entries.length > 2 && <MoreEntries count={entries.length - 2} day={day} onDay={props.onDay} />}
        </div>;
      })}
    </div>
  </div>;
}

function MoreEntries({ count, day, onDay }: { count: number; day: Date; onDay: (day: Date) => void }) {
  return <button type="button" onClick={() => onDay(day)} aria-label={`${t("calendar.more_entries", { count })} · ${t("calendar.view_day", { date: formatCalendarDay(calendarDay(day), { dateStyle: "full" }) })}`}
    className="block w-full rounded px-1.5 py-0.5 text-left text-[10px] font-medium text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">{t("calendar.more_entries", { count })}</button>;
}

function DayAdd({ day, onCreate }: { day: string; onCreate: (day: string) => void }) {
  return <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon-xs" className="text-muted-foreground opacity-0 group-hover/day:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100" aria-label={t("calendar.add_on_day", { date: formatCalendarDay(day, { dateStyle: "full" }) })} onClick={() => onCreate(day)} />}><Plus className="size-3" /></TooltipTrigger><TooltipContent>{t("calendar.add")}</TooltipContent></Tooltip>;
}
