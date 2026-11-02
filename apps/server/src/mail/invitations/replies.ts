import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ApiError } from "../../errors.js";
import { MailServiceError, type MailService } from "../service-interface.js";
import { readMailInvitations } from "./read.js";
import type { MailInvitation } from "../invitation-view.js";
import { InvitationReplyError, type InvitationReplyPreviewInput, type InvitationReplyPreview, type InvitationReplyResult, type InvitationReplySelection, type InvitationCalendar } from "../invitation-reply-view.js";
import type { InvitationCalendarAccess, InvitationCalendarIdentity, InvitationCalendarEvent } from "./calendar.js";

type Mail = Pick<MailService, "status" | "readMessage" | "listParts" | "readContent" | "onLock" | "invitationJournal">;
type Open = (selection: InvitationReplySelection, signal: AbortSignal, identity?: InvitationCalendarIdentity) => Promise<InvitationCalendarAccess>;
type Review = { accountId: string; input: InvitationReplyPreviewInput; identity: InvitationCalendarIdentity; event: InvitationCalendarEvent; calendar: InvitationCalendarAccess["calendar"]; expiresAt: number };
const TTL = 5 * 60000;
const sameEmail = (first: string, second: string) => first.toLowerCase() === second.toLowerCase();
const refusedBeforeDispatch = (error: unknown) => error instanceof InvitationReplyError && (error.code==='account_changed'||error.code==='permission') || error instanceof ApiError && ['connector_permission_required','connector_calendar_permission_required','connector_inactive','connector_account_changed','connector_write_reconnect_required','connector_writes_disabled','connector_reconnect_required','connector_not_connected','connector_invalid_endpoint','read_only'].includes(error.code);
const key = (calendar: InvitationCalendarAccess, event: InvitationCalendarEvent) => createHash("sha256").update(JSON.stringify([calendar.calendar.connectorId, calendar.calendar.calendarId, event.view.id, event.view.replyAs.toLowerCase()])).digest("hex");

export function invitationReplyFailure(error: unknown): Error {
  if (error instanceof InvitationReplyError || error instanceof MailServiceError) return error;
  if (error instanceof ApiError) {
    if (["connector_permission_required", "connector_writes_disabled", "connector_write_not_granted", "read_only"].includes(error.code) || error.status === 403) return new InvitationReplyError("permission");
    if (error.status === 404) return new InvitationReplyError("not_found");
    if (["connector_account_changed", "connector_not_connected", "connector_reconnect_required", "connector_not_activated"].includes(error.code)) return new InvitationReplyError("account_changed");
  }
  return new InvitationReplyError("unavailable");
}

