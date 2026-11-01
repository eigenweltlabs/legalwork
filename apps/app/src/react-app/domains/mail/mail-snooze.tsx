/** @jsxImportSource react */
import { useEffect, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { t } from '@/i18n';
import {MailSnoozeError,type MailSnooze} from '../../../../../server/src/mail/snooze-view';
import { MailClient, type MailMessageView } from './mail-client';
import { MailScheduleDialog } from './mail-schedule-dialog';
import { readMailSnooze, setMailSnooze } from './mail-snooze-client';

function snoozeError(error:unknown){
  if(!(error instanceof MailSnoozeError))return t('mail.snooze_failed');
  const keys={invalid_time:'mail.schedule_invalid',conflict:'mail.snooze_conflict',not_found:'mail.snooze_message_unavailable',unavailable:'mail.snooze_unavailable',limit:'mail.snooze_limit'} satisfies Record<MailSnoozeError['code'],Parameters<typeof t>[0]>;
  return t(keys[error.code]);
}

export function MailSnoozeControl({client,item,disabled,onChanged}:{client:MailClient;item:MailMessageView;disabled:boolean;onChanged:()=>void}){
  const [state,setState]=useState<MailSnooze|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const request=useRef<AbortController|null>(null),lock=useRef(false);
  useEffect(()=>{setState(null);setBusy(false);setError('');return()=>request.current?.abort();},[client,item.accountId,item.key]);
  async function open(){
    if(lock.current||disabled)return;lock.current=true;setBusy(true);setError('');
    const controller=new AbortController();request.current=controller;
    try{const current=await readMailSnooze(client,item,controller.signal);if(controller.signal.aborted)return;if(!current.available&&!current.time)throw new MailSnoozeError('unavailable');setState(current);}
    catch(error){if(!controller.signal.aborted)setError(snoozeError(error));}
    finally{lock.current=false;if(!controller.signal.aborted)setBusy(false);}
  }
  async function change(time:MailSnooze['time']){
    if(!state||!request.current)throw Error('Snooze changed.');
    await setMailSnooze(client,item,state,time,request.current.signal);
    if(!request.current.signal.aborted)onChanged();
  }
  return <><Button variant="ghost" size="icon-sm" data-mail-command="snooze" aria-label={t('mail.snooze_action')} title={t('mail.snooze_action')} disabled={disabled||busy} onClick={()=>void open()}><Clock size={15}/></Button>
    {error&&<Alert variant="destructive" role="alert">{error}</Alert>}
    {state&&<MailScheduleDialog mode="snooze" initial={state.time??undefined} subject={item.subject} scope={{kind:state.scope,count:state.count}} errorText={snoozeError} onClose={()=>setState(null)} onConfirm={time=>change(time)} onClear={state.time?()=>change(null):undefined}/>}</>;
}
