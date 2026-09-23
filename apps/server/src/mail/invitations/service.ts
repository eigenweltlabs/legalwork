import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ApiError } from "../../errors.js";
import type { MailService } from "../service-interface.js";
import { providerMessageKey } from "../model.js";
import {
  invitationSourceSchema,
  type Invitation,
  type InvitationPreview,
  type InvitationResponse,
  type InvitationResult,
} from "../invitation-view.js";
import { parseInvitations } from "./parse.js";

export type InvitationAccess = {
  accountId: string;
  email: string;
  accessToken: string;
};
type Source = z.infer<typeof invitationSourceSchema>;
type Reader = Pick<
  MailService,
  "status" | "readMessage" | "listParts" | "readContent" | "onLock"
>;
const attendeeSchema = z
  .object({
    email: z.string().optional(),
    self: z.boolean().optional(),
    responseStatus: z.string().optional(),
    organizer: z.boolean().optional(),
  })
  .passthrough();
const eventSchema = z
  .object({
    id: z.string(),
    etag: z.string(),
    iCalUID: z.string().optional(),
    sequence: z.number().optional(),
    status: z.string(),
    summary: z.string().optional(),
    location: z.string().optional(),
    description: z.string().optional(),
    organizer: z
      .object({ email: z.string().optional(), self: z.boolean().optional() })
      .optional(),
    start: z
      .object({
        date: z.string().optional(),
        dateTime: z.string().optional(),
        timeZone: z.string().optional(),
      })
      .optional(),
    end: z
      .object({
        date: z.string().optional(),
        dateTime: z.string().optional(),
        timeZone: z.string().optional(),
      })
      .optional(),
    recurrence: z.array(z.string()).optional(),
    recurringEventId: z.string().optional(),
    attendees: z.array(attendeeSchema).optional(),
    attendeesOmitted: z.boolean().optional(),
    eventType: z.string().optional(),
  })
  .passthrough();
