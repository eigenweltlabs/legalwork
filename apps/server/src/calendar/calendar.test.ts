import { describe, test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CalendarStore } from "./store.js";
import { exportCalendar, occurrences, parseCalendar, updateCalendar } from "./ical.js";
import { calculateDeadline } from "./deadline-rules.js";

const store = async () => CalendarStore.open(join(await mkdtemp(join(tmpdir(), "calendar-test-")), "runtime.sqlite"));
const fixture = (properties: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\nBEGIN:VEVENT\r\nUID:series@test\r\nDTSTAMP:20260901T000000Z\r\n${properties}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
describe("calendar storage and RFC5545", () => {
  test("empty calendars retain a required component without inventing an entry", () => {
    for (const text of [exportCalendar([]), exportCalendar([], "native")]) {
      const calendar = parseCalendar(text);
      expect(calendar.getAllSubcomponents().map(component => component.name)).toEqual(["vtimezone"]);
      expect(calendar.getTimeZoneByID("UTC")).toBeDefined();
      expect(text).toContain("TZOFFSETFROM:+0000\r\nTZOFFSETTO:+0000");
      expect(text.endsWith("END:VCALENDAR\r\n")).toBe(true);
    }
  });
  test("deleting the final entry leaves a conforming empty export and restoring brings it back", async () => {
    const db = await store(), item = db.create("project", { title: "Response", start: "2026-10-16" });
    const removed = db.remove("project", item.id, item.revision);
    for (const items of [db.list("project"), db.list("project", true)]) {
      const text = exportCalendar(items), calendar = parseCalendar(text);
      expect(calendar.getAllSubcomponents().map(component => component.name)).toEqual(["vtimezone"]);
      expect(text).not.toContain(item.uid);
      expect(text).not.toContain(item.title);
    }
    db.remove("project", item.id, removed.revision, true);
    expect(parseCalendar(exportCalendar(db.list("project"))).getFirstSubcomponent("vevent")?.getFirstPropertyValue("uid")).toBe(item.uid);
  });
  test("editing a published entry advances DTSTAMP with LAST-MODIFIED and keeps its UID", async () => {
    const db = await store(), item = db.create("project", { title: "Response", start: "2026-10-16" });
    const updated = { ...item, title: "Updated response", updatedAt: "2026-10-05T18:35:00Z", revision: item.revision + 1 };
    updated.ical = updateCalendar(updated, new Set(["title"]));
    const event = parseCalendar(exportCalendar([updated])).getFirstSubcomponent("vevent");
    expect(event?.getFirstPropertyValue("uid")).toBe(item.uid);
    expect(event?.getFirstPropertyValue("summary")).toBe(updated.title);
    expect(Number(event?.getFirstPropertyValue("sequence"))).toBe(updated.revision);
    expect(String(event?.getFirstPropertyValue("dtstamp"))).toBe(updated.updatedAt);
    expect(String(event?.getFirstPropertyValue("last-modified"))).toBe(updated.updatedAt);
  });
  test("date-only deadline exports an exclusive next-day end and an actual native cutoff", async () => {
    const db = await store(), item = db.create("project", { title: "Fristende", start: "2026-09-30", timeZone: "Europe/Berlin" });
    const event = parseCalendar(exportCalendar([item])).getFirstSubcomponent("vevent");
    expect(String(event?.getFirstPropertyValue("dtstart"))).toBe("2026-09-30"); expect(String(event?.getFirstPropertyValue("dtend"))).toBe("2026-10-01");
    const todo = parseCalendar(exportCalendar([item], "native")).getFirstSubcomponent("vtodo");
    expect(String(todo?.getFirstPropertyValue("due"))).toBe("2026-09-30T22:00:00Z");
    expect(occurrences(item, "P", "2026-09-30", "2026-10-01")).toHaveLength(1);
    expect(occurrences(item, "P", "2026-10-01", "2026-10-02")).toHaveLength(0);
  });
  test("optimistic conflict, trash, restore and immutable calculation history", async () => {
    const db = await store(), result = calculateDeadline({ rule: "de-zpo-period", region: "NW", triggerDate: "2026-01-31", duration: 1, unit: "months", source: "Service record" });
    const receipt = db.recordCalculation("project", result, "tested-code");
    const item = db.create("project", { title: "Appeal", start: receipt.deadlineDay, timeZone: receipt.timeZone }, receipt.id);
    expect(() => db.patch("project", item.id, { revision: item.revision, start: "2026-03-03" })).toThrow();
    const edited = db.patch("project", item.id, { revision: item.revision, start: "2026-03-03", reason: "Court granted explicit extension" });
    expect(edited.provenance.kind).toBe("manual"); expect(db.history("project", item.id)[1].provenance.kind).toBe("calculated");
    expect(() => db.patch("project", item.id, { revision: item.revision, title: "Stale" })).toThrow();
    const removed = db.remove("project", item.id, edited.revision); expect(db.list("project")).toHaveLength(0);
    expect(db.remove("project", item.id, removed.revision, true).deletedAt).toBeNull();
    expect(() => db.get("other-project", item.id)).toThrow();
  });
  test("recurrence exclusions and detached overrides remain one item", async () => {
    const db = await store();
    const text = fixture("DTSTART;VALUE=DATE:20260901\r\nDTEND;VALUE=DATE:20260902\r\nRRULE:FREQ=DAILY;COUNT=4\r\nEXDATE;VALUE=DATE:20260902\r\nSUMMARY:Master\r\nX-CLIENT-PROPERTY;X-META=keep:value")
      .replace("END:VCALENDAR", "BEGIN:VEVENT\r\nUID:series@test\r\nRECURRENCE-ID;VALUE=DATE:20260903\r\nDTSTART;VALUE=DATE:20260910\r\nDTEND;VALUE=DATE:20260911\r\nSUMMARY:Moved\r\nEND:VEVENT\r\nEND:VCALENDAR");
    const [item] = db.import("project", text, "source.ics");
    expect(db.list("project")).toHaveLength(1);
    const dates = occurrences(item, "P", "2026-09-01", "2026-10-01"); expect(dates.map(item => item.start)).toEqual(["2026-09-01", "2026-09-10", "2026-09-04"]);
    expect(dates[1].title).toBe("Moved");
    const edited = db.patch("project", item.id, { revision: item.revision, title: "Renamed" });
    expect(edited.ical).toContain("X-CLIENT-PROPERTY;X-META=keep:value"); expect(edited.ical).toContain("RECURRENCE-ID");
    expect(() => db.patch("project", edited.id, { revision: edited.revision, start: "2026-09-02" })).toThrow();
    expect(() => db.import("project", text, "retry")).toThrow();
  });
  test("recalculation edits the same deadline with immutable receipts and rejects foreign or mismatched dates", async () => {
    const db = await store();
    const input = { rule: "de-zpo-period", region: "BE", triggerDate: "2026-01-30", duration: 4, unit: "weeks", source: "DeadlineBench DB-DE-01 service record" };
    const original = db.recordCalculation("project", calculateDeadline(input), "tested-code");
    const extended = db.recordCalculation("project", calculateDeadline({ ...input, triggerDate: original.deadlineDay, duration: 2, source: "DeadlineBench DB-DE-01 extension order" }), "tested-code");
    const foreign = db.recordCalculation("other-project", calculateDeadline(input), "tested-code");
    const item = db.create("project", { title: "Stellungnahme", start: original.deadlineDay, sessionIds: ["ses_own"], attachmentPaths: ["Verfuegung.txt"] }, original.id);
    const patch = { revision: item.revision, calculationId: extended.id, start: extended.deadlineDay, timeZone: extended.timeZone };
    expect(() => db.patch("other-project", item.id, patch)).toThrow("not found");
    expect(() => db.patch("project", item.id, { ...patch, calculationId: foreign.id })).toThrow("installed skill first");
    expect(() => db.patch("project", item.id, { ...patch, start: "2026-03-14" })).toThrow("match the calculation");
    expect(() => db.patch("project", item.id, { ...patch, timeZone: "UTC" })).toThrow("match the calculation");
    const updated = db.patch("project", item.id, patch);
    expect(updated).toMatchObject({ id: item.id, uid: item.uid, projectId: "project", start: "2026-03-13", revision: 2, verified: false, sessionIds: ["ses_own"], attachmentPaths: ["Verfuegung.txt"], provenance: { kind: "calculated", calculation: extended } });
    expect(db.list("project")).toHaveLength(1);
    expect(db.history("project", item.id)[1].provenance).toEqual({ kind: "calculated", calculation: original });
    expect(occurrences(updated, "Project", "2026-03-01", "2026-04-01")[0].start).toBe("2026-03-13");
    const alarm = parseCalendar(updated.ical).getFirstSubcomponent("vevent")?.getFirstSubcomponent("valarm");
    expect(String(alarm?.getFirstPropertyValue("trigger"))).toBe("2026-03-12T23:00:00Z");
    expect(() => db.patch("project", item.id, patch)).toThrow("changed");
  });
  test("IANA recurrences preserve local time across DST without global timezone registration", async () => {
    const db = await store();
    const [item] = db.import("project", fixture("DTSTART;TZID=Europe/Berlin:20261024T090000\r\nDTEND;TZID=Europe/Berlin:20261024T100000\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:DST"), "source");
    expect(occurrences(item, "P", "2026-10-24", "2026-10-28").map(item => item.start)).toEqual(["2026-10-24T07:00:00.000Z", "2026-10-25T08:00:00.000Z", "2026-10-26T08:00:00.000Z"]);
  });
  test("offline conflict keeps local edits and resolves explicitly", async () => {
    const db = await store(), item = db.create("project", { title: "Original", start: "2026-09-30" });
    db.receive("project", { ...item, projectId: "canonical", revision: 1 }, item.revision);
    const local = db.get("project", item.id), mine = db.patch("project", item.id, { revision: local.revision, title: "Mine" });
    db.receive("project", { ...item, projectId: "canonical", title: "Theirs", revision: 2 });
    expect(db.get("project", item.id).title).toBe("Mine"); expect(db.conflicts("project")).toHaveLength(1);
    expect(db.resolve("project", item.id, mine.revision, "mine").title).toBe("Mine"); expect(db.pending("project")[0].baseRevision).toBe(2);
    expect(db.history("project", item.id).some(item => item.title === "Original")).toBe(true);
  });
  test("scope withdrawal and reattachment never replace existing history revisions", async () => {
    const db = await store(), original = db.create("project", { title: "Original", start: "2026-09-30" });
    db.receive("project", original, original.revision);
    const replica = db.get("project", original.id), edited = db.patch("project", original.id, { revision: replica.revision, title: "Earlier edit" });
    db.receive("project", { ...edited, revision: 2 }, edited.revision);
    const before = db.history("project", original.id);
    db.withdraw("project", false);
    db.receive("project", { ...original, title: "Reattached", revision: 3 });
    const after = db.history("project", original.id);
    expect(after.slice(1)).toEqual(before);
    expect(after[0].revision).toBeGreaterThan(before[0].revision);
  });
  test("feeds can be revoked and reminder claim is idempotent", async () => {
    const db = await store(), token = db.createFeed("project"); expect(db.feed(token)?.projectId).toBe("project"); db.revokeFeed(token); expect(db.feed(token)).toBeNull();
    db.enqueueReminder("key", { title: "Deadline" }); db.enqueueReminder("key", { title: "Duplicate" }); expect(db.claimReminders()).toHaveLength(1); expect(db.claimReminders()).toHaveLength(0);
  });
  test("recurring VTODO projects its due dates and exports a compatible event", async () => {
    const db = await store();
    const text = fixture("DTSTART;TZID=Europe/Berlin:20261024T090000\r\nDUE;TZID=Europe/Berlin:20261024T170000\r\nRRULE:FREQ=DAILY;COUNT=3\r\nSUMMARY:File brief").replaceAll("VEVENT", "VTODO");
    const [item] = db.import("project", text, "task.ics");
    expect(occurrences(item, "P", "2026-10-24", "2026-10-28").map(entry => entry.start)).toEqual(["2026-10-24T15:00:00.000Z", "2026-10-25T16:00:00.000Z", "2026-10-26T16:00:00.000Z"]);
    expect(parseCalendar(exportCalendar([item], "native")).getFirstSubcomponent("vtodo")?.getFirstPropertyValue("uid")).toBe(item.uid);
    const compatible = parseCalendar(exportCalendar([item]));
    expect(compatible.getFirstSubcomponent("vevent")?.hasProperty("rrule")).toBe(true);
    expect(compatible.getFirstSubcomponent("vevent")?.getFirstPropertyValue("uid")).toBe(item.uid);
  });
  test("due-only VTODO edits change DUE without introducing a fictitious start", async () => {
    const db = await store(), [item] = db.import("project", fixture("DUE;VALUE=DATE:20260930\r\nSUMMARY:Brief").replaceAll("VEVENT", "VTODO"), "task.ics");
    const changed = db.patch("project", item.id, { revision: item.revision, start: "2026-10-02" });
    const todo = parseCalendar(changed.ical).getFirstSubcomponent("vtodo");
    expect(String(todo?.getFirstPropertyValue("due"))).toBe("2026-10-02");
    expect(todo?.hasProperty("dtstart")).toBe(false);
    expect(occurrences(changed, "P", "2026-10-01", "2026-10-03")[0].start).toBe("2026-10-02");
  });
  test("detached occurrences moved back more than a year remain visible", async () => {
    const db = await store();
    const text = fixture("DTSTART;VALUE=DATE:20260901\r\nDTEND;VALUE=DATE:20260902\r\nRRULE:FREQ=YEARLY;COUNT=3\r\nSUMMARY:Annual")
      .replace("END:VCALENDAR", "BEGIN:VEVENT\r\nUID:series@test\r\nRECURRENCE-ID;VALUE=DATE:20280901\r\nDTSTART;VALUE=DATE:20260910\r\nDTEND;VALUE=DATE:20260911\r\nSUMMARY:Moved early\r\nEND:VEVENT\r\nEND:VCALENDAR");
    const [item] = db.import("project", text, "source.ics");
    expect(occurrences(item, "P", "2026-09-01", "2026-10-01").map(entry => entry.start)).toEqual(["2026-09-01", "2026-09-10"]);
  });
  test("UTF-8 folding, higher imported SEQUENCE, and unknown properties survive edits", async () => {
    const db = await store(), [item] = db.import("project", fixture("DTSTART;VALUE=DATE:20260930\r\nSEQUENCE:90\r\nSUMMARY:Original\r\nX-TEST:retain"), "series.ics");
    const title = "Ü😀".repeat(60), updated = db.patch("project", item.id, { revision: item.revision, title });
    const master = parseCalendar(updated.ical).getFirstSubcomponent("vevent");
    expect(master?.getFirstPropertyValue("summary")).toBe(title);
    expect(Number(master?.getFirstPropertyValue("sequence"))).toBe(91);
    expect(master?.getFirstPropertyValue("x-test")).toBe("retain");
    expect(updated.ical.split("\r\n").every(line => Buffer.byteLength(line) <= 75)).toBe(true);
  });
  test("a named filing cutoff is exported as DUE, and changed entries withdraw queued reminders", async () => {
    const db = await store(), result = calculateDeadline({ rule: "ew-cpr-clear-days", triggerDate: "2026-09-01", duration: 1, endIsEvent: false, filing: "court-office", cutoffTime: "16:00", source: "Court order" });
    const receipt = db.recordCalculation("project", result, "tested-code"), item = db.create("project", { title: "Brief", start: receipt.deadlineDay, timeZone: receipt.timeZone }, receipt.id);
    const todo = parseCalendar(exportCalendar([item], "native")).getFirstSubcomponent("vtodo");
    expect(String(todo?.getFirstPropertyValue("due"))).toBe("2026-09-02T15:00:00Z");
    expect(String(todo?.getFirstSubcomponent("valarm")?.getFirstPropertyValue("trigger"))).toBe("2026-09-01T15:00:00Z");
    db.enqueueReminder("old", { itemId: item.id, deadline: item.start });
    db.patch("project", item.id, { revision: item.revision, status: "completed" });
    expect(db.claimReminders()).toHaveLength(0);
  });
});
