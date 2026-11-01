import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { parseMailInvitations, MAX_INVITATION_BYTES } from "./parse.js";
import { readMailInvitations } from "./read.js";
import { mailInvitationInputSchema } from "../invitation-view.js";
import { MailServiceError, type MailService } from "../service-interface.js";
import type { MailContentChunk, MailMessageView, MailPartView } from "../read-view.js";

const base = ["UID:meeting@example.test", "SUMMARY:Review", "DTSTART:20261103T100000Z", "DTEND:20261103T110000Z", "ORGANIZER:mailto:organizer@example.test", "ATTENDEE:mailto:self@example.test"];
const calendar = (fields = base, method = "REQUEST", extra: string[] = []) => Buffer.from(["BEGIN:VCALENDAR", "VERSION:2.0", `METHOD:${method}`, ...extra, "BEGIN:VEVENT", ...fields, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n"));
const parse = (fields = base, method = "REQUEST", extra: string[] = []) => parseMailInvitations(calendar(fields, method, extra)).invitations[0];

test("reads an invitation, updates and cancellations without executing calendar content", () => {
  const first = parse([...base, "DESCRIPTION:First line\\nSecond line", "LOCATION:Berlin\\, office", "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT10M", "DESCRIPTION:Reminder", "END:VALARM"]);
  expect(first).toMatchObject({ title: "Review", status: "invitation", sequence: 0, organizer: "organizer@example.test", attendees: ["self@example.test"], delegated: false, description: "First line\nSecond line", location: "Berlin, office", start: { instant: "2026-11-03T10:00:00.000Z", kind: "utc" } });
  expect(parse([...base, "SEQUENCE:2"]).status).toBe("update");
  expect(parse(["UID:meeting@example.test", "SEQUENCE:3"], "CANCEL")).toMatchObject({ status: "cancelled", start: null, end: null });
  expect(parse([...base, "STATUS:CANCELLED"]).status).toBe("cancelled");
  expect(parse(base, "PUBLISH").status).toBe("event");
});

test("preserves folded Unicode text, all-day boundaries, recurrence and occurrence identity", () => {
  const invitation = parse(["UID:series@example.test", "SUMMARY:Vertragsprü\r\n fung", "DTSTART;VALUE=DATE:20261103", "DTEND;VALUE=DATE:20261105", "RRULE:FREQ=WEEKLY;COUNT=4", "EXDATE;VALUE=DATE:20261110", "RECURRENCE-ID;VALUE=DATE:20261103"]);
  expect(invitation.title).toBe("Vertragsprüfung");
  expect(invitation.start).toEqual({ value: "2026-11-03", kind: "date", timeZone: null, instant: null });
  expect(invitation.end?.value).toBe("2026-11-05");
  expect(invitation.recurrenceId?.value).toBe("2026-11-03");
  expect(invitation.recurrence).toEqual(["RRULE:FREQ=WEEKLY;COUNT=4", "EXDATE;VALUE=DATE:20261110"]);
});

test("resolves IANA and embedded zones while preserving floating, fold and gap times", () => {
  const fields = (zone: string, start: string) => ["UID:zone@example.test", `DTSTART${zone}:${start}`];
  expect(parse(fields(";TZID=Europe/Berlin", "20261103T100000")).start?.instant).toBe("2026-11-03T09:00:00.000Z");
  expect(parse(fields("", "20261103T100000")).start).toMatchObject({ kind: "floating", instant: null });
  for (const date of ["20261025T023000", "20260329T023000"]) expect(parse(fields(";TZID=Europe/Berlin", date)).start).toMatchObject({ kind: "zoned", instant: null, timeZone: "Europe/Berlin" });
  const zone = ["BEGIN:VTIMEZONE", "TZID:Custom/Office", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0230", "TZOFFSETTO:+0230", "END:STANDARD", "END:VTIMEZONE"];
  expect(parse(fields(";TZID=Custom/Office", "20261103T100000"), "REQUEST", zone).start?.instant).toBe("2026-11-03T07:30:00.000Z");
});

test("delegation is descriptive and non-mail participant URIs never become links", () => {
  const invitation = parse([...base.filter(line => !line.startsWith("ATTENDEE")), 'ATTENDEE;DELEGATED-FROM="mailto:other@example.test":mailto:self@example.test', "ATTENDEE:https://example.test/track", "ATTACH:https://example.test/attachment", "URL:javascript:alert(1)"]);
  expect(invitation.delegated).toBe(true);
  expect(invitation.attendees).toEqual(["self@example.test"]);
  expect(invitation).not.toHaveProperty("url");
});

test('calendar mailto addresses decode URI escapes without accepting query strings or encoded controls', () => {
  const invitation = parse([...base.filter(line => !line.startsWith('ATTENDEE')), 'ATTENDEE:mailto:self%2Bcalendar@example.test', 'ATTENDEE:mailto:other@example.test?subject=track', 'ATTENDEE:mailto:bad%0D%0Aaddress@example.test']);
  expect(invitation.attendees).toEqual(['self+calendar@example.test']);
});

test("supports duration ends and different source zones without changing the event", () => {
  expect(parse(["UID:a", "DTSTART:20261103T100000Z", "DURATION:PT90M"]).end?.instant).toBe("2026-11-03T11:30:00.000Z");
  expect(parse(["UID:a", "DTSTART;VALUE=DATE:20261103", "DURATION:P2D"]).end?.value).toBe("2026-11-05");
  expect(parse(["UID:a", "DTSTART;TZID=Europe/Berlin:20261103T100000", "DTEND:20261103T110000Z"]).end?.instant).toBe("2026-11-03T11:00:00.000Z");
  for (const fields of [[...base, "DURATION:PT1H"], ["UID:a", "DTSTART:20261103T100000Z", "DURATION:-PT1H"], ["UID:a", "DTSTART;VALUE=DATE:20261103", "DURATION:PT1H"]]) expect(() => parse(fields)).toThrow("mail_invalid_input");
});

test("rejects malformed dates, invalid identity, duplicates and unknown zones", () => {
  for (const fields of [[], ["UID:a"], ["DTSTART:20261103T100000Z"], [...base, "UID:other"], [...base, "SEQUENCE:-1"], [...base, "SEQUENCE:2", "SEQUENCE:3"], ["UID:a", "DTSTART:20260230T100000Z"], ["UID:a", "DTSTART:20261103T250000Z"], ["UID:a", "DTSTART;TZID=Unknown/Zone:20261103T100000"], ["UID:a", "DTSTART:20261103T100000Z", "DTEND:20261103T090000Z"]]) expect(() => parse(fields)).toThrow("mail_invalid_input");
});

test("bounds calendar bytes, components, nesting, lines and UTF-8", () => {
  expect(() => parseMailInvitations(Buffer.alloc(MAX_INVITATION_BYTES + 1))).toThrow("mail_too_large");
  expect(() => parseMailInvitations(Buffer.from([0xff]))).toThrow("mail_invalid_input");
  expect(() => parse([...base, "DESCRIPTION:\u0000"])).toThrow("mail_invalid_input");
  expect(() => parse([...base, `DESCRIPTION:${"x".repeat(65537)}`])).toThrow("mail_invalid_input");
  expect(() => parse([...base, ...Array(8).fill("BEGIN:VALARM"), ...Array(8).fill("END:VALARM")])).toThrow("mail_invalid_input");
  expect(() => parseMailInvitations(Buffer.from(["BEGIN:VCALENDAR", "VERSION:2.0", ...Array.from({ length: 21 }, (_, index) => ["BEGIN:VEVENT", `UID:${index}`, "DTSTART:20261103T100000Z", "END:VEVENT"]).flat(), "END:VCALENDAR"].join("\r\n")))).toThrow("mail_invalid_input");
});

function fixture() {
  const bytes = calendar([...base, `X-PADDING:${"x".repeat(26000)}`]);
  const sha256 = createHash("sha256").update(bytes).digest("hex"), referenceId = `sha256:${sha256}`;
  const locator = { provider: "gmail", messageId: "message" } satisfies MailMessageView["locator"];
  const rawReferenceId = `sha256:${"a".repeat(64)}`;
  const message: MailMessageView = { accountId: "account", key: '["gmail","message"]', locator, rawReferenceId, subject: "Invitation", threadId: null, rfcMessageId: null, removed: false, memberships: [], contentState: "complete", metadata: null };
  const part: MailPartView = { key: "part", kind: "attachment", partId: "p", referenceId, bytes: bytes.length, sha256, state: "stored", bytesAvailable: true, filename: "invite.ics", contentType: "text/calendar", contentId: null };
  const listeners = new Set<() => void>();
  let reads = 0;
  const reader: Pick<MailService, "status" | "readMessage" | "listParts" | "readContent" | "onLock"> = {
    status: () => ({ protocolVersion: 1, state: "ready", syncSupported: true }),
    onLock: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    async readMessage(accountId) { if (accountId !== message.accountId) throw new MailServiceError("not_found"); return { ...message }; },
    async listParts() { return { items: [part], nextCursor: null }; },
    async readContent(accountId, selected, request) { reads++; const offset = request.offset ?? 0, end = Math.min(bytes.length, offset + (request.limit ?? 24576)); return { accountId, locator: selected, referenceId, sha256, totalBytes: bytes.length, offset, data: bytes.subarray(offset, end).toString("base64"), nextOffset: end === bytes.length ? null : end }; },
  };
  return { reader, message, part, input: { locator, partId: "p", referenceId, rawReferenceId }, listeners, reads: () => reads };
}

test("reads exact downloaded attachment bytes across chunks and releases its lock listener", async () => {
  const value = fixture();
  expect((await readMailInvitations(value.reader, "account", value.input)).invitations[0].title).toBe("Review");
  expect(value.reads()).toBe(2);
  expect(value.listeners.size).toBe(0);
  expect(mailInvitationInputSchema.safeParse({ ...value.input, accessToken: "forbidden" }).success).toBe(false);
  expect(mailInvitationInputSchema.safeParse({ ...value.input, referenceId: "caller-reference" }).success).toBe(false);
});

test("account, source replacement, removed mail and missing parts fail before preview", async () => {
  const value = fixture();
  await expect(readMailInvitations(value.reader, "foreign", value.input)).rejects.toThrow("mail_not_found");
  await expect(readMailInvitations(value.reader, "account", { ...value.input, rawReferenceId: `sha256:${"b".repeat(64)}` })).rejects.toThrow("mail_conflict");
  value.message.removed = true;
  await expect(readMailInvitations(value.reader, "account", value.input)).rejects.toThrow("mail_conflict");
  value.message.removed = false; value.part.bytesAvailable = false;
  await expect(readMailInvitations(value.reader, "account", value.input)).rejects.toThrow("mail_not_found");
  expect(value.reads()).toBe(0);
});

test("rejects swapped chunks and source changes during content reads", async () => {
  const changes: ((chunk: MailContentChunk) => MailContentChunk)[] = [chunk => ({ ...chunk, accountId: "foreign" }), chunk => ({ ...chunk, locator: { provider: "gmail", messageId: "other" } }), chunk => ({ ...chunk, offset: 1 }), chunk => ({ ...chunk, nextOffset: null }), chunk => ({ ...chunk, sha256: "b".repeat(64) }), chunk => ({ ...chunk, data: Buffer.alloc(24576).toString("base64") })];
  for (const change of changes) {
    const value = fixture(), original = value.reader.readContent;
    value.reader.readContent = async (...args) => change(await original(...args));
    await expect(readMailInvitations(value.reader, "account", value.input)).rejects.toThrow("mail_conflict");
    expect(value.listeners.size).toBe(0);
  }
  const value = fixture(), original = value.reader.readContent;
  value.reader.readContent = async (...args) => { const result = await original(...args); value.message.rawReferenceId = `sha256:${"b".repeat(64)}`; return result; };
  await expect(readMailInvitations(value.reader, "account", value.input)).rejects.toThrow("mail_conflict");
});

test("a lock and unlock during a read cannot return old decrypted content", async () => {
  const value = fixture(), original = value.reader.readContent;
  value.reader.readContent = async (...args) => { const result = await original(...args); for (const listener of value.listeners) listener(); return result; };
  await expect(readMailInvitations(value.reader, "account", value.input)).rejects.toThrow("mail_locked");
  expect(value.listeners.size).toBe(0);
});
