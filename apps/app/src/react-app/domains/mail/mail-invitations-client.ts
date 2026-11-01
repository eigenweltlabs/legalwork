import { invitationCalendarsSchema, invitationReplyPreviewSchema, invitationReplyResultSchema, type InvitationReplySelection, type InvitationResponse } from '../../../../../server/src/mail/invitation-reply-view';
import { MailClient, type MailMessageView, type MailPartView } from './mail-client';

export class MailInvitationsClient {
  constructor(private readonly client: MailClient) {}
  calendars(signal: AbortSignal) { return this.client.request('/invitations/calendars', invitationCalendarsSchema, signal, undefined, false, 90000); }
  preview(item: MailMessageView, part: MailPartView, index: number, calendar: InvitationReplySelection, response: InvitationResponse, signal: AbortSignal) {
    return this.client.request(`/accounts/${encodeURIComponent(item.accountId)}/messages/invitations/preview`, invitationReplyPreviewSchema, signal, { source: { locator: item.locator, partId: part.partId, referenceId: part.referenceId, rawReferenceId: item.rawReferenceId }, index, calendar, response }, false, 90000);
  }
  respond(item: MailMessageView, token: string, signal: AbortSignal) { return this.client.request(`/accounts/${encodeURIComponent(item.accountId)}/messages/invitations/respond`, invitationReplyResultSchema, signal, { token }, false, 120000); }
}
