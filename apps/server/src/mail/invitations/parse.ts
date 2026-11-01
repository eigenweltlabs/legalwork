import ICAL from "ical.js";
import { parseCalendar } from "../../calendar/ical.js";
import { dayDate, zonedInstant } from "../../calendar/dates.js";
import { MailServiceError } from "../service-interface.js";
import { mailInvitationsSchema, type MailInvitationTime } from "../invitation-view.js";

export const MAX_INVITATION_BYTES = 256 * 1024;

function text(event: ICAL.Component, name: string): string {
  const value: unknown = event.getFirstPropertyValue(name);
  return typeof value === "string" ? value : "";
}
function address(value: unknown): string | null {
  if (typeof value !== "string" || !/^mailto:/i.test(value)) return null;
  const email = value.slice(7);
  return email.length <= 1000 && /^[^\s<>@\u0000-\u001f]+@[^\s<>@\u0000-\u001f]+$/.test(email) ? email : null;
}
function time(event: ICAL.Component, name: string, duration?: ICAL.Duration): MailInvitationTime | null {
  const property = event.getFirstProperty(name);
  if (!property) return null;
  // Validate the original jCal value before ICAL.Time can normalize an invalid day.
  const raw: unknown = property.toJSON();
  const original = Array.isArray(raw) ? raw[3] : null;
  if (typeof original !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z?)?$/.test(original)) throw Error("invalid time");
  dayDate(original.slice(0, 10));
  if (original.length > 10 && (Number(original.slice(11, 13)) > 23 || Number(original.slice(14, 16)) > 59 || Number(original.slice(17, 19)) > 59)) throw Error("invalid time");
  const source: unknown = property.getFirstValue();
  if (!(source instanceof ICAL.Time)) throw Error("invalid time");
  const value = source.clone();
  if (duration) {
    if (value.isDate && (duration.hours || duration.minutes || duration.seconds)) throw Error("invalid date duration");
    value.addDuration(duration);
  }
  const stamp = value.toString();
  if (value.isDate) return { value: stamp, kind: "date", timeZone: null, instant: null };
  if (value.zone === ICAL.Timezone.utcTimezone) return { value: stamp, kind: "utc", timeZone: "UTC", instant: value.toJSDate().toISOString() };
  const zone = property.getParameter("tzid");
  if (typeof zone !== "string") return { value: stamp, kind: "floating", timeZone: null, instant: null };
  let instant: string | null = null;
  try { instant = event.parent?.getTimeZoneByID(zone) ? value.toJSDate().toISOString() : zonedInstant(stamp, zone); }
  catch { /* Ambiguous wall times remain visible in their source zone. */ }
  return { value: stamp, kind: "zoned", timeZone: zone, instant };
}

/** Read-only view of the original attachment. Never imports events or runs alarms. */
export function parseMailInvitations(bytes: Uint8Array) {
  if (bytes.byteLength > MAX_INVITATION_BYTES) throw new MailServiceError("too_large");
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source)) throw Error("invalid calendar");
    const lines = source.split(/\r?\n/);
    if (lines.length > 6000 || lines.some(line => line.length > 65536)) throw Error("calendar limit");
    let depth = 0;
    for (const line of lines) {
      if (/^BEGIN:/i.test(line) && ++depth > 6) throw Error("calendar nesting");
      if (/^END:/i.test(line) && --depth < 0) throw Error("calendar nesting");
    }
    if (depth !== 0) throw Error("calendar nesting");
    const root = parseCalendar(source);
    const events = root.getAllSubcomponents("vevent");
    if (!events.length || events.length > 20) throw Error("event limit");
    const method = text(root, "method").toUpperCase();
    return mailInvitationsSchema.parse({ invitations: events.map(event => {
      for (const name of ["uid", "dtstart", "dtend", "duration", "organizer", "sequence", "recurrence-id"]) if (event.getAllProperties(name).length > 1) throw Error("duplicate field");
      const sequence: unknown = event.getFirstPropertyValue("sequence");
      const version = sequence === null ? 0 : sequence;
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) throw Error("invalid sequence");
      const cancelled = method === "CANCEL" || text(event, "status").toUpperCase() === "CANCELLED";
      const duration: unknown = event.getFirstPropertyValue("duration");
      if (duration !== null && (!(duration instanceof ICAL.Duration) || !Number.isSafeInteger(duration.toSeconds()) || duration.toSeconds() <= 0 || duration.toSeconds() > 36600 * 86400 || event.hasProperty("dtend"))) throw Error("invalid duration");
      const start = time(event, "dtstart"), end = duration instanceof ICAL.Duration ? time(event, "dtstart", duration) : time(event, "dtend");
      if (!start && !cancelled) throw Error("missing start");
      if (start && end && ((start.kind === "date") !== (end.kind === "date") || (start.instant && end.instant ? end.instant <= start.instant : (start.kind === "date" || start.kind === "floating" && end.kind === "floating") && end.value <= start.value))) throw Error("invalid end");
      const participants = [...event.getAllProperties("attendee"), ...event.getAllProperties("organizer")];
      return {
        uid: text(event, "uid"), method, sequence: version,
        status: cancelled ? "cancelled" : method === "REQUEST" ? version > 0 ? "update" : "invitation" : "event",
        title: text(event, "summary"), description: text(event, "description"), location: text(event, "location"),
        organizer: address(event.getFirstPropertyValue("organizer")),
        attendees: event.getAllProperties("attendee").flatMap(property => { const email = address(property.getFirstValue()); return email ? [email] : []; }),
        start, end, recurrenceId: time(event, "recurrence-id"),
        recurrence: ["rrule", "rdate", "exdate"].flatMap(name => event.getAllProperties(name).map(property => property.toICALString())),
        delegated: participants.some(property => ["sent-by", "delegated-from", "delegated-to"].some(parameter => property.getParameter(parameter) !== undefined)),
      };
    }) });
  } catch (error) {
    if (error instanceof MailServiceError) throw error;
    throw new MailServiceError("invalid_input");
  }
}
