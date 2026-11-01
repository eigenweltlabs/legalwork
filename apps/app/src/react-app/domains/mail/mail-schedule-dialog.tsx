/** @jsxImportSource react */
import { useId, useRef, useState, type RefObject } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { t } from '@/i18n';
import { MailSettingsSelect } from '../settings/pages/mail-settings-controls';
import { mailTimeZoneSchema, validFutureMailTime, type MailTime } from '../../../../../server/src/mail/scheduling-view';
import type { MailDraftView } from '../../../../../server/src/mail/local-view';
import { formatMailSchedule, mailScheduleCandidates, mailScheduleWall } from './mail-scheduling-model';

export function MailScheduleDialog({ initial, subject, message, mode='send', scope, finalFocus, onClear, errorText, onClose, onConfirm }: { initial?: MailTime; subject: string; message?: Pick<MailDraftView['content'], 'from' | 'to' | 'cc' | 'bcc'>; mode?:'send'|'snooze'; scope?:{kind:'message'|'conversation';count:number}; finalFocus?:RefObject<HTMLElement|null>; onClear?:()=>Promise<void>; errorText?:(error:unknown)=>string; onClose: () => void; onConfirm: (time: MailTime) => Promise<void> }) {
  const [zone, setZone] = useState(initial?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [wall, setWall] = useState(initial ? mailScheduleWall(initial) : '');
  const [choice, setChoice] = useState(initial ? String(initial.at) : '');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false), cancel = useRef<HTMLButtonElement>(null), id = useId();
  const candidates = mailScheduleCandidates(wall, zone);
  const at = candidates.length === 1 ? candidates[0].at : candidates.find(item => String(item.at) === choice)?.at;
  const time = at === undefined ? undefined : { at, timeZone: zone };
  async function confirm() {
    if (lock.current) return;
    if (!mailTimeZoneSchema.safeParse(zone).success) { setError(t('mail.schedule_zone_invalid')); return; }
    if (wall && !candidates.length) { setError(t('mail.schedule_nonexistent')); return; }
    if (candidates.length > 1 && !time) { setError(t('mail.schedule_choose_occurrence')); return; }
    if (!time || !validFutureMailTime(time, Date.now())) { setError(t('mail.schedule_invalid')); return; }
    await apply(()=>onConfirm(time));
  }
  async function apply(operation:()=>Promise<void>){
    if(lock.current)return;
    lock.current = true; setBusy(true); setError('');
    try { await operation(); onClose(); }
    catch(error) { setError(errorText?errorText(error):t(mode==='snooze'?'mail.snooze_failed':'mail.schedule_failed')); }
    finally { lock.current = false; setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !lock.current) onClose(); }}><DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto" initialFocus={cancel} finalFocus={finalFocus} onKeyDownCapture={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); } }}>
    <DialogHeader><DialogTitle>{t(mode==='snooze'?'mail.snooze_title':initial ? 'mail.reschedule_title' : 'mail.schedule_title')}</DialogTitle></DialogHeader>
    <p className="break-words text-sm font-medium">{subject}</p>
    <div className="grid gap-4">
      <div className="grid gap-1.5"><Label htmlFor={`${id}-time`}>{t('mail.schedule_date')}</Label><Input id={`${id}-time`} type="datetime-local" value={wall} disabled={busy} onChange={event => { setWall(event.target.value); setChoice(''); setError(''); }} /></div>
      <div className="grid gap-1.5"><Label htmlFor={`${id}-zone`}>{t('mail.schedule_zone')}</Label><Input id={`${id}-zone`} value={zone} disabled={busy} onChange={event => { setZone(event.target.value); setChoice(''); setError(''); }} /></div>
      {candidates.length > 1 && <div className="grid gap-1.5"><Label htmlFor={`${id}-occurrence`}>{t('mail.schedule_occurrence')}</Label><MailSettingsSelect id={`${id}-occurrence`} value={choice} disabled={busy} onChange={setChoice}><option value="">{t('mail.schedule_choose_occurrence')}</option>{candidates.map(item => <option key={item.at} value={String(item.at)}>{item.offset}</option>)}</MailSettingsSelect></div>}
    </div>
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
      {message && <><dt className="text-muted-foreground">{t('mail.schedule_from')}</dt><dd className="break-words">{message.from}</dd><dt className="text-muted-foreground">{t('mail.schedule_to')}</dt><dd className="break-words">{message.to.join(', ')}</dd>{message.cc.length > 0 && <><dt className="text-muted-foreground">Cc</dt><dd className="break-words">{message.cc.join(', ')}</dd></>}{message.bcc.length > 0 && <><dt className="text-muted-foreground">Bcc</dt><dd className="break-words">{message.bcc.join(', ')}</dd></>}</>}
      {scope&&<><dt className="text-muted-foreground">{t('mail.snooze_scope')}</dt><dd>{t(scope.kind==='conversation'?'mail.snooze_conversation':'mail.snooze_message')} ({scope.count})</dd></>}
      {time && <><dt className="text-muted-foreground">{t(mode==='snooze'?'mail.snooze_until':'mail.send_at')}</dt><dd>{formatMailSchedule(time)}</dd></>}
      <dt className="text-muted-foreground">{t('mail.schedule_execution')}</dt><dd>{t('mail.schedule_device')}</dd>
      {mode==='send'&&<><dt className="text-muted-foreground">{t('mail.schedule_unavailable')}</dt><dd>{t('mail.schedule_when_available')}</dd></>}
    </dl>
    {error && <Alert variant="destructive" role="alert">{error}</Alert>}
    <DialogFooter>{mode==='snooze'&&onClear&&<Button variant="outline" disabled={busy} onClick={()=>void apply(onClear)}>{t('mail.snooze_clear')}</Button>}<Button ref={cancel} variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button><Button disabled={busy||mode==='snooze'&&scope?.count===0} onClick={() => void confirm()}>{t(mode==='snooze'?'mail.snooze_action':initial ? 'mail.schedule_change' : 'mail.schedule_action')}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
