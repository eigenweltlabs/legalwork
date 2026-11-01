import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarDays } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { SectionHeading } from '../../design-system/surface';
import { currentLocale, t } from '@/i18n';
import type { MailInvitation } from '../../../../../server/src/mail/invitation-view';
import type { MailClient, MailMessageView, MailPartView } from './mail-client';
import { invitationDay, invitationRange, invitationTime } from './mail-invitation-model';
import { calendarRecurrence } from '../calendar/calendar-recurrence';
import { formatCalendarDay } from '../calendar/calendar-format';

export function MailInvitations({ client, item, part }: { client: MailClient; item: MailMessageView; part: MailPartView }) {
  const [invitations, setInvitations] = useState<MailInvitation[]>([]);
  const [error, setError] = useState(false), [loading, setLoading] = useState(true), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setInvitations([]); setLoading(true); setError(false);
    void client.invitations(item, part, abort.signal).then(result => {
      if (!abort.signal.aborted) setInvitations(result.invitations);
    }).catch(() => { if (!abort.signal.aborted) setError(true); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [client, item.accountId, item.key, item.rawReferenceId, part.partId, part.referenceId, attempt]);
  if (loading) return <p role="status" className="py-3 text-sm text-muted-foreground">{t('mail.invitation_loading')}</p>;
  if (error) return <Alert variant="destructive" className="my-3 flex items-center justify-between gap-2">{t('mail.invitation_failed')}<Button variant="ghost" size="sm" onClick={() => setAttempt(value => value + 1)}>{t('common.retry')}</Button></Alert>;
  return <div className="divide-y divide-border">{invitations.map((invitation, index) => <Invitation key={index} invitation={invitation} />)}</div>;
}

function Invitation({ invitation }: { invitation: MailInvitation }) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const day = invitationDay(invitation.start), range = invitationRange(invitation, currentLocale());
  const label = invitation.status === 'cancelled' ? t('mail.invitation_cancelled') : invitation.status === 'update' ? t('mail.invitation_updated') : invitation.status === 'invitation' ? t('mail.invitation') : t('calendar.event');
  return <section className="space-y-3 border-b border-border py-4">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>{label}</span>
      {invitation.recurrence.length > 0 && <span>{t('mail.invitation_repeats')}</span>}
      {invitation.recurrenceId && <span>{t('mail.invitation_occurrence')}</span>}
      {invitation.delegated && <span>{t('mail.invitation_delegated')}</span>}
    </div>
    <SectionHeading title={invitation.title || t('calendar.event')} action={day && <Button size="sm" variant="outline" onClick={() => navigate(`/calendar?date=${day}`)}><CalendarDays />{t('mail.invitation_calendar')}</Button>} />
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
      {range && <><dt className="text-muted-foreground">{t('mail.invitation_when')}</dt><dd>{range}{invitation.start?.kind === 'date' && <span className="ml-2 text-muted-foreground">{t('calendar.all_day')}</span>}{invitation.start?.kind === 'floating' && <span className="ml-2 text-muted-foreground">{t('mail.invitation_floating')}</span>}</dd></>}
      {invitation.organizer && <><dt className="text-muted-foreground">{t('mail.invitation_organizer')}</dt><dd className="break-words">{invitation.organizer}</dd></>}
      {invitation.location && <><dt className="text-muted-foreground">{t('mail.invitation_location')}</dt><dd className="whitespace-pre-wrap break-words">{invitation.location}</dd></>}
    </dl>
    <Button size="sm" variant="ghost" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{t('mail.invitation_details')}</Button>
    {expanded && <div className="space-y-3 text-sm">
      {invitation.description && <p className="whitespace-pre-wrap break-words">{invitation.description}</p>}
      {invitation.attendees.length > 0 && <div><p className="text-xs text-muted-foreground">{t('mail.invitation_attendees')}</p><p className="break-words">{invitation.attendees.join(', ')}</p></div>}
      {invitation.recurrenceId && <p>{t('mail.invitation_occurrence')}: {invitationTime(invitation.recurrenceId, currentLocale())}</p>}
      {invitation.recurrence.length > 0 && <InvitationRecurrence rules={invitation.recurrence} />}
    </div>}
  </section>;
}

function InvitationRecurrence({ rules }: { rules: string[] }) {
  const rule = calendarRecurrence(rules);
  const frequencies: Record<string, string> = { DAILY: 'calendar.repeat_daily', WEEKLY: 'calendar.repeat_weekly', MONTHLY: 'calendar.repeat_monthly', YEARLY: 'calendar.repeat_yearly', HOURLY: 'calendar.repeat_hourly' };
  const frequency = rule && frequencies[rule.frequency];
  const weekdays = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
  const days = rule?.days.map(value => {
    const index = weekdays.indexOf(value.slice(-2));
    if (index < 0) return '';
    const day = new Date(2026, 0, 5 + index).toLocaleDateString(currentLocale(), { weekday: 'long' });
    return value.startsWith('-1') ? t('calendar.repeat_last_weekday', { day }) : value.length > 2 ? t('calendar.repeat_nth_weekday', { count: value.slice(0, -2), day }) : day;
  }).filter(Boolean);
  return <div className="space-y-1 text-sm">
    <p>{frequency && rule ? t(frequency, { count: rule.interval }) : t('calendar.recurring_event')}</p>
    {days?.length ? <p>{days.join(', ')}</p> : null}
    {rule?.monthDays.length ? <p>{t('calendar.repeat_month_days', { days: rule.monthDays.join(', ') })}</p> : null}
    {rule?.count ? <p>{t('calendar.repeat_count', { count: rule.count })}</p> : rule?.until ? <p>{t('calendar.repeat_until', { date: formatCalendarDay(rule.until, { dateStyle: 'medium' }) })}</p> : null}
  </div>;
}
