import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {X} from 'lucide-react';
import {t} from '@/i18n';
import {mailRecipientParts,mailRecipientAddress,mailRecipientAddresses,mailRecipientsInvalid} from '../../../../../server/src/mail/recipients';
import {Input} from '@/components/ui/input';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type KeyboardEvent } from "react";
import {
  contactsResultSchema,
  type ContactSuggestion,
} from "../../../../../server/src/mail/contacts-view";
import type { MailClient } from "./mail-client";
/** Suggestions replace only the unfinished recipient, preserving earlier addresses. */
export function recipientFragment(value: string) {
  const tail=mailRecipientParts(value).at(-1)??'';
  const boundary=value.length-tail.length-1;
  return {
    prefix: boundary < 0 ? "" : value.slice(0, boundary + 1) + " ",
    query: value.slice(boundary + 1).trim(),
  };
}
export function recipientOptions(
  value: string,
  contacts: ContactSuggestion[],
  history: string[],
) {
  const { prefix, query } = recipientFragment(value),
    seen = new Set<string>();
  return [
    ...contacts.map((contact) => ({
      address: contact.address,
      label: `${contact.name || contact.address} · Personal contacts`,
    })),
    ...history
      .filter((address) => address.toLowerCase().includes(query.toLowerCase()))
      .map((address) => ({ address, label: "Recent draft recipient" })),
  ]
    .flatMap((item) => {
      const key = item.address.toLowerCase();
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ value: prefix + item.address, label: item.label }];
    })
    .slice(0, 30);
}
export function MailRecipientInput({client,account,label,value,onChange,history,id}: {
  client:MailClient;account:string;label:string;value:string;onChange:(value:string)=>void;history:string[];id?:string;
}) {
  const list=useId(),input=useRef<HTMLInputElement>(null),buttons=useRef(new Map<number,HTMLButtonElement>());
  const [contacts,setContacts]=useState<ContactSuggestion[]>([]),[focused,setFocused]=useState(false);
  const [editing,setEditing]=useState<number|null>(()=>{const index=mailRecipientParts(value).findIndex(part=>part.trim()!==''&&mailRecipientAddress(part)===null);return index<0?null:index;});
  const [selected,setSelected]=useState<number|null>(null),nextFocus=useRef<number|'input'|null>(null),selectInput=useRef(false);
  const parts=mailRecipientParts(value),buffer=editing===null?'':parts[editing]?.trimStart()??'';
  const {query}=recipientFragment(buffer);
  useLayoutEffect(()=>{
    const target=nextFocus.current;nextFocus.current=null;
    if(target==='input'){input.current?.focus();if(selectInput.current)input.current?.select();}
    else if(target!==null)buttons.current.get(target)?.focus();
    selectInput.current=false;
    if(editing!==null&&editing>=parts.length)setEditing(null);
  },[value,editing]);
  useEffect(()=>{
    const controller=new AbortController();setContacts([]);
    if(!focused)return()=>controller.abort();
    const timer=setTimeout(()=>{
      void client.request('/accounts/'+encodeURIComponent(account)+'/contacts',contactsResultSchema,controller.signal,{action:'search',query:query.slice(0,256)})
        .then(result=>{if(!controller.signal.aborted)setContacts(result.items);}).catch(()=>{});
    },150);
    return()=>{clearTimeout(timer);controller.abort();};
  },[client,account,query,focused]);
  function change(text:string){
    const at=editing??(parts.at(-1)?.trim()===''?parts.length-1:parts.length),inserted=mailRecipientParts(text);
    const next=[...parts];next.splice(at,editing===null&&at===parts.length?0:1,...inserted);
    setEditing(at+inserted.length-1);setSelected(null);onChange(next.join(','));
  }
  function edit(index:number){
    nextFocus.current='input';selectInput.current=true;setSelected(null);setEditing(index);
    if(editing===index){input.current?.focus();input.current?.select();nextFocus.current=null;selectInput.current=false;}
  }
  function remove(index:number){
    const next=parts.filter((_,at)=>at!==index);nextFocus.current='input';setSelected(null);
    setEditing(editing===null||editing===index?null:editing>index?editing-1:editing);onChange(next.join(','));
  }
  function focusChip(index:number){setSelected(index);buttons.current.get(index)?.focus();}
  function chipKey(event:KeyboardEvent,index:number){
    if(event.nativeEvent.isComposing||event.metaKey||event.ctrlKey||event.altKey)return;
    const visible=parts.flatMap((part,at)=>part.trim()&&at!==editing?[at]:[]),at=visible.indexOf(index);
    if(event.key==='Backspace'||event.key==='Delete'){event.preventDefault();event.stopPropagation();remove(index);}
    else if(event.key==='Enter'||event.key==='F2'){event.preventDefault();event.stopPropagation();edit(index);}
    else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();input.current?.focus();}
    else if(event.key==='ArrowLeft'||event.key==='ArrowRight'){
      event.preventDefault();event.stopPropagation();const target=visible[at+(event.key==='ArrowLeft'?-1:1)];
      if(target===undefined)input.current?.focus();else focusChip(target);
    }
  }
  const entry=<Input key="entry" ref={input} id={id??list+'-input'} className="min-w-[12ch] flex-1 basis-24 rounded-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0" aria-label={label} aria-invalid={mailRecipientsInvalid(value)||undefined} list={list} autoComplete="off" spellCheck={false} maxLength={4096} value={buffer}
    onFocus={()=>{setFocused(true);setSelected(null);}} onBlur={()=>{setFocused(false);if(!buffer.trim()||mailRecipientAddress(buffer)!==null)setEditing(null);}}
    onPaste={event=>{const text=event.clipboardData.getData('text/plain');if(/[\r\n]/.test(text)){event.preventDefault();const start=event.currentTarget.selectionStart??buffer.length,end=event.currentTarget.selectionEnd??start;change(buffer.slice(0,start)+text+buffer.slice(end));}}}
    onChange={event=>change(event.target.value)} onKeyDown={event=>{
      if(event.nativeEvent.isComposing||event.metaKey||event.ctrlKey||event.altKey)return;
      if(event.key==='Enter'){event.preventDefault();event.stopPropagation();if(!buffer.trim()||mailRecipientAddress(buffer)!==null)setEditing(null);}
      else if((event.key==='Backspace'&&!buffer||event.key==='ArrowLeft'&&event.currentTarget.selectionStart===0&&event.currentTarget.selectionEnd===0)){
        const previous=parts.flatMap((part,index)=>part.trim()&&index<(editing??parts.length)?[index]:[]).at(-1);
        if(previous!==undefined){event.preventDefault();event.stopPropagation();focusChip(previous);}
      }
    }}/>;
  const children:ReactNode[]=[];
  for(const [index,part] of parts.entries()){
    if(index===editing){children.push(entry);continue;}
    if(!part.trim())continue;
    const address=mailRecipientAddress(part),text=part.trim();
    children.push(<Badge key={index} variant={address?'secondary':'destructive'} data-recipient-address={address??undefined} className="h-auto max-w-full gap-1 rounded-lg px-1.5 py-0.5 whitespace-normal">
      <button type="button" ref={element=>{if(element)buttons.current.set(index,element);else buttons.current.delete(index);}} tabIndex={selected===index?0:-1} className="max-w-[32ch] truncate rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/30" title={text} aria-label={t('mail.recipient_edit',{address:text})} onFocus={()=>setSelected(index)} onBlur={()=>setSelected(null)} onKeyDown={event=>chipKey(event,index)} onClick={()=>edit(index)}>{text}</button>
      <Button type="button" variant="ghost" size="icon-xs" className="size-4 shrink-0 rounded-sm" tabIndex={-1} aria-label={t('mail.recipient_remove',{address:text})} onMouseDown={event=>event.preventDefault()} onClick={()=>remove(index)}><X className="size-3"/></Button>
    </Badge>);
  }
  if(editing===null||editing>=parts.length)children.push(entry);
  const existing=new Set(parts.flatMap((part,index)=>index===editing?[]:mailRecipientAddresses(part)).map(address=>address.toLowerCase()));
  return <div className="flex min-w-0 flex-wrap items-center gap-1 py-1" onMouseDown={event=>{if(event.target===event.currentTarget)input.current?.focus();}}>
    {children}<datalist id={list}>{recipientOptions(buffer,contacts,history).filter(option=>!existing.has((mailRecipientAddresses(option.value).at(-1)??'').toLowerCase())).map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</datalist>
  </div>;
}