/** Host-owned reviews and dispatch. Neither the mail worker nor agents get Calendar tokens. */
export class MailInvitationReplies {
  private readonly reviews = new Map<string, Review>();
  private readonly work = new Set<AbortController>();
  private readonly unsubscribe?: () => void;
  private closed = false;
  constructor(private readonly mail: Mail, private readonly open: Open, private readonly list?: (signal: AbortSignal) => Promise<{ calendars: InvitationCalendar[]; unavailable: InvitationReplySelection['connectorId'][] }>) {
    this.unsubscribe = mail.onLock?.(() => this.invalidate());
  }
  private invalidate() { this.reviews.clear(); for (const abort of this.work) abort.abort(); }
  close() { this.closed = true; this.invalidate(); this.unsubscribe?.(); }
  calendars() { return this.during(async signal => { if (!this.list) throw new InvitationReplyError('unavailable'); const result = await this.list(signal); this.ready(signal); return result; }); }
  private ready(signal: AbortSignal) { if (this.closed || signal.aborted || this.mail.status().state !== "ready") throw new MailServiceError("locked"); }
  private async during<T>(body: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const abort = new AbortController(); this.work.add(abort);
    try { this.ready(abort.signal); return await body(abort.signal); }
    catch (error) { throw invitationReplyFailure(error); }
    finally { this.work.delete(abort); }
  }
  private journal(accountId: string, input: Parameters<NonNullable<Mail["invitationJournal"]>>[1]) {
    if (!this.mail.invitationJournal) throw new InvitationReplyError("unavailable");
    return this.mail.invitationJournal(accountId, input);
  }
  private async source(accountId: string, input: InvitationReplyPreviewInput, signal: AbortSignal) {
    const result = await readMailInvitations(this.mail, accountId, input.source);
    this.ready(signal);
    const invitation = result.invitations[input.index];
    if (!invitation) throw new InvitationReplyError("changed");
    if (invitation.status === "cancelled") throw new InvitationReplyError("cancelled");
    if (invitation.method !== "REQUEST" || !invitation.organizer) throw new InvitationReplyError("not_invitation");
    return invitation;
  }
  private assertParticipant(invitation: MailInvitation, event: InvitationCalendarEvent) {
    if (!invitation.organizer || !sameEmail(invitation.organizer, event.view.organizer) || !invitation.attendees.some(email => sameEmail(email, event.view.replyAs))) throw new InvitationReplyError("not_invitation");
    if (Boolean(invitation.recurrenceId) !== (event.view.scope === "occurrence")) throw new InvitationReplyError("changed");
  }
  private async pending(accountId: string, calendar: InvitationCalendarAccess, event: InvitationCalendarEvent) {
    const result = await this.journal(accountId, { action: "read", key: key(calendar, event) });
    if (result.entry?.state !== "uncertain") return false;
    if (result.entry.response !== event.view.currentResponse) return true;
    await this.journal(accountId, { action: "finish", key: result.entry.key, attemptId: result.entry.attemptId, state: "confirmed" });
    return false;
  }
  preview(accountId: string, input: InvitationReplyPreviewInput): Promise<InvitationReplyPreview> {
    return this.during(async signal => {
      const invitation = await this.source(accountId, input, signal);
      const calendar = await this.open(input.calendar, signal);
      const event = await calendar.find(invitation);
      this.assertParticipant(invitation, event); this.ready(signal);
      const pending = await this.pending(accountId, calendar, event);
      const unchanged = event.view.currentResponse === input.response;
      if (!pending && !unchanged) await calendar.assertWrite();
      this.ready(signal);
      const expiresAt = Date.now() + TTL;
      for (const [token, review] of this.reviews) if (review.expiresAt <= Date.now()) this.reviews.delete(token);
      if (this.reviews.size >= 128) this.reviews.delete(this.reviews.keys().next().value!);
      const token = pending || unchanged ? null : randomBytes(32).toString("hex");
      if (token) this.reviews.set(token, { accountId, input: { ...input, calendar: { connectorId: calendar.calendar.connectorId, connectionId: calendar.calendar.connectionId, calendarId: calendar.calendar.calendarId } }, identity: calendar.identity, calendar: calendar.calendar, event, expiresAt });
      const equalTime = (source: MailInvitation["start"], target: typeof event.view.start) => source !== null && (source.kind === "date" ? source.value === target.value : source.instant !== null && source.instant === target.instant);
      return { token, expiresAt, calendar: calendar.calendar, event: event.view, response: input.response, status: pending ? "pending" : unchanged ? "unchanged" : "ready", changedSinceInvitation: invitation.title !== event.view.title || invitation.location !== event.view.location || !equalTime(invitation.start, event.view.start) || !equalTime(invitation.end, event.view.end) };
    });
  }
  async respond(accountId: string, token: string): Promise<InvitationReplyResult> {
    const review = this.reviews.get(token); this.reviews.delete(token);
    if (!review || review.accountId !== accountId || review.expiresAt <= Date.now()) throw new InvitationReplyError("expired");
    return this.during(async signal => {
      const invitation = await this.source(accountId, review.input, signal);
      const calendar = await this.open(review.input.calendar, signal, review.identity);
      if (calendar.identity.id !== review.identity.id || !sameEmail(calendar.identity.email, review.identity.email) || calendar.calendar.calendarId !== review.calendar.calendarId) throw new InvitationReplyError("account_changed");
      const event = await calendar.get(review.event.view.id);
      this.assertParticipant(invitation, event); this.ready(signal);
      if (await this.pending(accountId, calendar, event)) throw new InvitationReplyError("pending");
      if (event.view.currentResponse === review.input.response) return { outcome: "unchanged", response: review.input.response };
      if (event.view.revision !== review.event.view.revision || event.view.uid !== review.event.view.uid || !sameEmail(event.view.replyAs, review.event.view.replyAs)) throw new InvitationReplyError("changed");
      await calendar.assertWrite();
      // Recheck the original after provider reads, then durably claim before dispatch.
      await this.source(accountId, review.input, signal); this.ready(signal);
      const journalKey = key(calendar, event), attemptId = randomUUID();
      const claim = await this.journal(accountId, { action: "begin", key: journalKey, attemptId, response: review.input.response });
      if (!claim.claimed) throw new InvitationReplyError("pending");
      let outcome: InvitationReplyResult["outcome"] = "uncertain";
      let dispatchStarted = false;
      let providerReturned = false;
      try {
        this.ready(signal);
        // The durable claim can wait on another database writer. Read Calendar
        // once more afterward so that delay cannot silently approve a new event.
        const final = await calendar.get(event.view.id); this.ready(signal);
        if (final.view.revision !== event.view.revision) {
          await this.journal(accountId, { action: "finish", key: journalKey, attemptId, state: "rejected" });
          return { outcome: "rejected", response: review.input.response };
        }
        dispatchStarted = true;
        const result = await calendar.respond(final, review.input.response);
        providerReturned = true;
        const status = result.status; await result.body?.cancel();
        // A provider refusal has not applied the response. Transport loss and
        // asynchronous success stay uncertain until a matching provider read.
        if ([400, 401, 403, 404, 409, 412].includes(status)) {
          await this.journal(accountId, { action: "finish", key: journalKey, attemptId, state: "rejected" });
          outcome = "rejected";
        } else if (result.ok) {
          const current = await calendar.get(event.view.id);
          this.ready(signal);
          if (current.view.uid === event.view.uid && sameEmail(current.view.replyAs, event.view.replyAs) && current.view.currentResponse === review.input.response) {
            await this.journal(accountId, { action: "finish", key: journalKey, attemptId, state: "confirmed" });
            outcome = "confirmed";
          }
        }
      } catch (error) {
        // A failed preflight has not dispatched. Once the provider method starts,
        // transport failure remains uncertain. Never turn that into a retry.
        if (!dispatchStarted || !providerReturned && refusedBeforeDispatch(error)) {
          try { await this.journal(accountId, { action: "finish", key: journalKey, attemptId, state: "rejected" }); outcome = "rejected"; }
          catch { /* Locked storage retains its conservative claim. */ }
        }
      }
      return { outcome, response: review.input.response };
    });
  }
}
