import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { currentLocale, t } from '@/i18n';
import { openDesktopUrl } from '@/app/lib/desktop';
import { MailSettingsSelect } from '../settings/pages/mail-settings-controls';
import { CalendarEventDescription } from '../calendar/calendar-event-description';
import { invitationRange } from './mail-invitation-model';
import { MailInvitationsClient } from './mail-invitations-client';
import { MailClient, MailRequestError, type MailMessageView, type MailPartView } from './mail-client';
import type { InvitationCalendar, InvitationReplyPreview, InvitationReplyResult, InvitationResponse } from '../../../../../server/src/mail/invitation-reply-view';

const responseLabel = (response: InvitationResponse) => t(response === 'accepted' ? 'calendar.response_accepted' : response === 'tentative' ? 'calendar.response_tentative' : 'calendar.response_declined');
function errorLabel(error: unknown) {
  const code = error instanceof MailRequestError ? error.invitationCode : undefined;
  const labels = { changed: 'mail.invitation_reply_changed', cancelled: 'mail.invitation_cancelled', not_invitation: 'mail.invitation_reply_not_invited', not_found: 'mail.invitation_reply_not_found', ambiguous: 'mail.invitation_reply_ambiguous', permission: 'mail.invitation_reply_permission', account_changed: 'mail.invitation_reply_account_changed', unsupported_time: 'mail.invitation_reply_time', pending: 'mail.invitation_reply_uncertain', expired: 'mail.invitation_reply_expired', unavailable: 'mail.invitation_reply_unavailable' };
  return t(code ? labels[code] : 'mail.invitation_reply_unavailable');
}

