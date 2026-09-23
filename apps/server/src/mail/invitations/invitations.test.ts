import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { MailService } from "../service-interface.js";
import { providerMessageKey, type ProviderMessageLocator } from "../model.js";
import { parseInvitations } from "./parse.js";
import {
  InvitationService,
  calendarResponseLimit,
  type InvitationAccess,
} from "./service.js";

function calendar(extra = "", method = "REQUEST") {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:${method}\r\nBEGIN:VEVENT\r\nUID:meeting@example.test\r\nSEQUENCE:2\r\nDTSTART:20260924T090000Z\r\nDTEND:20260924T100000Z\r\nSUMMARY:Case review\r\nDESCRIPTION:Review the brief\r\nLOCATION:Berlin\r\nORGANIZER:mailto:partner@example.test\r\nATTENDEE:mailto:lawyer@example.test\r\n${extra}END:VEVENT\r\nEND:VCALENDAR\r\n`;
}
const decode = (source: string) => parseInvitations(Buffer.from(source));
function fixture(ics = calendar()) {
  const bytes = Buffer.from(ics);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const locator: ProviderMessageLocator = {
    provider: "gmail",
    messageId: "message",
  };
  let raw = "sha256:raw";
  let locked = false;
  const source = { locator, partId: "2", referenceId: "sha256:" + hash };
  const mail: Pick<
    MailService,
    "status" | "readMessage" | "listParts" | "readContent"
  > = {
    status: () => ({
      protocolVersion: 1,
      state: locked ? "locked" : "ready",
      syncSupported: true,
    }),
    readMessage: async (accountId) => ({
      accountId,
      key: providerMessageKey(locator),
      locator,
      subject: "Meeting",
      rawReferenceId: raw,
      threadId: null,
      rfcMessageId: null,
      removed: false,
      memberships: [],
      contentState: "complete",
      metadata: null,
    }),
    listParts: async () => ({
      items: [
        {
          key: "part",
          kind: "attachment",
          partId: "2",
          state: "stored",
          referenceId: source.referenceId,
          bytes: bytes.length,
          sha256: hash,
          bytesAvailable: true,
          filename: "invite.ics",
          contentType: "text/calendar",
          contentId: null,
        },
      ],
      nextCursor: null,
    }),
    readContent: async (accountId, _locator, request) => ({
      accountId,
      locator,
      referenceId: source.referenceId,
      offset: request.offset ?? 0,
      totalBytes: bytes.length,
      sha256: hash,
      data: bytes.toString("base64"),
      nextOffset: null,
    }),
  };
  let access: InvitationAccess = {
    accountId: "google-user",
    email: "lawyer@example.test",
    accessToken: "synthetic-token",
  };
  let event = {
    id: "event-id",
    etag: '"version-2"',
    iCalUID: "meeting@example.test",
    sequence: 2,
    status: "confirmed",
    summary: "Case review",
    description: "Review the brief",
    location: "Berlin",
    organizer: { email: "partner@example.test" },
    start: { dateTime: "2026-09-24T09:00:00Z" },
    end: { dateTime: "2026-09-24T10:00:00Z" },
    attendees: [
      {
        email: "lawyer@example.test",
        self: true,
        responseStatus: "needsAction",
      },
      {
        email: "partner@example.test",
        organizer: true,
        responseStatus: "accepted",
      },
    ],
  };
  const writes: { url: string; init: RequestInit }[] = [];
  let writeStatus = 200;
  let dropReply = false;
  const transport = async (input: string, init: RequestInit) => {
    const url = String(input);
    if (init?.method === "PATCH") {
      writes.push({ url, init });
      if (dropReply) throw Error("synthetic lost response");
      return Response.json(event, { status: writeStatus });
    }
    return Response.json(url.includes("?") ? { items: [event] } : event);
  };
  const service = new InvitationService(mail, async () => access, transport);
  const signal = new AbortController().signal;
  return {
    service,
    source,
    signal,
    writes,
    event,
    setEvent: (next: typeof event) => {
      event = next;
    },
    setRaw: () => {
      raw = "sha256:changed";
    },
    lock: () => {
      locked = true;
    },
    setAccess: (next: InvitationAccess) => {
      access = next;
    },
    loseReply: () => {
      dropReply = true;
    },
    rejectVersion: () => {
      writeStatus = 412;
    },
    preview: () =>
      service.preview("mail-account", source, 0, "accepted", signal),
  };
}

describe("bounded invitation display", () => {
  test("unfolds text; preserves organizer, recurrence, timezone and exclusive all-day end", () => {
    const event = decode(
      calendar("RRULE:FREQ=WEEKLY;COUNT=3\r\n")
        .replace(
          "SUMMARY:Case review",
          "SUMMARY:Case\\, review\\nFolded\r\n continuation",
        )
        .replace(
          "DTSTART:20260924T090000Z",
          "DTSTART;TZID=Europe/Berlin:20260924T110000",
        )
        .replace(
          "DTEND:20260924T100000Z",
          "DTEND;TZID=Europe/Berlin:20260924T120000",
        ),
    )[0];
    expect(event.summary).toBe("Case, review\nFoldedcontinuation");
    expect(event.start.timeZone).toBe("Europe/Berlin");
    expect(event.recurrence).toEqual(["RRULE:FREQ=WEEKLY;COUNT=3"]);
    expect(event.responseLimit).toBeNull();
    const allDay = decode(
      calendar()
        .replace("DTSTART:20260924T090000Z", "DTSTART;VALUE=DATE:20260924")
        .replace("DTEND:20260924T100000Z", "DTEND;VALUE=DATE:20260925"),
    )[0];
    expect(allDay.start.kind).toBe("date");
    expect(allDay.end?.value).toBe("2026-09-25");
  });
  test("cancellation, delegated reply, occurrence and floating/custom timezone are display only", () => {
    expect(decode(calendar("", "CANCEL"))[0].responseLimit).toContain(
      "cancelled",
    );
    expect(
      decode(
        calendar().replace(
          "ATTENDEE:",
          'ATTENDEE;DELEGATED-FROM="mailto:other@example.test":',
        ),
      )[0].responseLimit,
    ).toContain("Delegated");
    expect(
      decode(calendar("RECURRENCE-ID:20260924T090000Z\r\n"))[0].responseLimit,
    ).toContain("occurrence");
    expect(
      decode(
        calendar().replace(
          "DTSTART:20260924T090000Z",
          "DTSTART:20260924T090000",
        ),
      )[0].responseLimit,
    ).toContain("time zone");
    expect(
      decode(
        calendar()
          .replace(
            "DTSTART:20260924T090000Z",
            "DTSTART;TZID=Custom/Zone:20260924T090000",
          )
          .replace(
            "DTEND:20260924T100000Z",
            "DTEND;TZID=Custom/Zone:20260924T100000",
          ),
      )[0].responseLimit,
    ).toContain("custom");
  });
  test("rejects invalid dates, duplicate identity, invalid nesting, invalid UTF8 and oversized content", () => {
    for (const bad of [
      calendar().replace("20260924T090000Z", "20260230T090000Z"),
      calendar("UID:another\r\n"),
      calendar().replace("END:VEVENT", "END:VTODO"),
    ])
      expect(() => decode(bad)).toThrow();
    expect(() => parseInvitations(Uint8Array.from([255]))).toThrow();
    expect(() => parseInvitations(Buffer.alloc(262145))).toThrow();
  });
});

describe("inactive primary-calendar RSVP coordinator", () => {
  test("matches the exact zoned recurrence master without expanding occurrences", () => {
    const invitation = decode(
      calendar("RRULE:FREQ=WEEKLY;COUNT=3\r\n")
        .replace(
          "DTSTART:20260924T090000Z",
          "DTSTART;TZID=Europe/Berlin:20260924T110000",
        )
        .replace(
          "DTEND:20260924T100000Z",
          "DTEND;TZID=Europe/Berlin:20260924T120000",
        ),
    )[0];
    const event = {
      ...fixture().event,
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
      start: {
        dateTime: "2026-09-24T11:00:00+02:00",
        timeZone: "Europe/Berlin",
      },
      end: { dateTime: "2026-09-24T12:00:00+02:00", timeZone: "Europe/Berlin" },
    };
    expect(
      calendarResponseLimit(invitation, event, "lawyer@example.test"),
    ).toBeNull();
    expect(
      calendarResponseLimit(
        invitation,
        { ...event, recurrence: ["RRULE:FREQ=DAILY;COUNT=3"] },
        "lawyer@example.test",
      ),
    ).toContain("differs");
    expect(
      calendarResponseLimit(
        invitation,
        {
          ...event,
          start: { ...event.start, dateTime: "2026-09-24T11:00:00+01:00" },
        },
        "lawyer@example.test",
      ),
    ).toContain("differs");
  });
  test("retiring the coordinator invalidates pending reviews", async () => {
    const f = fixture();
    const review = await f.preview();
    f.service.dispose();
    await expect(
      f.service.respond("mail-account", review.token!, f.signal),
    ).rejects.toThrow("already used");
    expect(f.writes).toHaveLength(0);
  });
  test("explicit one-use review pins selected account and exact source; uses If-Match with Google notification transport", async () => {
    const f = fixture();
    expect(
      (await f.service.read("mail-account", f.source, f.signal)).invitations,
    ).toHaveLength(1);
    expect(f.writes).toHaveLength(0);
    const preview = await f.preview();
    expect(preview.account).toBe("lawyer@example.test");
    expect(preview.token).toBeTruthy();
    expect(
      (await f.service.respond("mail-account", preview.token!, f.signal))
        .outcome,
    ).toBe("updated");
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0].url).toContain(
      "/primary/events/event-id?sendUpdates=all",
    );
    expect(new Headers(f.writes[0].init.headers).get("If-Match")).toBe(
      '"version-2"',
    );
    expect(JSON.parse(String(f.writes[0].init.body)).attendees).toEqual([
      { ...f.event.attendees[0], responseStatus: "accepted" },
      f.event.attendees[1],
    ]);
    await expect(
      f.service.respond("mail-account", preview.token!, f.signal),
    ).rejects.toThrow("already used");
    expect(f.writes).toHaveLength(1);
  });
  test("organizer update, cancellation, delegated calendar and stale source never send", async () => {
    for (const change of ["sequence", "cancelled", "foreign", "source"]) {
      const f = fixture();
      const review = await f.preview();
      if (change === "sequence") f.setEvent({ ...f.event, sequence: 3 });
      if (change === "cancelled")
        f.setEvent({ ...f.event, status: "cancelled" });
      if (change === "foreign")
        f.setEvent({
          ...f.event,
          attendees: [
            {
              email: "other@example.test",
              self: true,
              responseStatus: "needsAction",
            },
          ],
        });
      if (change === "source") f.setRaw();
      await expect(
        f.service.respond("mail-account", review.token!, f.signal),
      ).rejects.toThrow();
      expect(f.writes).toHaveLength(0);
    }
  });
  test("account switch, forged review, lock and abort deny before transport", async () => {
    const f = fixture();
    const preview = await f.preview();
    f.setAccess({
      accountId: "other",
      email: "other@example.test",
      accessToken: "other",
    });
    await expect(
      f.service.respond("mail-account", preview.token!, f.signal),
    ).rejects.toThrow("account changed");
    await expect(
      f.service.respond("mail-account", "forged", f.signal),
    ).rejects.toThrow();
    f.lock();
    await expect(f.preview()).rejects.toThrow("Unlock");
    const second = fixture();
    await expect(
      second.service.preview(
        "mail-account",
        second.source,
        0,
        "accepted",
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    expect(f.writes).toHaveLength(0);
    expect(second.writes).toHaveLength(0);
  });
  test("identical existing response avoids duplicate notifications; stale etag cannot retry", async () => {
    const f = fixture();
    f.setEvent({
      ...f.event,
      attendees: [
        { ...f.event.attendees[0], responseStatus: "accepted" },
        f.event.attendees[1],
      ],
    });
    const preview = await f.preview();
    expect(
      (await f.service.respond("mail-account", preview.token!, f.signal))
        .outcome,
    ).toBe("unchanged");
    expect(f.writes).toHaveLength(0);
    const stale = fixture();
    const review = await stale.preview();
    stale.rejectVersion();
    await expect(
      stale.service.respond("mail-account", review.token!, stale.signal),
    ).rejects.toThrow("changed");
    expect(stale.writes).toHaveLength(1);
  });
  test("lost reply is uncertain and the consumed review cannot replay the write", async () => {
    const f = fixture();
    const preview = await f.preview();
    f.loseReply();
    expect(
      (await f.service.respond("mail-account", preview.token!, f.signal))
        .outcome,
    ).toBe("uncertain");
    await expect(
      f.service.respond("mail-account", preview.token!, f.signal),
    ).rejects.toThrow("already used");
    expect(f.writes).toHaveLength(1);
  });
});
