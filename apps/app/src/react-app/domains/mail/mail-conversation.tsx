/** @jsxImportSource react */
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {MailClient,type MailMessageView} from './mail-client';
import {optimisticMail,mailItemId} from './mail-actions';
import type {ActionEntry} from './mail-actions-client';
export const conversationId=(item:MailMessageView)=>JSON.stringify([item.accountId,item.threadId?'thread':'message',item.threadId??item.key]);
export function MailConversation({grouped=true,client,item,entries,onOpen,onInitialOpen,render}:{grouped?:boolean;client:MailClient;item:MailMessageView;entries:ActionEntry[];onOpen:(item:MailMessageView|undefined)=>void;onInitialOpen:(item:MailMessageView)=>void;render:(item:MailMessageView,active:boolean,onRemoved:()=>void)=>ReactNode}){
 const [messages,setMessages]=useState([item]),[expanded,setExpanded]=useState(()=>new Set([item.key])),[after,setAfter]=useState<string|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const loading=useRef<AbortSignal|null>(null);
 const initial=useRef(item),controller=useRef(new AbortController()),open=useRef(onInitialOpen);open.current=onInitialOpen;
 async function load(cursor?:string,expose=true){
  const source=initial.current;if(!grouped||!source.threadId)return;
  const signal=controller.current.signal;
  if(loading.current===signal||signal.aborted)return;
  loading.current=signal;setBusy(true);
  try{
   const page=await client.messages(source.accountId,{threadId:source.threadId,after:cursor},signal);
   if(signal.aborted)return;
   setMessages(previous=>{const merged=new Map(previous.map(value=>[value.key,value]));for(const value of page.items)merged.set(value.key,value);return [...merged.values()];});
   // Only a deliberate conversation open/load exposes unread cards. Polling never expands them again.
   const unread=page.items.filter(value=>value.isRead===false);
   if(expose){const latest=!cursor?page.items[0]:undefined;setExpanded(previous=>new Set([...previous,...unread.map(value=>value.key),...(latest?[latest.key]:[])]));for(const value of unread)open.current(value);}
   if(expose)setAfter(page.nextCursor);setError('');
  }catch(error){if(!signal.aborted)setError(error instanceof Error?error.message:'Conversation unavailable.');}
  finally{if(loading.current===signal){loading.current=null;if(!signal.aborted)setBusy(false);}}
 }
 useEffect(()=>{const abort=new AbortController();controller.current=abort;void load();const timer=setInterval(()=>void load(undefined,false),5000);return()=>{abort.abort();clearInterval(timer);};},[client]);
 useEffect(()=>{setExpanded(previous=>previous.has(item.key)?previous:new Set([...previous,item.key]));},[item.key]);
 useEffect(()=>{setMessages(previous=>previous.some(value=>value.key===item.key)?previous.map(value=>value.key===item.key?item:value):[...previous,item]);},[item]);
 const ordered=[...messages].sort((a,b)=>(a.receivedAt??0)-(b.receivedAt??0)||a.key.localeCompare(b.key));
 return <div className="mail-conversation" aria-label="Conversation">
  {after&&<button disabled={busy} onClick={()=>void load(after)}>Load earlier messages</button>}
  {error&&<p role="status">{error}</p>}
  {ordered.map(observed=>{const value=optimisticMail(observed,entries),active=value.key===item.key,shown=expanded.has(value.key);return <section key={mailItemId(value)} className="mail-conversation-message" data-active={active}>
   {messages.length>1&&<button className="mail-conversation-toggle" aria-expanded={shown} onClick={()=>{if(shown&&active)setExpanded(previous=>{const next=new Set(previous);next.delete(value.key);return next;});else{setExpanded(previous=>new Set([...previous,value.key]));onOpen(value);}}}>
    <span>{value.metadata?.from||'Sender not downloaded'}</span><time>{value.receivedAt?new Date(value.receivedAt).toLocaleString():''}</time>{value.isRead===false&&<span aria-label="Unread"> ●</span>}
   </button>}
   <div hidden={!shown}>{shown&&render(value,active,()=>{setMessages(previous=>previous.filter(message=>message.key!==value.key));if(active)onOpen(undefined);})}</div>
  </section>;})}
 </div>;
}
