import type { MailInvitation, MailInvitationTime } from '../../../../../server/src/mail/invitation-view';

export function invitationDay(start: MailInvitationTime | null): string | null {
  if (!start) return null;
  if (!start.instant) return start.value.slice(0, 10);
  const date = new Date(start.instant);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function invitationTime(value: MailInvitationTime, locale: string): string {
  if (value.kind === 'date') return new Date(`${value.value}T12:00:00Z`).toLocaleDateString(locale, { dateStyle: 'long', timeZone: 'UTC' });
  if (value.instant) return new Date(value.instant).toLocaleString(locale, { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  return `${value.value.replace('T', ' ')}${value.timeZone ? ` (${value.timeZone})` : ''}`;
}

export function invitationRange(invitation: Pick<MailInvitation, 'start' | 'end'>, locale: string): string | null {
  if (!invitation.start) return null;
  const start = invitationTime(invitation.start, locale);
  if (!invitation.end) return start;
  if (invitation.start.kind === 'date' && invitation.end.kind === 'date') {
    const last = new Date(`${invitation.end.value}T12:00:00Z`);
    last.setUTCDate(last.getUTCDate() - 1);
    const lastDay = last.toISOString().slice(0, 10);
    return lastDay === invitation.start.value ? start : `${start} – ${invitationTime({ ...invitation.end, value: lastDay }, locale)}`;
  }
  return `${start} – ${invitationTime(invitation.end, locale)}`;
}
