import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MoveHorizontal, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { CalendarDisplayOccurrence } from "./connected-calendars";
import { CalendarEntry, CalendarTimeBlock, type CalendarEntryAppearance } from "./calendar-entries";
import { calendarDisplayColor } from "./calendar-colors";
import { calendarDay, formatCalendarDay, occursOnDay, shiftDay } from "./calendar-format";
import { CALENDAR_HOUR_HEIGHT, layoutCalendarDay } from "./calendar-layout";

type CalendarDayLane = { id: string; title: string; colorKey: string | null; items: CalendarDisplayOccurrence[] };
type GridProps = {
  view: "day" | "week" | "month"; anchor: Date; start: Date; items: CalendarDisplayOccurrence[];
  projectId?: string; showProjects: boolean; timeZone: string;
  dayLanes?: CalendarDayLane[]; untimedLabel?: string; preamble?: ReactNode; label?: string;
  nowLabel?: (clock: string) => string;
  renderTimeOverlay?: (now: Date) => ReactNode;
  entryAppearance?: (item: CalendarDisplayOccurrence) => CalendarEntryAppearance | undefined;
  minimumEventSize?: { width: number; height: number };
  onOpen: (item: CalendarDisplayOccurrence, trigger: HTMLButtonElement) => void;
  onDay?: (day: Date) => void; onWeekChange?: (direction: number) => void; onCreate?: (day: string) => void;
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
  const firstUntimedDay = useRef<string>(undefined);
  const week = props.view === "week";
  const days = Array.from({ length: week ? 21 : 1 }, (_, index) => shiftDay(props.start, index - (week ? 7 : 0)));
  const [now, setNow] = useState(() => new Date());
  const today = calendarDay(now);
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 60_000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (scroller.current) scroller.current.scrollTop = 8 * CALENDAR_HOUR_HEIGHT - 12; }, []);
  useEffect(() => {
    if (!props.untimedLabel || !scroller.current || !props.items.length) return;
    const day = calendarDay(props.start);
    if (firstUntimedDay.current === day) return;
    firstUntimedDay.current = day;
    // The workday's untimed entries flow with the hours in the single scroller.
    // Show them on first load without resetting position on later refreshes.
    scroller.current.scrollTop = props.items.some(item => item.allDay && occursOnDay(item, day)) ? 0 : 8 * CALENDAR_HOUR_HEIGHT - 12;
  }, [props.items, props.start, props.untimedLabel]);
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
  const lanes = week ? undefined : props.dayLanes;
  const columns = lanes?.length
    ? lanes.map(lane => ({ ...lane, day: props.start }))
    : days.map(day => ({ id: calendarDay(day), title: undefined, colorKey: null, day, items: props.items }));
  const minimumEventSize = props.minimumEventSize;
  const layouts = columns.map(column => layoutCalendarDay(column.items, calendarDay(column.day),
    minimumEventSize && { minimumMinutes: Math.ceil((minimumEventSize.height + 2) * 60 / CALENDAR_HOUR_HEIGHT), anchorAtActualStart: true }));
  const minimumLaneWidths = layouts.map(segments => Math.max(lanes?.length ? 116 : 0,
    minimumEventSize ? minimumEventSize.width + 4 : 0,
    ...(minimumEventSize ? segments.map(segment => segment.columns * (minimumEventSize.width + 4)) : [])));
  const tracks = `52px ${minimumLaneWidths.map(width => `minmax(${width}px, 1fr)`).join(" ")}`;
  const minimumWidth = minimumLaneWidths.reduce((total, width) => total + width, 0);
  const timeZoneLabel = new Intl.DateTimeFormat(currentLocale(), { timeZone: props.timeZone, timeZoneName: "short" }).formatToParts(props.start).find(part => part.type === "timeZoneName")?.value;
  const hourLabel = (hour: number) => new Date(2000, 0, 1, hour).toLocaleTimeString(currentLocale(), { hour: "numeric", minute: "2-digit" });
  const minute = now.getHours() * 60 + now.getMinutes();
  const untimed = columns.map(column => column.items.filter(item => item.allDay && occursOnDay(item, calendarDay(column.day))));
  const hasAllDay = untimed.some(items => items.length > 0);
  const onDay = props.onDay;
  const allDayRow = hasAllDay && (
    <div className="grid" style={{ gridTemplateColumns: tracks }} data-calendar-untimed={props.untimedLabel ? "" : undefined}
      role={props.untimedLabel ? "group" : undefined} aria-label={props.untimedLabel}>
      {props.untimedLabel && <div className="col-span-full sticky left-0 bg-background px-2 py-1.5 text-xs font-medium text-muted-foreground">{props.untimedLabel}</div>}
      <div className="sticky left-0 z-30 bg-background px-1 pt-2 text-center text-[9px] leading-4 text-muted-foreground">
        {!props.untimedLabel && t("calendar.all_day")}
      </div>
      {columns.map((column, index) => {
        const entries = untimed[index];
        const visible = week ? entries.slice(0, 2) : entries;
        return <div key={column.id} className={cn("min-h-9 space-y-0.5 border-l border-border/60 p-1", calendarDay(column.day) === today && "bg-primary/[0.025]", !week && !props.untimedLabel && "max-h-32 overflow-y-auto")}>
          {visible.map(item => <CalendarEntry key={item.id} item={item} projectId={props.projectId} compact showProject={props.showProjects}
            appearance={props.entryAppearance?.(item)} onOpen={trigger => props.onOpen(item, trigger)} />)}
          {entries.length > visible.length && onDay && <MoreEntries count={entries.length - visible.length} day={column.day} onDay={onDay} />}
        </div>;
      })}
    </div>
  );
  return <div ref={scroller} tabIndex={0} role="region" data-calendar-time-grid
    aria-label={props.label ?? t(props.view === "day" ? "calendar.day_view" : "calendar.week")}
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
    {props.preamble && <div className="sticky left-0 px-2">{props.preamble}</div>}
    <div style={week ? { width: "calc(300% - 104px)", minWidth: 2176 } : minimumWidth ? { minWidth: 52 + minimumWidth } : undefined}>
      <div className="sticky top-0 z-20 border-b border-border/70 bg-background shadow-[0_1px_0_var(--border)]">
        <div className="grid" style={{ gridTemplateColumns: tracks }}>
          <div className="sticky left-0 z-30 flex items-end justify-center bg-background pb-2 text-[9px] text-muted-foreground" title={props.timeZone}>{timeZoneLabel}</div>
          {columns.map(column => {
            const { day, title } = column;
            const key = calendarDay(day), isToday = key === today;
            const dayLabel = <>
              <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-lg font-medium tabular-nums", isToday && "bg-foreground text-background")}>{day.getDate()}</span>
              <span className={cn("text-[11px]", isToday ? "font-medium text-foreground" : "text-muted-foreground")}>{day.toLocaleDateString(currentLocale(), { weekday: week ? "short" : "long" })}</span>
            </>;
            return <div key={column.id} className={cn("group/day flex items-center justify-between gap-1 border-l border-border/60 px-2 py-2", isToday && "bg-primary/[0.025]")}>
              {title !== undefined ? <div className="flex min-w-0 items-center gap-2 text-xs font-medium" title={title}>
                <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full bg-current", calendarDisplayColor(column.colorKey).marker)} />
                <span className="truncate">{title}</span>
              </div> : onDay ? <button type="button" onClick={() => onDay(day)} aria-label={t("calendar.view_day", { date: formatCalendarDay(key, { dateStyle: "full" }) })}
                className="flex min-w-0 items-center gap-2 rounded-md text-left outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring">
                {dayLabel}
              </button> : <div className="flex min-w-0 items-center gap-2">{dayLabel}</div>}
              {props.onCreate && <DayAdd day={key} onCreate={props.onCreate} />}
            </div>;
          })}
        </div>
        {!props.untimedLabel && allDayRow}
      </div>
      {props.untimedLabel && allDayRow}
      <div className="relative grid" style={{ gridTemplateColumns: tracks }}>
        <div aria-hidden="true" data-calendar-hours className="sticky left-0 z-10 bg-background" style={{ height: 24 * CALENDAR_HOUR_HEIGHT }}>
          {Array.from({ length: 24 }, (_, hour) => <span key={hour} className="absolute right-2 -translate-y-1/2 text-[9px] leading-none whitespace-nowrap text-muted-foreground tabular-nums" style={{ top: hour * CALENDAR_HOUR_HEIGHT }}>{hourLabel(hour)}</span>)}
        </div>
        {columns.map((column, index) => {
          const key = calendarDay(column.day);
          return <div key={column.id} data-calendar-column={column.id} className={cn("relative min-w-0 border-l border-border/60", key === today && "bg-primary/[0.015]", column.day.getDay() % 6 === 0 && "bg-muted/15")} style={{ height: 24 * CALENDAR_HOUR_HEIGHT }}>
            {Array.from({ length: 48 }, (_, halfHour) => <div aria-hidden="true" key={halfHour} className={cn("pointer-events-none absolute inset-x-0 border-t", halfHour % 2 === 0 ? "border-border/60" : "border-border/25")} style={{ top: halfHour * CALENDAR_HOUR_HEIGHT / 2 }} />)}
            {layouts[index].map(segment => <CalendarTimeBlock key={segment.item.id} item={segment.item} projectId={props.projectId}
              height={(segment.displayEnd - segment.displayStart) * CALENDAR_HOUR_HEIGHT / 60 - 2} appearance={props.entryAppearance?.(segment.item)}
              style={{ top: segment.displayStart * CALENDAR_HOUR_HEIGHT / 60, left: `calc(${segment.column / segment.columns * 100}% + 2px)`, width: `calc(${segment.span / segment.columns * 100}% - 4px)` }}
              onOpen={trigger => props.onOpen(segment.item, trigger)} />)}
            {week && key === today && <CalendarNow minute={minute} />}
          </div>;
        })}
        {!week && props.renderTimeOverlay && <div className="pointer-events-none absolute inset-y-0 start-[52px] end-0">
          {props.renderTimeOverlay(now)}
        </div>}
        {!week && calendarDay(props.start) === today && <CalendarNow minute={minute} inset={52}
          label={props.nowLabel?.(now.toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" }))} />}
      </div>
    </div>
  </div>;
}

function CalendarNow({ minute, inset, label }: { minute: number; inset?: number; label?: string }) {
  return <div data-calendar-now aria-hidden={!label || undefined} className="pointer-events-none absolute inset-x-0 z-10 border-t border-red-9"
    style={{ left: inset, top: minute * CALENDAR_HOUR_HEIGHT / 60 }}>
    <span aria-hidden="true" className="absolute -left-1 -top-1 size-2 rounded-full bg-red-9" />
    {label && <span className="sr-only">{label}</span>}
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
            <button type="button" aria-label={t("calendar.view_day", { date: formatCalendarDay(key, { dateStyle: "full" }) })} onClick={() => props.onDay?.(day)} className={cn("flex size-6 items-center justify-center rounded-full text-xs tabular-nums outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring", key === today && "bg-foreground text-background hover:bg-foreground/80", day.getMonth() !== props.anchor.getMonth() && "text-muted-foreground")}>{day.getDate()}</button>
            {props.onCreate && <DayAdd day={key} onCreate={props.onCreate} />}
          </div>
          <div className="space-y-0.5">{entries.slice(0, 2).map(item => <CalendarEntry key={item.id} item={item} projectId={props.projectId} compact showProject={props.showProjects} onOpen={trigger => props.onOpen(item, trigger)} />)}</div>
          {entries.length > 2 && props.onDay && <MoreEntries count={entries.length - 2} day={day} onDay={props.onDay} />}
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