export function MailInvitationReply({ client, item, part, index }: { client: MailClient; item: MailMessageView; part: MailPartView; index: number }) {
  const api = useMemo(() => new MailInvitationsClient(client), [client]), navigate = useNavigate();
  const [open, setOpen] = useState(false), [calendars, setCalendars] = useState<InvitationCalendar[]>([]), [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [loaded, setLoaded] = useState(false);
  const [review, setReview] = useState<InvitationReplyPreview>(), [last, setLast] = useState<InvitationReplyPreview>(), [result, setResult] = useState<InvitationReplyResult['outcome']>();
  const abort = useRef(new AbortController());
  useEffect(() => { const controller = new AbortController(); abort.current = controller; return () => controller.abort(); }, [api, item.accountId, item.key, item.rawReferenceId, part.referenceId]);
  const signal = () => abort.current.signal;
  async function load() {
    setOpen(true); setBusy(true); setError('');
    const current = signal();
    try {
      const page = await api.calendars(current); if (current.aborted) return;
      setCalendars(page.calendars); setLoaded(true);
      setSelected(value => page.calendars.some(calendar => JSON.stringify([calendar.connectorId, calendar.connectionId, calendar.calendarId]) === value) ? value : page.calendars.length ? JSON.stringify([page.calendars[0].connectorId, page.calendars[0].connectionId, page.calendars[0].calendarId]) : '');
      if (page.unavailable.length) setError(t('mail.invitation_reply_some_unavailable'));
    } catch (error) { if (!current.aborted) setError(errorLabel(error)); }
    finally { if (!current.aborted) setBusy(false); }
  }
  async function preview(response: InvitationResponse, previous?: InvitationReplyPreview) {
    const calendar = previous?.calendar ?? calendars.find(calendar => JSON.stringify([calendar.connectorId, calendar.connectionId, calendar.calendarId]) === selected);
    if (!calendar) return;
    setBusy(true); setError(''); const current = signal();
    try {
      const value = await api.preview(item, part, index, { connectorId: calendar.connectorId, connectionId: calendar.connectionId, calendarId: calendar.calendarId }, response, current);
      if (!current.aborted) { setReview(value); setLast(value); setResult(value.status === 'unchanged' ? 'unchanged' : value.status === 'pending' ? 'uncertain' : undefined); }
    } catch (error) { if (!current.aborted) setError(errorLabel(error)); }
    finally { if (!current.aborted) setBusy(false); }
  }
  async function confirm() {
    if (!review?.token || busy) return;
    const token = review.token, current = signal(); setBusy(true); setError('');
    // The local review loses its send authority immediately, including on timeout.
    setReview(value => value ? { ...value, token: null } : undefined);
    try { const value = await api.respond(item, token, current); if (!current.aborted) { setResult(value.outcome); setReview(undefined); } }
    catch (error) { if (!current.aborted) { setError(errorLabel(error)); setResult(error instanceof MailRequestError && error.invitationCode ? 'rejected' : 'uncertain'); setReview(undefined); } }
    finally { if (!current.aborted) setBusy(false); }
  }
  const chosen = calendars.find(calendar => JSON.stringify([calendar.connectorId, calendar.connectionId, calendar.calendarId]) === selected);
  return <div className="space-y-2">
    {!open ? <Button size="sm" variant="outline" onClick={() => void load()}>{t('mail.invitation_reply')}</Button> : <>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-48 flex-1"><MailSettingsSelect aria-label={t('mail.invitation_reply_calendar')} value={selected} disabled={busy} onChange={value => { setSelected(value); setResult(undefined); setLast(undefined); }}><option value="">{t('mail.invitation_reply_calendar')}</option>{calendars.map(calendar => { const value = JSON.stringify([calendar.connectorId, calendar.connectionId, calendar.calendarId]); return <option key={value} value={value}>{calendar.name} · {calendar.account}{calendar.canWrite ? '' : ` (${t('mail.invitation_reply_read_only')})`}</option>; })}</MailSettingsSelect></div>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>{t('common.refresh')}</Button>
      </div>
      {loaded && !calendars.length && <div className="flex items-center gap-2 text-sm text-muted-foreground"><span>{t('mail.invitation_reply_no_calendars')}</span><Button size="sm" variant="ghost" onClick={() => navigate('/settings/extensions/mcp')}>{t('mail.invitation_reply_integrations')}</Button></div>}
      {calendars.length > 0 && <div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" disabled={busy || !chosen?.canWrite || result === 'uncertain'} onClick={() => void preview('accepted')}>{t('mail.invitation_reply_accept')}</Button><Button size="sm" variant="outline" disabled={busy || !chosen?.canWrite || result === 'uncertain'} onClick={() => void preview('tentative')}>{t('mail.invitation_reply_tentative')}</Button><Button size="sm" variant="outline" disabled={busy || !chosen?.canWrite || result === 'uncertain'} onClick={() => void preview('declined')}>{t('mail.invitation_reply_decline')}</Button></div>}
    </>}
    {error && <Alert variant="destructive">{error}</Alert>}
    {result && <div role="status" className="flex flex-wrap items-center gap-2 text-sm"><span>{t(result === 'confirmed' || result === 'unchanged' ? 'mail.invitation_reply_saved' : result === 'rejected' ? 'mail.invitation_reply_rejected' : 'mail.invitation_reply_uncertain')}</span>{result === 'uncertain' && last && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void preview(last.response, last)}>{t('mail.invitation_reply_check')}</Button>}{last?.event.webUrl && <Button size="sm" variant="ghost" onClick={() => { if (last.event.webUrl) void openDesktopUrl(last.event.webUrl); }}>{t('mail.invitation_reply_open_provider')}</Button>}</div>}
    <Dialog open={Boolean(review)} onOpenChange={value => { if (!value && !busy) setReview(undefined); }}>
      <DialogContent className="sm:max-w-lg" onKeyDownCapture={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); } }}>
        <DialogHeader><DialogTitle>{t('mail.invitation_reply_review')}</DialogTitle><DialogDescription>{review?.calendar.name} · {review?.calendar.account}</DialogDescription></DialogHeader>
        {review && <div className="max-h-[55vh] space-y-4 overflow-y-auto text-sm">
          <div><h3 className="font-medium">{review.event.title}</h3>{review.changedSinceInvitation && <p className="text-xs text-muted-foreground">{t('mail.invitation_reply_calendar_updated')}</p>}</div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">{t('mail.invitation_reply_response')}</dt><dd>{responseLabel(review.response)}</dd>
            <dt className="text-muted-foreground">{t('mail.invitation_reply_as')}</dt><dd className="break-words">{review.event.replyAs}</dd>
            <dt className="text-muted-foreground">{t('mail.invitation_organizer')}</dt><dd className="break-words">{review.event.organizer}</dd>
            <dt className="text-muted-foreground">{t('mail.invitation_when')}</dt><dd>{invitationRange(review.event, currentLocale())}</dd>
            <dt className="text-muted-foreground">{t('mail.invitation_reply_scope')}</dt><dd>{t(review.event.scope === 'series' ? 'mail.invitation_reply_series' : review.event.scope === 'occurrence' ? 'mail.invitation_occurrence' : 'calendar.event')}</dd>
            {review.event.location && <><dt className="text-muted-foreground">{t('mail.invitation_location')}</dt><dd className="whitespace-pre-wrap break-words">{review.event.location}</dd></>}
          </dl>
          {review.event.description && <CalendarEventDescription text={review.event.description} html={review.event.descriptionType === 'html'} />}
          {review.status !== 'ready' && <p role="status">{t(review.status === 'pending' ? 'mail.invitation_reply_uncertain' : 'mail.invitation_reply_saved')}</p>}
        </div>}
        <DialogFooter><Button variant="outline" disabled={busy} autoFocus onClick={() => setReview(undefined)}>{t('common.cancel')}</Button>{review?.status === 'ready' && <Button disabled={busy || !review.token} onClick={() => void confirm()}>{t(busy ? 'mail.invitation_reply_sending' : 'mail.invitation_reply_send')}</Button>}</DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
