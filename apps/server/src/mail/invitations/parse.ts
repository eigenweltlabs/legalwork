import type { Invitation } from "../invitation-view.js";

const MAX_BYTES = 256 * 1024;
type Property = { name: string; params: Map<string, string>; value: string };
function invalid(): never {
  throw Error(
    "This calendar attachment is malformed or exceeds the invitation reader limits. Save the original to inspect it in your calendar app.",
  );
}
function splitQuoted(text: string, separator: string): string[] {
  let quoted = false;
  let start = 0;
  const result: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') quoted = !quoted;
    if (text[i] === separator && !quoted) {
      result.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (quoted) invalid();
  result.push(text.slice(start));
  return result;
}
function property(line: string): Property {
  let quoted = false;
  let colon = -1;
  for (let index = 0; index < line.length; index++) {
    if (line[index] === '"') quoted = !quoted;
    if (line[index] === ":" && !quoted) {
      colon = index;
      break;
    }
  }
  if (colon < 1) invalid();
  const head = splitQuoted(line.slice(0, colon), ";");
  const name = head.shift()!.toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) invalid();
  const params = new Map<string, string>();
  for (const field of head) {
    const at = field.indexOf("=");
    if (at < 1) invalid();
    const key = field.slice(0, at).toUpperCase();
    if (params.has(key)) invalid();
    let value = field.slice(at + 1);
    if (value.startsWith('"') && value.endsWith('"'))
      value = value.slice(1, -1);
    params.set(key, value);
  }
  return { name, params, value: line.slice(colon + 1) };
}
function text(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, char: string) =>
    char.toLowerCase() === "n" ? "\n" : char,
  );
}
function email(value: string): string | null {
  if (!/^mailto:/i.test(value)) return null;
  const result = value.slice(7);
  return /^[^\s<>@:,;]+@[^\s<>@:,;]+$/.test(result)
    ? result.toLowerCase()
    : null;
}
function time(prop: Property): Invitation["start"] {
  const value = prop.value;
  const date = prop.params.get("VALUE")?.toUpperCase() === "DATE";
  const match = (
    date
      ? /^(\d{4})(\d{2})(\d{2})$/
      : /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/
  ).exec(value);
  if (!match) invalid();
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  const day = new Date(iso + "T00:00:00Z");
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== iso)
    invalid();
  const zone = prop.params.get("TZID") ?? null;
  if (date) {
    if (zone) invalid();
    return {
      value: iso,
      label: iso + " (all day)",
      kind: "date",
      timeZone: null,
    };
  }
  if (
    Number(match[4]) > 23 ||
    Number(match[5]) > 59 ||
    Number(match[6]) > 59 ||
    (zone && match[7])
  )
    invalid();
  const stamp = `${iso}T${match[4]}:${match[5]}:${match[6]}`;
  return {
    value: stamp + (match[7] ? "Z" : ""),
    label: `${iso} ${match[4]}:${match[5]}:${match[6]} ${match[7] ? "UTC" : (zone ?? "(time zone not specified)")}`,
    kind: match[7] ? "utc" : zone ? "zoned" : "floating",
    timeZone: zone,
  };
}
/** RFC 5545 content lines, bounded VEVENT display; never follows URIs or executes alarms. */
export function parseInvitations(bytes: Uint8Array): Invitation[] {
  if (bytes.length > MAX_BYTES) invalid();
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    invalid();
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source)) invalid();
  const lines = source
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .filter(Boolean);
  if (lines.length > 6000 || lines.some((line) => line.length > 65536))
    invalid();
  const stack: string[] = [];
  const events: Property[][] = [];
  const calendar: Property[] = [];
  let event: Property[] | null = null;
  let finished = false;
  for (const line of lines) {
    const p = property(line);
    if (p.name === "BEGIN") {
      const name = p.value.toUpperCase();
      if (
        finished ||
        stack.length > 6 ||
        (!stack.length && name !== "VCALENDAR")
      )
        invalid();
      stack.push(name);
      if (name === "VEVENT") {
        if (stack.length !== 2 || events.length >= 20) invalid();
        event = [];
        events.push(event);
      }
      continue;
    }
    if (p.name === "END") {
      if (stack.pop() !== p.value.toUpperCase()) invalid();
      if (p.value.toUpperCase() === "VEVENT") event = null;
      if (!stack.length) finished = true;
      continue;
    }
    if (stack.length === 1) calendar.push(p);
    else if (stack.length === 2 && stack[1] === "VEVENT" && event)
      event.push(p);
    else if (!stack.length) invalid();
  }
  if (stack.length || !finished || !events.length) invalid();
  function single(
    props: Property[],
    name: string,
    required = false,
  ): Property | undefined {
    const found = props.filter((p) => p.name === name);
    if (found.length > 1 || (required && !found.length)) invalid();
    return found[0];
  }
  if (single(calendar, "VERSION", true)?.value !== "2.0") invalid();
  const method = (single(calendar, "METHOD")?.value ?? "PUBLISH").toUpperCase();
  return events.map((props) => {
    const uid = text(single(props, "UID", true)!.value);
    if (!uid || uid.length > 2048) invalid();
    const start = time(single(props, "DTSTART", true)!);
    const endProp = single(props, "DTEND");
    const end = endProp ? time(endProp) : null;
    const sequenceText = single(props, "SEQUENCE")?.value ?? "0";
    if (!/^\d{1,9}$/.test(sequenceText)) invalid();
    const organizerProp = single(props, "ORGANIZER");
    const organizer = organizerProp ? email(organizerProp.value) : null;
    const attendeeProps = props.filter((p) => p.name === "ATTENDEE");
    if (attendeeProps.length > 200) invalid();
    const attendees = attendeeProps
      .map((p) => email(p.value))
      .filter((value): value is string => value !== null);
    const recurrence = props
      .filter((p) => ["RRULE", "RDATE", "EXDATE"].includes(p.name))
      .map(
        (p) =>
          `${p.name}${[...p.params].map(([key, value]) => ";" + key + "=" + value).join("")}:${p.value}`,
      );
    const recurrenceId = single(props, "RECURRENCE-ID")?.value ?? null;
    const status = (
      single(props, "STATUS")?.value ?? "CONFIRMED"
    ).toUpperCase();
    let responseLimit: string | null = null;
    if (method === "CANCEL" || status === "CANCELLED")
      responseLimit =
        "The organizer cancelled this invitation. Check your calendar for the current cancellation; LegalWork does not delete calendar events from an email.";
    else if (method !== "REQUEST")
      responseLimit =
        "This calendar attachment is informational. Only meeting requests support responses here.";
    else if (recurrenceId)
      responseLimit =
        "This is an update to one occurrence. Respond to occurrence changes in your calendar app.";
    else if (
      !organizer ||
      attendees.length !== attendeeProps.length ||
      !attendees.length ||
      new Set(attendees).size !== attendees.length
    )
      responseLimit =
        "The organizer or attendee identity is unsupported. Respond in your calendar app.";
    else if (
      [...(organizerProp ? [organizerProp] : []), ...attendeeProps].some((p) =>
        ["SENT-BY", "DELEGATED-TO", "DELEGATED-FROM"].some((key) =>
          p.params.has(key),
        ),
      )
    )
      responseLimit =
        "Delegated invitations require your calendar app. LegalWork only responds as the selected primary-calendar account.";
    else if (start.kind === "floating" || end?.kind === "floating")
      responseLimit =
        "This invitation does not specify a time zone. Open it in your calendar app to resolve its time.";
    else if (
      !end ||
      start.kind !== end.kind ||
      start.timeZone !== end.timeZone ||
      start.value >= end.value
    )
      responseLimit =
        "This invitation has an unsupported end time or duration. Respond in your calendar app.";
    else if (start.timeZone) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: start.timeZone }).format();
      } catch {
        responseLimit =
          "This invitation uses a custom time zone. Respond in your calendar app.";
      }
    }
    if (recurrence.some((line) => !line.startsWith("RRULE:")))
      responseLimit ??=
        "This series includes added or excluded dates. Respond in your calendar app.";
    return {
      uid,
      sequence: Number(sequenceText),
      method,
      status,
      summary: text(single(props, "SUMMARY")?.value ?? "(Untitled meeting)"),
      description: text(single(props, "DESCRIPTION")?.value ?? ""),
      location: text(single(props, "LOCATION")?.value ?? ""),
      organizer,
      attendees,
      start,
      end,
      recurrence,
      recurrenceId,
      responseLimit,
    };
  });
}
