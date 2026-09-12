import {mailShortcutProps} from './mail-keyboard';
/** @jsxImportSource react */
import {useEffect,useRef,useState} from 'react';
import {Archive,Trash2,Flag,Mail,MailOpen,FolderInput,Tag,MoreHorizontal,Undo2,FolderPlus,X} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Dialog,DialogContent,DialogHeader,DialogTitle,DialogDescription,DialogFooter} from '@/components/ui/dialog';
import {Input} from '@/components/ui/input';
import {MailClient,type MailMessageView,type MailFolderView,type MailAccountView} from './mail-client';
import {MailActionsClient,pendingAction,actionLabel,actionStateLabel,type ActionEntry} from './mail-actions-client';
import type {MailMutation} from '../../../../../server/src/mail/local-view';
export const mailItemId=(item:Pick<MailMessageView,'accountId'|'key'>)=>item.accountId+'|'+item.key;
export function optimisticMail(item:MailMessageView,entries:ActionEntry[]):MailMessageView{
 let current=item;
 for(const entry of entries){if(entry.accountId!==item.accountId||!pendingAction(entry.state)||JSON.stringify(entry.mutation?.locator)!==JSON.stringify(item.locator))continue;
  const change=entry.mutation?.change;
  if(change?.kind==='read')current={...current,isRead:change.read};
  if(change?.kind==='flags')current={...current,isFlagged:change.add.includes('\\Flagged')||(!change.remove.includes('\\Flagged')&&current.isFlagged)};
 }
 return current;
}
export function MailActionBar({blocked=false,client,accounts,accountId,selected,folder,folders,onEntries,onRefresh}:{blocked?:boolean;client:MailClient;accounts:MailAccountView[];accountId:string;selected:MailMessageView[];folder?:MailFolderView;folders:MailFolderView[];onEntries:(entries:ActionEntry[])=>void;onRefresh:()=>void}){
 const [entries,setEntries]=useState<ActionEntry[]>([]),[busy,setBusy]=useState(false),[errors,setErrors]=useState<string[]>([]),[showActivity,setShowActivity]=useState(false),[next,setNext]=useState<string|null>(null);
 const [dialog,setDialog]=useState<'delete'|'create'|'rename'|'delete-folder'|null>(null),[name,setName]=useState(''),[destinations,setDestinations]=useState<MailFolderView[]>([]);
 const api=useRef(new MailActionsClient(client)),store=useRef(new Map<string,ActionEntry>()),abort=useRef(new AbortController()),refresh=useRef(onRefresh),notify=useRef(onEntries);refresh.current=onRefresh;notify.current=onEntries;
 const watched=accountId||selected[0]?.accountId||'';const scope=useRef(watched);scope.current=watched;const moreLoaded=useRef(false);
 function publish(){const values=[...store.current.values()];setEntries(values);notify.current(values);}
 function remember(entry:ActionEntry){const previous=store.current.get(entry.id);store.current.set(entry.id,entry);if(previous&&previous.version.revision!==entry.version.revision&&!pendingAction(entry.state))refresh.current();}
 useEffect(()=>{api.current=new MailActionsClient(client);abort.current=new AbortController();store.current.clear();moreLoaded.current=false;setBusy(false);setNext(null);publish();let running=false;const signal=abort.current.signal;
  const poll=async()=>{if(running)return;running=true;try{
   const ids=new Set([scope.current,...[...store.current.values()].filter(item=>pendingAction(item.state)).map(item=>item.accountId)].filter(Boolean));
   for(const id of ids){const page=await api.current.list(id,signal);if(signal.aborted)return;for(const item of page.items)remember({...item,accountId:id});if(id===scope.current&&!moreLoaded.current)setNext(page.nextCursor);
    const known=page.items.map(item=>item.id);for(const old of [...store.current.values()].filter(item=>item.accountId===id&&pendingAction(item.state)&&!known.includes(item.id))){const latest=await api.current.read(id,old.id,signal);if(signal.aborted)return;remember({...latest,accountId:id});}
   }publish();
  }catch{if(!signal.aborted)setErrors(['Action status is unavailable. Existing queued changes are preserved.']);}finally{running=false;}};
  void poll();const timer=setInterval(()=>void poll(),2000);return()=>{clearInterval(timer);abort.current.abort();};
 },[client,watched]);
 const targetAccount=selected.length&&selected.every(item=>item.accountId===selected[0].accountId)?selected[0].accountId:accountId;
 useEffect(()=>{const controller=new AbortController();setDestinations([]);if(!targetAccount)return;void(async()=>{const result:MailFolderView[]=[];let after:string|undefined;do{const page=await client.folders(targetAccount,controller.signal,after);result.push(...page.items);after=page.nextCursor??undefined;if(result.length>2000)throw Error('Too many folders');}while(after);if(!controller.signal.aborted)setDestinations(result);})().catch(()=>{});return()=>controller.abort();},[client,targetAccount,folders]);
 async function apply(change:MailMutation['change']){
  if(busy)return;setBusy(true);setErrors([]);const failed:string[]=[];const signal=abort.current.signal;
  for(const item of selected){if(signal.aborted)break;try{const current=await client.check(item,signal);if(!current.mutationPrecondition||current.removed)throw Error('Message is not available for changes yet.');
   const result=await api.current.mutate(item.accountId,{replayKey:crypto.randomUUID(),locator:current.locator,precondition:current.mutationPrecondition,change},signal);if(signal.aborted)break;remember({...result,accountId:item.accountId});publish();
  }catch(error){if(!signal.aborted)failed.push(`${item.subject||'(No subject)'}: ${error instanceof Error?error.message:'Could not queue change.'}`);}}
  if(!signal.aborted){setBusy(false);setErrors(failed);setShowActivity(true);}
 }
 async function undo(entry:ActionEntry){const signal=abort.current.signal;try{const current=await api.current.read(entry.accountId,entry.id,signal);if(signal.aborted)return;if(!['queued','retry','running'].includes(current.state))throw Error('This action has reached the provider and can no longer be cancelled safely.');const result=await api.current.cancel({...current,accountId:entry.accountId},signal);if(signal.aborted)return;remember({...result,accountId:entry.accountId});publish();}catch(error){if(!signal.aborted)setErrors([error instanceof Error?error.message:'Could not cancel action.']);}}
 async function changeFolder(){if(!dialog||dialog==='delete'||!accountId)return;setBusy(true);setErrors([]);const signal=abort.current.signal;try{
  const change:MailMutation['change']={kind:'mailbox',operation:dialog==='create'?'create':dialog==='rename'?'rename':'delete',path:dialog==='create'?name:folder?.id??'',...(dialog==='rename'?{destination:name}:{})};
  const precondition=dialog==='create'?accounts.find(value=>value.id===accountId)?.provider+'-mailbox-v1':folder?.mutationPrecondition;if(!precondition)throw Error('Refresh this folder before changing it.');
  const result=await api.current.mutate(accountId,{replayKey:crypto.randomUUID(),precondition,change},signal);if(signal.aborted)return;remember({...result,accountId});publish();setDialog(null);setShowActivity(true);
 }catch(error){if(!signal.aborted)setErrors([error instanceof Error?error.message:'Could not queue folder change.']);}finally{if(!signal.aborted)setBusy(false);}}
 const hasPending=selected.some(item=>entries.some(entry=>entry.accountId===item.accountId&&pendingAction(entry.state)&&JSON.stringify(entry.mutation?.locator)===JSON.stringify(item.locator)));
 const disabled=blocked||busy||!selected.length||hasPending;
 const singleAccount=selected.length>0&&selected.every(item=>item.accountId===selected[0].accountId),gmail=singleAccount&&selected[0].locator.provider==='gmail';
 const activity=entries.filter(entry=>entry.kind==='mutation'&&(entry.accountId===accountId||!accountId||selected.some(item=>item.accountId===entry.accountId)));
 return <div className="mail-action-area">
  <div className="mail-bulk-toolbar" role="toolbar" aria-label="Mailbox actions">
   <span>{selected.length?`${selected.length} selected`:''}</span>
   <button className="mail-icon-button" data-mail-command="read" aria-label="Mark read" {...mailShortcutProps('read','Mark read')} disabled={disabled} onClick={()=>void apply({kind:'read',read:true})}><MailOpen size={15}/></button>
   <button className="mail-icon-button" data-mail-command="unread" aria-label="Mark unread" {...mailShortcutProps('unread','Mark unread')} disabled={disabled} onClick={()=>void apply({kind:'read',read:false})}><Mail size={15}/></button>
   <button className="mail-icon-button" data-mail-command="flag" aria-label={selected.every(item=>item.isFlagged)?'Unflag':'Flag'} {...mailShortcutProps('flag','Flag or unflag')} disabled={disabled} onClick={()=>void apply({kind:'flags',add:selected.every(item=>item.isFlagged)?[]:['\\Flagged'],remove:selected.every(item=>item.isFlagged)?['\\Flagged']:[]})}><Flag size={15}/></button>
   <button className="mail-icon-button" data-mail-command="archive" aria-label="Archive" {...mailShortcutProps('archive','Archive')} disabled={disabled} onClick={()=>void apply({kind:'special',operation:'archive'})}><Archive size={15}/></button>
   <button className="mail-icon-button" data-mail-command="trash" aria-label="Move to Trash" {...mailShortcutProps('trash','Move to Trash')} disabled={disabled} onClick={()=>void apply({kind:'special',operation:'trash'})}><Trash2 size={15}/></button>
   <label className="mail-action-select" title={gmail?'Apply label':'Move to folder'}>{gmail?<Tag size={15}/>:<FolderInput size={15}/>}<select data-mail-command="move" aria-label={gmail?'Apply label':'Move to folder'} disabled={disabled||!singleAccount} value="" onChange={event=>{if(event.target.value)void apply(gmail?{kind:'memberships',add:[event.target.value],remove:[]}:{kind:'move',destination:event.target.value});}}><option value="">{gmail?'Label':'Move'}</option>{destinations.filter(value=>value.kind!=='label'||!['INBOX','UNREAD','STARRED','SENT','DRAFT','TRASH','SPAM','CHAT','IMPORTANT'].includes(value.id)).map(value=><option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
   <details className="mail-more-actions" onClick={event=>{if(event.target instanceof Element&&event.target.closest('button:not(:disabled)'))event.currentTarget.open=false;}}><summary aria-label="More mailbox actions" title="More actions"><MoreHorizontal size={16}/></summary><div>
    <button disabled={disabled} onClick={()=>void apply({kind:'special',operation:'spam'})}>Mark as spam</button><button disabled={disabled} onClick={()=>void apply({kind:'special',operation:'inbox'})}>Move to Inbox</button>
    {gmail&&folder?.kind==='label'&&<button disabled={disabled} onClick={()=>void apply({kind:'memberships',add:[],remove:[folder.id]})}>Remove this label</button>}
    <button data-mail-command="delete" aria-label="Permanently delete…" disabled={disabled} onClick={()=>setDialog('delete')}>Permanently delete…</button>
    <button disabled={!accountId||busy} onClick={()=>{setName('');setDialog('create');}}><FolderPlus size={13}/>New folder or label…</button>
    <button disabled={!folder?.mutationPrecondition||busy} onClick={()=>{setName(folder?.name??'');setDialog('rename');}}>Rename folder or label…</button>
    <button disabled={!folder?.mutationPrecondition||busy} onClick={()=>setDialog('delete-folder')}>Delete folder or label…</button>
   </div></details>
   <button className="mail-activity-toggle" onClick={()=>setShowActivity(value=>!value)} aria-expanded={showActivity}>Activity{activity.filter(item=>pendingAction(item.state)||item.state==='failed'||item.state==='uncertain').length?` (${activity.filter(item=>pendingAction(item.state)||item.state==='failed'||item.state==='uncertain').length})`:''}</button>
  </div>
  {errors.map((error,index)=><p className="mail-action-error" role="alert" key={index}>{error}</p>)}
  {showActivity&&<section className="mail-action-activity" aria-label="Mail action activity"><button className="mail-icon-button" aria-label="Close action activity" onClick={()=>setShowActivity(false)}><X size={13}/></button>{activity.map(entry=><div key={entry.id}><strong>{actionLabel(entry)}</strong><span>{actionStateLabel(entry)}</span>{['queued','retry','running'].includes(entry.state)&&<button aria-label={`Undo ${actionLabel(entry)}`} title="Cancel before the provider receives it" onClick={()=>void undo(entry)}><Undo2 size={13}/>Undo</button>}</div>)}{!activity.length&&<p>No pending mail actions.</p>}{next&&accountId&&<button onClick={()=>void api.current.list(accountId,abort.current.signal,next).then(page=>{for(const entry of page.items)remember({...entry,accountId});moreLoaded.current=true;setNext(page.nextCursor);publish();}).catch(()=>setErrors(['Could not load more actions.']))}>More pending actions</button>}</section>}
  <Dialog open={dialog!==null} onOpenChange={open=>{if(!open&&!busy)setDialog(null);}}><DialogContent><DialogHeader><DialogTitle>{dialog==='delete'?'Permanently delete selected messages?':dialog==='create'?'New folder or label':dialog==='rename'?'Rename folder or label':'Delete folder or label?'}</DialogTitle><DialogDescription>{dialog==='delete'?'This removes the messages from the provider permanently and cannot be undone there. Locally retained originals and filed copies remain. Gmail requires additional account permission.':dialog==='delete-folder'?'Gmail removes this label from messages. Outlook and IMAP folders must be empty. System folders cannot be deleted.':'Choose a name for this account.'}</DialogDescription></DialogHeader>{(dialog==='create'||dialog==='rename')&&<Input aria-label="Folder or label name" value={name} maxLength={512} onChange={event=>setName(event.target.value)}/>}<DialogFooter><Button variant="outline" disabled={busy} onClick={()=>setDialog(null)}>Cancel</Button><Button disabled={busy||((dialog==='create'||dialog==='rename')&&!name.trim())} onClick={()=>{if(dialog==='delete'){setDialog(null);void apply({kind:'delete'});}else void changeFolder();}}>{dialog==='delete'?'Delete permanently':dialog==='delete-folder'?'Delete':dialog==='rename'?'Rename':'Create'}</Button></DialogFooter></DialogContent></Dialog>
 </div>;
}
