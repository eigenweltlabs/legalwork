import ICAL from "ical.js";
import type { CalendarItem, CalendarOccurrence } from "@legalwork/types/calendar";
import { CalendarAttachmentPathSchema } from "./schema.js";
import { ApiError } from "../errors.js";
import { addDays, dayInZone, zonedInstant, zoneValid } from "./dates.js";

export const MAX_OCCURRENCES = 10000;
const MAX_STEPS = 200000;
const components = new Set(["vevent", "vtodo", "vjournal", "vfreebusy"]);
export function parseCalendar(text: string): ICAL.Component {
  if (Buffer.byteLength(text) > 2_000_000) throw new ApiError(413, "calendar_too_large", "Calendar imports are limited to 2 MB.");
  try {
    const root = ICAL.Component.fromString(text);
    if (root.name !== "vcalendar" || root.getFirstPropertyValue("version") !== "2.0") throw new Error("Expected VCALENDAR version 2.0.");
    if (root.getAllSubcomponents().length > 2000) throw new Error("Too many calendar components.");
    for (const c of root.getAllSubcomponents()) {
      if (!components.has(c.name) && c.name !== "vtimezone") throw new Error(`Unsupported component ${c.name}.`);
      if (components.has(c.name) && typeof c.getFirstPropertyValue("uid") !== "string") throw new Error("Calendar components need a UID.");
      for (const name of ["dtstart", "dtend", "due", "recurrence-id"]) {
        const p = c.getFirstProperty(name), value = p?.getFirstValue();
        if (value instanceof ICAL.Time) {
          const tzid = p?.getParameter("tzid");
          if (typeof tzid === "string" && !root.getTimeZoneByID(tzid) && !zoneValid(tzid)) throw new Error(`Unknown time zone ${tzid}.`);
        }
      }
    }
    return root;
  } catch (error) { throw new ApiError(400, "invalid_icalendar", error instanceof Error ? error.message : "Invalid iCalendar."); }
}
/** RFC5545 folds at 75 octets, without splitting UTF-8 characters. */
export function serializeCalendar(root: ICAL.Component): string {
  // RFC 5545 section 3.6 requires a component even when the calendar has no entries.
  // A UTC definition keeps the document valid without inventing an event or task.
  if (!root.getAllSubcomponents().length) root.addSubcomponent(ICAL.Component.fromString([
    "BEGIN:VTIMEZONE", "TZID:UTC", "BEGIN:STANDARD", "DTSTART:19700101T000000",
    "TZOFFSETFROM:+0000", "TZOFFSETTO:+0000", "END:STANDARD", "END:VTIMEZONE",
  ].join("\r\n")));
  const unfolded = root.toString().replace(/\r?\n[ \t]/g, "");
  return unfolded.split(/\r?\n/).map(line => {
    const parts: string[] = []; let current = "", bytes = 0;
    for (const character of line) {
      const length = Buffer.byteLength(character);
      if (bytes + length > 75) { parts.push(current); current = " "; bytes = 1; }
      current += character; bytes += length;
    }
    parts.push(current); return parts.join("\r\n");
  }).join("\r\n") + "\r\n";
}
export function emptyCalendar(): ICAL.Component {
  const root = new ICAL.Component("vcalendar"); root.addPropertyWithValue("version", "2.0"); root.addPropertyWithValue("prodid", "-//Eigenwelt Labs//LegalWork//EN"); return root;
}
function valueTime(value: string, zone: string): ICAL.Time {
  if (value.length === 10) return ICAL.Time.fromDateString(value);
  return ICAL.Time.fromJSDate(new Date(zonedInstant(value, zone)), true);
}
function reminderAlarm(item: Pick<CalendarItem, "title" | "provenance">, minutes: number) {
  const alarm = new ICAL.Component("valarm"); alarm.addPropertyWithValue("action", "DISPLAY"); alarm.addPropertyWithValue("description", item.title);
  if (item.provenance.kind === "calculated") {
    const trigger = new ICAL.Property("trigger"); trigger.resetType("date-time");
    trigger.setValue(ICAL.Time.fromJSDate(new Date(Date.parse(item.provenance.calculation.cutoff) - minutes * 60000), true)); alarm.addProperty(trigger);
  } else alarm.addPropertyWithValue("trigger", ICAL.Duration.fromSeconds(-minutes * 60));
  return alarm;
}
const attachmentUri = (path: string) => `legalwork-file:${encodeURIComponent(path)}`;
export function calendarAttachmentPaths(component: ICAL.Component): string[] {
  return component.getAllProperties("attach").flatMap(property => {
    const value = property.getFirstValue();
    if (typeof value !== "string" || !value.startsWith("legalwork-file:")) return [];
    try { const path = CalendarAttachmentPathSchema.safeParse(decodeURIComponent(value.slice(15))); return path.success ? [path.data] : []; }
    catch { return []; }
  });
}
function updateAttachments(component: ICAL.Component, paths: string[]) {
  for (const property of component.getAllProperties("attach")) {
    const value = property.getFirstValue();
    if (typeof value === "string" && value.startsWith("legalwork-file:")) component.removeProperty(property);
  }
  for (const path of paths) component.addPropertyWithValue("attach", attachmentUri(path));
}
export function itemCalendar(item: Pick<CalendarItem, "uid" | "title" | "description" | "kind" | "start" | "end" | "timeZone" | "revision" | "updatedAt" | "status" | "reminders" | "provenance"> & { attachmentPaths?: string[] }): string {
  const root = emptyCalendar(), event = new ICAL.Component("vevent");
  event.addPropertyWithValue("uid", item.uid); event.addPropertyWithValue("summary", item.title);
  event.addPropertyWithValue("description", item.description); event.addPropertyWithValue("sequence", item.revision);
  event.addPropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(item.updatedAt), true));
  event.addPropertyWithValue("last-modified", ICAL.Time.fromJSDate(new Date(item.updatedAt), true));
  if (item.start) event.addPropertyWithValue("dtstart", valueTime(item.start, item.timeZone));
  const end = item.end ?? (item.start?.length === 10 ? addDays(item.start, 1) : null);
  if (end) event.addPropertyWithValue("dtend", valueTime(end, item.timeZone));
  event.addPropertyWithValue("status", item.status === "cancelled" ? "CANCELLED" : "CONFIRMED");
  event.addPropertyWithValue("x-legalwork-kind", item.kind);
  event.addPropertyWithValue("x-legalwork-status", item.status);
  event.addPropertyWithValue("x-legalwork-timezone", item.timeZone);
  for (const minutes of item.reminders) {
    event.addSubcomponent(reminderAlarm(item, minutes));
  }
  updateAttachments(event, item.attachmentPaths ?? []);
  root.addSubcomponent(event); return serializeCalendar(root);
}
/** Patch only exposed properties; retain recurrence, participants, alarms and extensions. */
export function updateCalendar(item: CalendarItem, changed: Set<string>): string {
  const root = parseCalendar(item.ical);
  const master = root.getAllSubcomponents().find(c => components.has(c.name) && !c.hasProperty("recurrence-id"));
  if (!master) throw new ApiError(400, "calendar_master_missing", "Calendar has no master component.");
  if (changed.has("attachmentPaths")) updateAttachments(master, item.attachmentPaths);
  if (changed.has("title")) master.updatePropertyWithValue("summary", item.title);
  if (changed.has("description")) master.updatePropertyWithValue("description", item.description);
  if (changed.has("start") || changed.has("timeZone")) {
    if (master.hasProperty("rrule") || master.hasProperty("rdate")) throw new ApiError(400, "advanced_calendar_edit", "Edit a recurring series through iCalendar replacement to preserve its recurrence rules.");
    if (item.start) master.updatePropertyWithValue(master.name === "vtodo" ? "due" : "dtstart", valueTime(item.start, item.timeZone));
  }
  if (master.name !== "vtodo" && (changed.has("end") || (changed.has("start") && item.start?.length === 10))) {
    const end = item.end ?? (item.start?.length === 10 ? addDays(item.start, 1) : null);
    if (end) master.updatePropertyWithValue(master.name === "vtodo" ? "due" : "dtend", valueTime(end, item.timeZone));
  }
  if (changed.has("status")) master.updatePropertyWithValue("x-legalwork-status", item.status);
  if (changed.has("kind")) master.updatePropertyWithValue("x-legalwork-kind", item.kind);
  if (changed.has("status")) master.updatePropertyWithValue("status", item.status === "cancelled" ? "CANCELLED" : master.name === "vtodo" ? item.status === "completed" ? "COMPLETED" : "NEEDS-ACTION" : "CONFIRMED");
  if (changed.has("reminders")) {
    for (const alarm of master.getAllSubcomponents("valarm")) master.removeSubcomponent(alarm);
    for (const minutes of item.reminders) {
      master.addSubcomponent(reminderAlarm(item, minutes));
    }
  }
  master.updatePropertyWithValue("sequence", Math.max(item.revision, Number(master.getFirstPropertyValue("sequence") ?? 0) + 1));
  const updated = ICAL.Time.fromJSDate(new Date(item.updatedAt), true);
  master.updatePropertyWithValue("dtstamp", updated);
  master.updatePropertyWithValue("last-modified", updated);
  return serializeCalendar(root);
}
function wireTime(time: ICAL.Time, c: ICAL.Component, fallback: string, property = "dtstart"): string {
  if (time.isDate) return time.toString();
  const zone = c.getFirstProperty(property)?.getParameter("tzid");
  if (typeof zone === "string" && !c.parent?.getTimeZoneByID(zone)) return zonedInstant(time.toString(), zone);
  if (time.zone === ICAL.Timezone.localTimezone) return zonedInstant(time.toString(), fallback);
  return time.toJSDate().toISOString();
}
export function occurrences(item: CalendarItem, projectName: string, from: string, to: string): CalendarOccurrence[] {
  if (item.deletedAt || item.status === "cancelled") return [];
  const original = parseCalendar(item.ical), root = emptyCalendar(), todos = new Set<string>();
  for (const source of original.getAllSubcomponents()) {
    const c = ICAL.Component.fromString(source.toString());
    if (c.name === "vtodo" && c.hasProperty("dtstart") && c.hasProperty("due")) {
      todos.add(String(c.getFirstPropertyValue("uid")));
      const event = new ICAL.Component("vevent");
      for (const p of c.getAllProperties()) { const json = p.toJSON(); event.addProperty(new ICAL.Property([p.name === "due" ? "dtend" : p.name, ...json.slice(1)])); }
      root.addSubcomponent(event);
    } else root.addSubcomponent(c);
  }
  const result: CalendarOccurrence[] = [];
  for (const c of root.getAllSubcomponents()) {
    if (!components.has(c.name) || c.hasProperty("recurrence-id")) continue;
    if (!c.hasProperty("dtstart")) {
      const due = c.getFirstPropertyValue("due");
      if (due instanceof ICAL.Time) emit(c, due, null, due.toString(), false, "due");
      continue;
    }
    const event = new ICAL.Event(c, { exceptions: root.getAllSubcomponents(c.name).filter(e => e.hasProperty("recurrence-id")), strictExceptions: true });
    if (!event.isRecurring()) { const todo = todos.has(item.uid); emit(c, todo ? event.endDate : event.startDate, todo ? null : event.endDate, event.startDate.toString(), false, todo ? "dtend" : "dtstart"); continue; }
    let backwardsDays = 0;
    for (const exception of root.getAllSubcomponents(c.name).filter(component => component.hasProperty("recurrence-id"))) {
      const identity = exception.getFirstPropertyValue("recurrence-id"), moved = exception.getFirstPropertyValue("dtstart");
      if (identity instanceof ICAL.Time && moved instanceof ICAL.Time) {
        const originalAt = Date.parse(zonedInstant(wireTime(identity, exception, item.timeZone, "recurrence-id"), item.timeZone));
        const movedAt = Date.parse(zonedInstant(wireTime(moved, exception, item.timeZone), item.timeZone));
        backwardsDays = Math.max(backwardsDays, Math.ceil((originalAt - movedAt) / 86400000));
      }
    }
    const scanUntil = addDays(to, backwardsDays + 2), iterator = event.iterator();
    let next = iterator.next(), steps = 0;
    while (next) {
      if (++steps > MAX_STEPS) throw new ApiError(422, "calendar_expansion_limit", "This recurrence exceeds the expansion limit.");
      const details = event.getOccurrenceDetails(next);
      const todo = todos.has(item.uid);
      emit(details.item.component, todo ? details.endDate : details.startDate, todo ? null : details.endDate, next.toString(), true, todo ? "dtend" : "dtstart");
      // A range override can move an occurrence; do not stop solely at its modified date.
      if (next.toString().slice(0, 10) > scanUntil) break;
      next = iterator.next();
    }
  }
  return result;
  function emit(c: ICAL.Component, start: ICAL.Time, end: ICAL.Time | null, identity: string, recurring: boolean, property = "dtstart") {
    if (c.getFirstPropertyValue("status") === "CANCELLED") return;
    const startValue = wireTime(start, c, item.timeZone, property), endValue = end ? wireTime(end, c, item.timeZone, "dtend") : null;
    const startDay = start.isDate ? startValue : dayInZone(startValue, item.timeZone);
    const endDay = end?.isDate ? endValue : endValue ? dayInZone(endValue, item.timeZone) : startDay;
    if (startDay >= to || (endDay && endDay < from) || (endValue && endValue > startValue && (end?.isDate ? endValue <= from : endValue <= zonedInstant(from, item.timeZone))) || (endValue === null && startDay < from)) return;
    if (result.length >= MAX_OCCURRENCES) throw new ApiError(422, "calendar_expansion_limit", "Too many occurrences in this range.");
    const title = c.getFirstPropertyValue("summary");
    result.push({ id: `${item.id}:${identity}`, itemId: item.id, uid: item.uid, projectId: item.projectId, projectName, kind: item.kind,
      title: typeof title === "string" ? title : item.title, start: startValue, end: endValue, allDay: start.isDate, timeZone: item.timeZone,
      status: item.status, assigneeUserId: item.assigneeUserId, provenance: item.provenance, verified: item.verified, recurring });
  }
}
export function exportCalendar(items: CalendarItem[], profile: "calendar" | "native" = "calendar"): string {
  const root = emptyCalendar(), zones = new Map<string, string>();
  for (const item of items.filter(item => !item.deletedAt)) {
    const source = parseCalendar(item.ical);
    for (const c of source.getAllSubcomponents()) {
      if (c.name === "vtimezone") {
        const id = String(c.getFirstPropertyValue("tzid")), definition = c.toString();
        if (zones.has(id)) { if (zones.get(id) !== definition) throw new ApiError(422, "timezone_conflict", "These calendars have conflicting definitions for one time zone. Export the project calendars separately."); continue; } zones.set(id, definition);
      }
      if (profile === "native" && item.kind === "deadline" && c.name === "vevent" && !source.getAllSubcomponents("vevent").some(event => event.hasProperty("rrule") || event.hasProperty("rdate"))) {
        const todo = new ICAL.Component("vtodo");
        for (const p of c.getAllProperties()) if (!["dtstart", "dtend", "status", "transp"].includes(p.name)) todo.addProperty(new ICAL.Property(p.toJSON()));
        todo.updatePropertyWithValue("uid", item.uid);
        if (item.provenance.kind === "calculated") todo.addPropertyWithValue("due", valueTime(item.provenance.calculation.cutoff, item.timeZone));
        else if (item.start) todo.addPropertyWithValue("due", valueTime(item.start.length === 10 ? zonedInstant(addDays(item.start, 1), item.timeZone) : item.start, item.timeZone));
        todo.addPropertyWithValue("status", item.status === "completed" ? "COMPLETED" : item.status === "cancelled" ? "CANCELLED" : "NEEDS-ACTION");
        for (const a of c.getAllSubcomponents("valarm")) todo.addSubcomponent(ICAL.Component.fromString(a.toString()));
        root.addSubcomponent(todo);
      } else if (profile === "calendar" && c.name === "vtodo") {
        const event = new ICAL.Component("vevent"), hasStart = c.hasProperty("dtstart");
        for (const p of c.getAllProperties()) {
          if (["completed", "percent-complete", "status"].includes(p.name)) continue;
          const json = p.toJSON(), name = p.name === "due" ? hasStart ? "dtend" : "dtstart" : p.name;
          event.addProperty(new ICAL.Property([name, ...json.slice(1)]));
        }
        event.addPropertyWithValue("x-legalwork-kind", "deadline");
        event.addPropertyWithValue("x-legalwork-status", item.status);
        event.addPropertyWithValue("status", item.status === "cancelled" ? "CANCELLED" : "CONFIRMED");
        for (const alarm of c.getAllSubcomponents("valarm")) event.addSubcomponent(ICAL.Component.fromString(alarm.toString()));
        root.addSubcomponent(event);
      } else root.addSubcomponent(ICAL.Component.fromString(c.toString()));
    }
  }
  return serializeCalendar(root);
}
