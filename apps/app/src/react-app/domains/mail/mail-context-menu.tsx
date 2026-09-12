import {mailShortcut,type MailCommand} from './mail-keyboard';
/** @jsxImportSource react */
import type {MailMessageView} from './mail-client';
import {useEffect,useRef,useState,type ReactNode} from 'react';
import {ContextMenu,ContextMenuTrigger,ContextMenuContent,ContextMenuItem,ContextMenuSeparator,ContextMenuSub,ContextMenuSubTrigger} from '@/components/ui/context-menu';
export type MailMenuSelection={count:number;archive:boolean;mixed:boolean;signature:string};
export const mailSelectionSignature=(items:MailMessageView[])=>JSON.stringify(items.map(item=>[item.accountId,item.key,item.locator,item.mutationPrecondition]));
export type MailActionCommand={id:string;label:string;control:HTMLButtonElement|null;disabled:boolean;shortcut:string|null};
/** Both keyboard and context actions activate the existing controls, which own checks/journals/undo. */
const actions:Array<[MailCommand|'delete',string]>=[['read','Mark read'],['unread','Mark unread'],['flag','Flag'],['archive','Archive'],['trash','Move to Trash'],['delete','Permanently delete…']];
export function mailActionCommands(root:HTMLElement,selection:MailMenuSelection):MailActionCommand[]{return actions.map(([id,label])=>{const control=root.querySelector<HTMLButtonElement>(`[data-mail-command="${id}"]`);return{id,label:control?.getAttribute('aria-label')??label,control,disabled:selection.archive||!control||control.disabled,shortcut:id==='delete'?null:mailShortcut(id).hint};});}
export function MailRowMenu({children,prepare,onOpen,className}:{children:ReactNode;prepare:()=>MailMenuSelection|Promise<MailMenuSelection>;onOpen:()=>void;className?:string}){
 const trigger=useRef<HTMLDivElement>(null),returnFocus=useRef<HTMLElement|null>(null),epoch=useRef(0),prepared=useRef<string|null>(null);
 const [open,setOpen]=useState(false),[selection,setSelection]=useState<MailMenuSelection>(),[error,setError]=useState(''),[,update]=useState(0);
 const signature=(element:HTMLElement|null)=>JSON.stringify([element?.dataset.mailSelection,element?.dataset.mailReader]);
 const root=()=>trigger.current?.closest<HTMLElement>('.mail-workspace')??null;
 useEffect(()=>{if(!open)return;const element=root();if(!element)return;const observer=new MutationObserver(()=>{if(prepared.current!==null&&signature(element)!==prepared.current){epoch.current++;setOpen(false);prepared.current=null;}else update(value=>value+1);});observer.observe(element,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled','aria-label','aria-keyshortcuts','data-mail-selection','data-mail-reader']});return()=>observer.disconnect();},[open]);
 useEffect(()=>()=>{epoch.current++;},[]);
 const change=(next:boolean)=>{setOpen(next);const version=++epoch.current;prepared.current=null;if(!next)return;returnFocus.current=trigger.current?.querySelector<HTMLElement>('.mail-message-row,.mail-search-subject')??trigger.current;setSelection(undefined);setError('');void Promise.resolve().then(prepare).then(value=>{requestAnimationFrame(()=>{if(version===epoch.current){if(root()?.dataset.mailSelection!==value.signature){setOpen(false);return;}prepared.current=signature(root());setSelection(value);}});}).catch(()=>{if(version===epoch.current)setError('This selection is unavailable. Refresh the list and retry.');});};
 const invoke=(control:HTMLButtonElement|null)=>{if(prepared.current===signature(root())&&control&&!control.disabled&&control.isConnected)control.click();else setOpen(false);};
 const element=root(),commands=element&&selection?mailActionCommands(element,selection):[];
 const move=element?.querySelector<HTMLSelectElement>('[data-mail-command="move"]');
 const reader:Array<[string,string]>=[['Reply','Reply'],['Reply all','Reply all'],['Forward','Forward']];
 const keyboard=(event:React.KeyboardEvent<HTMLDivElement>)=>{if(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey){event.preventDefault();event.stopPropagation();const box=event.currentTarget.getBoundingClientRect();event.currentTarget.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:box.left+Math.min(40,box.width/2),clientY:box.top+Math.min(24,box.height/2)}));}};
 return <ContextMenu open={open} onOpenChange={change}><ContextMenuTrigger ref={trigger} className={className??'mail-context-row'} onKeyDown={keyboard} onClickCapture={event=>{if(event.ctrlKey&&/Mac/.test(navigator.platform)){event.preventDefault();event.stopPropagation();event.currentTarget.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:event.clientX,clientY:event.clientY}));}}}>{children}</ContextMenuTrigger><ContextMenuContent className="mail-row-context-menu" finalFocus={()=>{const target=returnFocus.current;if(target?.isConnected)target.focus({preventScroll:true});return false;}}>
 {!selection?<ContextMenuItem disabled>{error||'Preparing selection…'}</ContextMenuItem>:<>
 <div className="mail-menu-caption">{selection.count} {selection.count===1?'message':'messages'}{selection.mixed?' · multiple accounts':''}</div>
 {selection.count===1&&<><ContextMenuItem onClick={()=>{if(prepared.current===signature(root()))onOpen();}}>Open</ContextMenuItem>{reader.map(([label,aria])=>{const control=element?.querySelector<HTMLButtonElement>(`[aria-label="${aria}"]`)??null;return <ContextMenuItem key={label} disabled={selection.archive||!control||control.disabled} onClick={()=>invoke(control)}>{label}<span className="mail-menu-shortcut">{control?.getAttribute('aria-keyshortcuts')}</span></ContextMenuItem>;})}<ContextMenuSeparator/></>}
 {selection.archive&&<div className="mail-menu-caption">Local archives are read-only.</div>}
 {commands.filter(command=>command.id!=='delete').map(command=><ContextMenuItem key={command.id} disabled={command.disabled} onClick={()=>invoke(command.control)}>{command.label}<span className="mail-menu-shortcut">{command.shortcut}</span></ContextMenuItem>)}
 <ContextMenuSub><ContextMenuSubTrigger disabled={selection.archive||selection.mixed||!move||move.disabled}>{move?.getAttribute('aria-label')??'Move or label'}…</ContextMenuSubTrigger><ContextMenuContent className="mail-row-context-menu">{move&&Array.from(move.options).filter(option=>option.value).map(option=><ContextMenuItem key={option.value} onClick={()=>{if(prepared.current!==signature(root())||!move.isConnected||move.disabled)return;move.value=option.value;move.dispatchEvent(new Event('change',{bubbles:true}));}}>{option.text}</ContextMenuItem>)}</ContextMenuContent></ContextMenuSub>
 {selection.mixed&&<div className="mail-menu-caption">Move/label requires one account.</div>}
 {!selection.archive&&commands.every(command=>command.disabled)&&<div className="mail-menu-caption">Wait for pending actions or refresh access.</div>}
 {selection.count===1&&<><ContextMenuSeparator/><ContextMenuItem onClick={()=>invoke(element?.querySelector<HTMLButtonElement>('[aria-label="Save mail to connected storage"]')??null)}>Save to workspace or matter…</ContextMenuItem></>}
 <ContextMenuSeparator/>{commands.filter(command=>command.id==='delete').map(command=><ContextMenuItem key={command.id} disabled={command.disabled} onClick={()=>invoke(command.control)}>{command.label}</ContextMenuItem>)}
 </>}
 </ContextMenuContent></ContextMenu>;
}
