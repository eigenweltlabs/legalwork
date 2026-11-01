import { useState, type ReactNode } from "react";
import { Bell, CalendarDays, Check, ChevronDown, Clock3, ExternalLink, FileText, Globe2, MapPin, Repeat2, UserRound, Users, Video, type LucideIcon } from "lucide-react";
import { openDesktopUrl } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { currentLocale, t } from "@/i18n";
import { cn } from "@/lib/utils";
import { calendarDisplayColor } from "./calendar-colors";
import { calendarDay, formatCalendarDay, occurrenceDay, occurrenceTimeRange, shiftDay } from "./calendar-format";
import { CalendarEventDescription, CalendarEventLink } from "./calendar-event-description";
import { calendarRecurrence } from "./calendar-recurrence";
import { safeCalendarUrl, type CalendarDisplayOccurrence } from "./connected-calendars";

export function ConnectedCalendarEventDialog({ item, onClose }: { item: CalendarDisplayOccurrence; onClose: () => void }) {
  const [showAllAttendees, setShowAllAttendees] = useState(false);
  const details = item.connectedEvent;
  if (!details) return null;
  const day = occurrenceDay(item);
  const endDay = item.end ? item.allDay ? calendarDay(shiftDay(new Date(`${item.end.slice(0, 10)}T12:00:00`), -1)) : occurrenceDay({ ...item, start: item.end }) : day;
  const date = formatCalendarDay(day, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const color = calendarDisplayColor(details.calendar.key, details.calendar.color);
  const joinUrl = safeCalendarUrl(details.conference?.url ?? null);
  const attendees = showAllAttendees ? details.attendees : details.attendees.slice(0, 4);
  const hasMain = Boolean(details.description || details.attendees.length);
  const hasOrganizer = Boolean(details.organizer?.displayName || details.organizer?.email);
  const hasSidebar = Boolean(details.location || hasOrganizer || item.recurring || details.reminders || details.attachments.length || details.hasAttachments || details.source?.url);
  const hasContent = hasMain || hasSidebar;
  const hasActions = Boolean(joinUrl || details.webUrl);
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className={cn("flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0", hasMain && hasSidebar ? "sm:max-w-[820px]" : hasMain ? "sm:max-w-[600px]" : "sm:max-w-[480px]")}>
      <DialogHeader className={cn("shrink-0 gap-3 px-6 pb-5 pt-6 sm:px-7", hasContent && "border-b border-border/60")}>
        <DialogDescription className="flex flex-wrap items-center gap-2 pr-8 text-xs">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-muted/70 px-2 py-1 font-medium text-foreground"><span aria-hidden style={color.style} className={cn("size-1.5 rounded-full bg-current", color.marker)} />{details.calendar.name}</span>
          <span>{details.calendar.providerName}</span>
          {item.status === "cancelled" && <Badge variant="destructive">{t("calendar.cancelled")}</Badge>}
        </DialogDescription>
        <DialogTitle className="pr-8 text-xl font-semibold leading-snug tracking-tight sm:text-2xl">{item.title || t("calendar.event")}</DialogTitle>
        <div className="space-y-2 pt-1">
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            <p className="flex items-center gap-2"><CalendarDays aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />{date}{endDay > day && <> → {formatCalendarDay(endDay, { dateStyle: "long" })}</>}</p>
            <p className="flex items-center gap-2"><Clock3 aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />{occurrenceTimeRange(item)}</p>
          </div>
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground"><Globe2 aria-hidden className="size-3" />{item.timeZone}{details.timeZone && details.timeZone !== item.timeZone && <span>· {t("calendar.original_timezone")}: {details.timeZone}</span>}</p>
        </div>
      </DialogHeader>
      {hasContent && <div className="max-h-[65vh] min-h-0 min-w-0 overflow-y-auto px-6 py-6 sm:px-7">
        <div className={cn("grid gap-7", hasMain && hasSidebar && "sm:grid-cols-[minmax(0,1fr)_220px] sm:gap-8")}>
          {hasMain && <div className="min-w-0 space-y-7">
            {details.description && <DetailSection icon={FileText} title={t("calendar.event_description")}><div className="text-sm leading-relaxed text-foreground/85"><CalendarEventDescription text={details.description} html={details.descriptionType?.toLowerCase() === "html"} /></div></DetailSection>}
            {details.attendees.length > 0 && <DetailSection icon={Users} title={t("calendar.attendees")} count={details.attendees.length}>
              <ul className="space-y-3.5">{attendees.map((person, index) => <li key={index} className="flex min-w-0 items-center gap-2.5">
                <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/50 text-[11px] font-medium text-muted-foreground">{(person.displayName || person.email || "?").split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase()}</span>
                <div className="min-w-0 flex-1"><p className="break-words text-sm">{person.displayName || person.email}{person.optional && <span className="ml-1.5 text-[10px] text-muted-foreground">({t("calendar.optional_attendee")})</span>}</p>{person.displayName && person.email && <p className="break-all text-xs text-muted-foreground">{person.email}</p>}</div>
                {person.responseStatus && <span className={cn("flex shrink-0 items-center gap-1 rounded-full bg-muted/60 px-2 py-1 text-[10px] text-muted-foreground", person.responseStatus === "accepted" && "bg-green-3/60 text-green-11")}>{person.responseStatus === "accepted" && <Check className="size-3" />}{attendeeResponse(person.responseStatus)}</span>}
              </li>)}</ul>
              {details.attendees.length > 4 && <Button variant="ghost" size="sm" className="mt-2 h-7 px-0 text-xs text-muted-foreground" onClick={() => setShowAllAttendees(value => !value)}>{t(showAllAttendees ? "calendar.fewer_attendees" : "calendar.all_attendees", { count: details.attendees.length })}<ChevronDown className={cn("size-3", showAllAttendees && "rotate-180")} /></Button>}
            </DetailSection>}
          </div>}
          {hasSidebar && <div className={cn("min-w-0 space-y-6", hasMain && "sm:border-l sm:border-border/60 sm:pl-6")}>
            {details.location && <DetailSection icon={MapPin} title={t("calendar.event_location")}><div className="text-sm leading-relaxed"><CalendarEventDescription text={details.location} html={false} /></div></DetailSection>}
            {hasOrganizer && details.organizer && <DetailSection icon={UserRound} title={t("calendar.organizer")}><p className="break-words text-sm">{details.organizer.displayName || details.organizer.email}</p>{details.organizer.displayName && details.organizer.email && <p className="mt-1 break-all text-xs text-muted-foreground">{details.organizer.email}</p>}</DetailSection>}
            {item.recurring && <RepeatSchedule rules={details.recurrence} day={day} />}
            {details.reminders && <DetailSection icon={Bell} title={t("calendar.reminder")}><div className="space-y-1.5 text-sm">{details.reminders.useDefault ? <p>{t("calendar.default_reminders")}</p> : details.reminders.overrides?.length ? details.reminders.overrides.map((reminder, index) => <p key={index}>{t("calendar.minutes_before", { count: reminder.minutes })}<span className="mt-0.5 block text-xs text-muted-foreground">{reminder.method === "popup" ? t("calendar.notification") : reminder.method === "email" ? t("calendar.email_reminder") : reminder.method}</span></p>) : <p>{t("calendar.reminder_none")}</p>}</div></DetailSection>}
            {(details.attachments.length > 0 || details.hasAttachments) && <DetailSection icon={FileText} title={t("calendar.attachments")}><ul className="space-y-2 text-xs">{details.attachments.map((attachment, index) => <li key={index} className="rounded-lg border border-border/60 bg-muted/20 p-2.5"><CalendarEventLink url={attachment.fileUrl}>{attachment.title || attachment.fileUrl || t("calendar.attachments")}</CalendarEventLink></li>)}</ul>{!details.attachments.length && <p className="text-xs leading-relaxed text-muted-foreground">{t("calendar.provider_attachments")}</p>}</DetailSection>}
            {details.source?.url && <DetailSection icon={ExternalLink} title={t("calendar.source")}><p className="text-xs"><CalendarEventLink url={details.source.url}>{details.source.title || details.source.url}</CalendarEventLink></p></DetailSection>}
          </div>}
        </div>
      </div>}
      {hasActions && <DialogFooter className="mx-0 mb-0 shrink-0 flex-wrap gap-2 border-t border-border/60 bg-muted/15 px-6 py-4 sm:px-7">
        <Button variant="ghost" className="sm:mr-auto" onClick={onClose}>{t("common.close")}</Button>
        {details.webUrl && <Button variant="outline" onClick={() => { if (details.webUrl) void openDesktopUrl(details.webUrl); }}><ExternalLink />{t("calendar.open_in_provider", { provider: details.calendar.providerName })}</Button>}
        {joinUrl && <Button onClick={() => { void openDesktopUrl(joinUrl); }}><Video />{t("calendar.join_meeting")}</Button>}
      </DialogFooter>}
    </DialogContent>
  </Dialog>;
}

function DetailSection({ icon: Icon, title, count, children }: { icon: LucideIcon; title: string; count?: number; children: ReactNode }) {
  return <section className="min-w-0 space-y-3"><h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><Icon aria-hidden className="size-3.5" />{title}{count !== undefined && <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">{count}</span>}</h3>{children}</section>;
}

function RepeatSchedule({ rules, day }: { rules: string[]; day: string }) {
  const rule = calendarRecurrence(rules);
  const frequencies: Record<string, string> = { DAILY: "calendar.repeat_daily", WEEKLY: "calendar.repeat_weekly", MONTHLY: "calendar.repeat_monthly", YEARLY: "calendar.repeat_yearly", HOURLY: "calendar.repeat_hourly" };
  const frequency = rule ? frequencies[rule.frequency] : undefined;
  const weekdays = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
  const days = rule?.days.length ? rule.days.map(day => day.slice(-2)) : [weekdays[(new Date(`${day}T12:00:00`).getDay() + 6) % 7]];
  return <DetailSection icon={Repeat2} title={t("calendar.recurring")}>
    <div className="space-y-3 rounded-xl border border-border/60 bg-muted/25 p-3">
      <p className="text-sm font-medium">{frequency && rule ? t(frequency, { count: rule.interval }) : t("calendar.recurring_event")}</p>
      {rule?.frequency === "WEEKLY" && <div className="flex justify-between gap-1" aria-label={t("calendar.repeat_days")}>{weekdays.map((key, index) => {
        const label = new Intl.DateTimeFormat(currentLocale(), { weekday: "long" }).format(new Date(2026, 0, 5 + index));
        return <span key={key} title={label} aria-label={`${label}: ${t(days.includes(key) ? "calendar.selected_day" : "calendar.unselected_day")}`} className={cn("flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium", days.includes(key) ? "bg-foreground text-background" : "text-muted-foreground")}>{label.slice(0, 1)}</span>;
      })}</div>}
      {rule?.days.length && rule.frequency !== "WEEKLY" ? <p className="text-xs text-muted-foreground">{rule.days.map(value => {
        const index = weekdays.indexOf(value.slice(-2));
        const label = index >= 0 ? new Intl.DateTimeFormat(currentLocale(), { weekday: "long" }).format(new Date(2026, 0, 5 + index)) : value;
        return value.startsWith("-1") ? t("calendar.repeat_last_weekday", { day: label }) : value.length > 2 ? t("calendar.repeat_nth_weekday", { count: value.slice(0, -2), day: label }) : label;
      }).join(", ")}</p> : null}
      {rule?.monthDays.length ? <p className="text-xs text-muted-foreground">{t("calendar.repeat_month_days", { days: rule.monthDays.join(", ") })}</p> : null}
      <p className="border-t border-border/60 pt-2 text-xs leading-relaxed text-muted-foreground">{rule ? rule.count ? t("calendar.repeat_count", { count: rule.count }) : rule.until ? t("calendar.repeat_until", { date: formatCalendarDay(rule.until, { dateStyle: "medium" }) }) : t("calendar.repeat_no_end") : t("calendar.repeat_provider_schedule")}</p>
      {rule?.advanced && <p className="text-xs text-muted-foreground">{t("calendar.repeat_provider_schedule")}</p>}
    </div>
  </DetailSection>;
}

function attendeeResponse(value: string) {
  const labels: Record<string, string> = {
    accepted: t("calendar.response_accepted"), declined: t("calendar.response_declined"),
    tentative: t("calendar.response_tentative"), tentativelyAccepted: t("calendar.response_tentative"),
    needsAction: t("calendar.response_pending"), notResponded: t("calendar.response_pending"), none: t("calendar.response_pending"),
    organizer: t("calendar.organizer"),
  };
  return labels[value] ?? value;
}