type CalendarEvent = z.infer<typeof eventSchema>;
type Review = {
  accountId: string;
  source: Source;
  index: number;
  response: InvitationResponse;
  pin: string;
  calendarAccount: string;
  email: string;
  eventId: string;
  etag: string;
  expires: number;
};
function conflict(
  message = "The invitation or calendar changed. Check the calendar again before responding.",
): never {
  throw new ApiError(409, "mail_invitation_changed", message);
}
function matchesTime(
  local: Invitation["start"],
  remote: CalendarEvent["start"],
): boolean {
  if (!remote) return false;
  if (local.kind === "date") return remote.date === local.value;
  if (!remote.dateTime || !Number.isFinite(Date.parse(remote.dateTime)))
    return false;
  if (local.kind === "utc")
    return Date.parse(local.value) === Date.parse(remote.dateTime);
  if (
    local.kind !== "zoned" ||
    !local.timeZone ||
    remote.timeZone !== local.timeZone
  )
    return false;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: local.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(remote.dateTime));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return (
    `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}` ===
    local.value
  );
}
function currentAttendee(event: CalendarEvent, email: string) {
  return event.attendees?.find(
    (a) => a.self === true && a.email?.toLowerCase() === email.toLowerCase(),
  );
}
export function calendarResponseLimit(
  invitation: Invitation,
  event: CalendarEvent,
  email: string,
): string | null {
  if (invitation.responseLimit) return invitation.responseLimit;
  if (event.status === "cancelled")
    return "Your calendar marks this meeting as cancelled. No response will be sent.";
  if (
    event.iCalUID !== invitation.uid ||
    event.organizer?.email?.toLowerCase() !== invitation.organizer
  )
    return "The organizer does not match the event in your calendar. Open your calendar to review it.";
  if (
    event.organizer?.self ||
    !currentAttendee(event, email) ||
    !invitation.attendees.includes(email.toLowerCase()) ||
    event.attendeesOmitted
  )
    return "The selected primary-calendar account is not the invited attendee. Delegated calendars are not supported here.";
  if (
    event.recurringEventId ||
    (event.eventType && event.eventType !== "default")
  )
    return "Respond to this occurrence or special calendar event in your calendar app.";
  if (
    (event.sequence ?? 0) !== invitation.sequence ||
    event.summary !== invitation.summary ||
    (event.location ?? "") !== invitation.location ||
    (event.description ?? "") !== invitation.description ||
    !matchesTime(invitation.start, event.start) ||
    !invitation.end ||
    !matchesTime(invitation.end, event.end) ||
    JSON.stringify([...(event.recurrence ?? [])].sort()) !==
      JSON.stringify([...invitation.recurrence].sort())
  )
    return "This email differs from the current calendar event. Review the organizer’s latest invitation in your calendar app.";
  return null;
}
export class InvitationService {
  private readonly reviews = new Map<string, Review>();
  private epoch = 0;
  private readonly unsubscribe: (() => void) | undefined;
  constructor(
    private readonly mail: Reader,
    private readonly access: () => Promise<InvitationAccess>,
    private readonly transport: (
      url: string,
      init: RequestInit,
    ) => Promise<Response> = fetch,
  ) {
    this.unsubscribe = mail.onLock?.(() => this.clear());
  }
  dispose() {
    this.clear();
    this.unsubscribe?.();
  }
  clear() {
    this.epoch++;
    this.reviews.clear();
  }
  private ready(signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.mail.status().state !== "ready")
      throw new ApiError(
        423,
        "mail_locked",
        "Unlock Mail before reviewing invitations.",
      );
  }
  private async source(accountId: string, input: Source, signal: AbortSignal) {
    this.ready(signal);
    const message = await this.mail.readMessage(accountId, input.locator);
    if (
      message.accountId !== accountId ||
      message.key !== providerMessageKey(input.locator) ||
      message.removed ||
      !message.rawReferenceId
    )
      conflict();
    let after: string | undefined;
    let part;
    for (let i = 0; i < 10; i++) {
      const page = await this.mail.listParts(accountId, input.locator, {
        limit: 100,
        ...(after ? { after } : {}),
      });
      part = page.items.find(
        (p) =>
          p.kind === "attachment" &&
          p.partId === input.partId &&
          p.referenceId === input.referenceId,
      );
      if (part || !page.nextCursor) break;
      after = page.nextCursor;
    }
    if (
      !part ||
      part.contentType?.toLowerCase() !== "text/calendar" ||
      !part.bytesAvailable ||
      part.bytes === null ||
      part.bytes > 256 * 1024 ||
      !part.sha256
    )
      throw new ApiError(
        409,
        "mail_invitation_unavailable",
        "Download this calendar attachment before opening it, or save it to your calendar app if it exceeds 256 KB.",
      );
    const bytes = Buffer.alloc(part.bytes);
    let offset = 0;
    do {
      this.ready(signal);
      const chunk = await this.mail.readContent(accountId, input.locator, {
        kind: "attachment",
        partId: input.partId,
        referenceId: input.referenceId,
        offset,
        limit: 24576,
      });
      const data = Buffer.from(chunk.data, "base64");
      if (
        chunk.accountId !== accountId ||
        providerMessageKey(chunk.locator) !== message.key ||
        chunk.referenceId !== input.referenceId ||
        chunk.totalBytes !== bytes.length ||
        chunk.sha256 !== part.sha256 ||
        chunk.offset !== offset ||
        offset + data.length > bytes.length ||
        chunk.nextOffset !==
          (offset + data.length === bytes.length
            ? null
            : offset + data.length) ||
        (!data.length && bytes.length)
      )
        conflict();
      bytes.set(data, offset);
      offset += data.length;
    } while (offset < bytes.length);
    if (createHash("sha256").update(bytes).digest("hex") !== part.sha256)
      conflict();
    const checked = await this.mail.readMessage(accountId, input.locator);
    if (checked.removed || checked.rawReferenceId !== message.rawReferenceId)
      conflict();
    this.ready(signal);
    let invitations: Invitation[];
    try {
      invitations = parseInvitations(bytes);
    } catch {
      throw new ApiError(
        422,
        "mail_invitation_invalid",
        "This calendar attachment cannot be displayed. Save the original and open it in your calendar app.",
      );
    }
    return { invitations, pin: message.rawReferenceId + ":" + part.sha256 };
  }
  async read(accountId: string, input: Source, signal: AbortSignal) {
    return {
      invitations: (await this.source(accountId, input, signal)).invitations,
    };
  }
  private async request(
    path: string,
    access: InvitationAccess,
    signal: AbortSignal,
  ) {
    const response = await this.transport(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events" + path,
      {
        headers: { Authorization: `Bearer ${access.accessToken}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
        redirect: "error",
      },
    );
    if (!response.ok)
      throw new ApiError(
        409,
        "mail_calendar_unavailable",
        "Your primary calendar is unavailable. Check the selected Google Workspace account and calendar permissions in Settings.",
      );
    return response.json();
  }
  async preview(
    accountId: string,
    source: Source,
    index: number,
    response: InvitationResponse,
    signal: AbortSignal,
  ): Promise<InvitationPreview> {
    const epoch = this.epoch;
    const loaded = await this.source(accountId, source, signal);
    const invitation = loaded.invitations[index];
    if (!invitation) conflict();
    const result: InvitationPreview = {
      token: null,
      account: null,
      invitation,
      currentResponse: null,
      calendarStart: null,
      calendarEnd: null,
      notice: invitation.responseLimit,
    };
    if (result.notice) return result;
    let access: InvitationAccess;
    try {
      access = await this.access();
    } catch (error) {
      result.notice =
        error instanceof ApiError
          ? error.message
          : "Calendar access is unavailable. Check Google Workspace in Settings.";
      return result;
    }
    result.account = access.email;
    const page = z
      .object({
        items: z.array(eventSchema).default([]),
        nextPageToken: z.string().optional(),
      })
      .parse(
        await this.request(
          "?" +
            new URLSearchParams({
              iCalUID: invitation.uid,
              showDeleted: "true",
              singleEvents: "false",
              maxResults: "100",
            }),
          access,
          signal,
        ),
      );
    const candidates = page.items.filter((event) => !event.recurringEventId);
    if (page.nextPageToken || candidates.length !== 1) {
      result.notice =
        "No single matching event was found in the selected primary calendar. Add or review the original invitation in your calendar app; LegalWork does not import it automatically.";
      return result;
    }
    const event = candidates[0];
    result.notice = calendarResponseLimit(invitation, event, access.email);
    result.currentResponse =
      currentAttendee(event, access.email)?.responseStatus ?? null;
    result.calendarStart = event.start?.dateTime ?? event.start?.date ?? null;
    result.calendarEnd = event.end?.dateTime ?? event.end?.date ?? null;
    if (result.notice) return result;
    this.ready(signal);
    for (const [key, value] of this.reviews)
      if (value.expires < Date.now()) this.reviews.delete(key);
    if (this.reviews.size >= 128)
      this.reviews.delete(this.reviews.keys().next().value!);
    if (this.epoch !== epoch) conflict();
    const token = randomUUID();
    this.reviews.set(token, {
      accountId,
      source,
      index,
      response,
      pin: loaded.pin,
      calendarAccount: access.accountId,
      email: access.email,
      eventId: event.id,
      etag: event.etag,
      expires: Date.now() + 5 * 60_000,
    });
    result.token = token;
    return result;
  }
  async respond(
    accountId: string,
    token: string,
    signal: AbortSignal,
  ): Promise<InvitationResult> {
    this.ready(signal);
    const epoch = this.epoch;
    const review = this.reviews.get(token);
    this.reviews.delete(token);
    if (
      !review ||
      review.accountId !== accountId ||
      review.expires < Date.now()
    )
      conflict(
        "This response review expired or was already used. Check the calendar again.",
      );
    const loaded = await this.source(accountId, review.source, signal);
    if (loaded.pin !== review.pin) conflict();
    const invitation = loaded.invitations[review.index];
    if (!invitation) conflict();
    const access = await this.access();
    if (
      access.accountId !== review.calendarAccount ||
      access.email !== review.email
    )
      conflict(
        "The selected calendar account changed. Check the calendar again.",
      );
    const event = eventSchema.parse(
      await this.request(
        "/" + encodeURIComponent(review.eventId),
        access,
        signal,
      ),
    );
    if (
      event.id !== review.eventId ||
      event.etag !== review.etag ||
      calendarResponseLimit(invitation, event, access.email)
    )
      conflict();
    if (
      currentAttendee(event, access.email)?.responseStatus === review.response
    )
      return {
        outcome: "unchanged",
        message:
          "Your calendar already has this response. No notification was sent.",
      };
    const checked = await this.source(accountId, review.source, signal);
    if (checked.pin !== review.pin) conflict();
    const current = await this.access();
    if (
      current.accountId !== access.accountId ||
      current.email !== access.email
    )
      conflict();
    this.ready(signal);
    if (this.epoch !== epoch) conflict();
    // Google Calendar's etag is the durable duplicate/version fence. Never retry this write.
    // https://developers.google.com/calendar/api/guides/version-resources
    let reply: Response;
    try {
      reply = await this.transport(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events/" +
          encodeURIComponent(event.id) +
          "?sendUpdates=all",
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${current.accessToken}`,
            "Content-Type": "application/json",
            "If-Match": review.etag,
          },
          body: JSON.stringify({
            attendees: event.attendees!.map((a) =>
              a.self && a.email?.toLowerCase() === access.email.toLowerCase()
                ? { ...a, responseStatus: review.response }
                : a,
            ),
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
          redirect: "error",
        },
      );
    } catch {
      return {
        outcome: "uncertain",
        message:
          "The calendar response could not be confirmed. It may have been sent. Check your calendar before trying again.",
      };
    }
    if (reply.status === 412) conflict();
    if (!reply.ok)
      return {
        outcome: "uncertain",
        message:
          "The calendar did not confirm this response. Check your calendar before trying again.",
      };
    return {
      outcome: "updated",
      message:
        "Your response was recorded in Google Calendar. Google Calendar handles meeting notifications.",
    };
  }
}
