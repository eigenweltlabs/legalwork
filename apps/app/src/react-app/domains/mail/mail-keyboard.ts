export type MailPlatform='mac'|'windows';
export type MailCommand='compose'|'reply'|'replyAll'|'forward'|'search'|'read'|'unread'|'flag'|'archive'|'trash'|'send'|'save'|'help'|'folders';
export function mailPlatform():MailPlatform{return typeof navigator!=='undefined'&&/Mac/i.test(navigator.platform)?'mac':'windows';}
/** Platform differences deliberately preserve the shared shell's N/J/T/K/Shift+F commands. */
export function mailShortcut(command:MailCommand,platform=mailPlatform()){
 const mac=platform==='mac',mod=mac?'Meta':'Control';
 const values:Record<MailCommand,string[]>={compose:[mod+'+Shift+M','N','C'],reply:[mod+'+R','R'],replyAll:[mod+'+Shift+R','Shift+R'],forward:mac?['Shift+F']:['Control+F','Shift+F'],search:mac?['Meta+Alt+F','/']:['Control+E','F3','/'],read:['Control+Q','Q'],unread:['Control+U','U'],flag:['Insert','Shift+L'],archive:mac?['Control+E','E']:['E'],trash:mac?['Backspace','Delete']:['Delete'],send:[mod+'+Enter'],save:[mod+'+S'],help:['?'],folders:['Control+Y','F6']};
 const keys=values[command];return{aria:keys.join(' '),hint:keys.map(value=>value.replaceAll('Meta','⌘').replaceAll('Control','Ctrl').replaceAll('Alt',mac?'Option':'Alt')).join(' / ')};
}
export function mailShortcutProps(command:MailCommand,label:string){const shortcut=mailShortcut(command);return{title:label+' ('+shortcut.hint+')','aria-keyshortcuts':shortcut.aria};}
function eligible(event:KeyboardEvent,root:HTMLElement){const target=event.target;return !event.defaultPrevented&&!event.isComposing&&!event.repeat&&!event.getModifierState('AltGraph')&&target instanceof HTMLElement&&root.contains(target)&&!target.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[data-mail-shortcuts="off"]')&&!root.closest('[inert],[aria-hidden="true"]');}
export function mailComposerShortcut(event:KeyboardEvent,root:HTMLElement,platform=mailPlatform()):'send'|'save'|undefined{
 if(!eligible(event,root)||event.altKey||event.shiftKey)return;const mod=platform==='mac'?event.metaKey&&!event.ctrlKey:event.ctrlKey&&!event.metaKey;if(!mod)return;
 const command=event.key==='Enter'?'send':event.key.toLowerCase()==='s'?'save':undefined;if(command){event.preventDefault();event.stopPropagation();}return command;
}
const state=new WeakMap<HTMLElement,{anchor:HTMLButtonElement|null;prefix:string;time:number}>();
/** Local bubbling handler: never installs a global listener or synthesizes provider operations. */
export function mailKeyboard(event:KeyboardEvent,root:HTMLElement,options:{platform?:MailPlatform;showFolders?:()=>void}={}){
 if(!eligible(event,root))return;const target=event.target;if(!(target instanceof HTMLElement))return;
 const platform=options.platform??mailPlatform(),mac=platform==='mac',mod=mac?event.metaKey&&!event.ctrlKey:event.ctrlKey&&!event.metaKey,key=event.key.toLowerCase(),plain=!event.ctrlKey&&!event.metaKey&&!event.altKey;
 let memory=state.get(root);if(!memory){memory={anchor:null,prefix:'',time:0};state.set(root,memory);}
 const click=(selector:string)=>{const button=root.querySelector(selector);if(!(button instanceof HTMLButtonElement)||button.disabled||button.closest('[inert],[hidden]'))return false;button.click();return true;};
 const focus=(element:Element|null|undefined)=>{if(!(element instanceof HTMLElement))return false;element.focus();element.scrollIntoView({block:'nearest'});return document.activeElement===element;};
 const rows=()=>[...root.querySelectorAll<HTMLButtonElement>('.mail-message-row,.mail-search-subject')];
 const focusList=()=>{const items=rows();return focus(items.find(row=>row.getAttribute('aria-pressed')==='true')??items[0]??root.querySelector('[aria-label="Messages"]'));};
 const focusReader=()=>focus(root.querySelector('#mail-print-root')??root.querySelector('[aria-label="Message reader"]'));
 const focusFolders=()=>{options.showFolders?.();requestAnimationFrame(()=>{if(root.isConnected)focus(root.querySelector('.mail-folders .is-active')??root.querySelector('.mail-folders button'));});return true;};
 const editable=target.isContentEditable||!!target.closest('input:not([type="checkbox"]),textarea,select,[contenteditable],[role="textbox"],[role="combobox"],[role="slider"],[role="spinbutton"]');
 const folder=target.closest('.mail-folders'),list=target.closest('.mail-message-scroll,[aria-label="Search results"]'),composer=target.closest('[aria-label="Compose message"]');
 let handled=false;
 if(plain&&event.key==='Escape'&&target.matches('[aria-label="Search mail"]')){handled=click('[aria-label="Clear search"]');if(!handled)handled=focusList();}
 else if(!event.altKey&&!event.ctrlKey&&!event.metaKey&&event.key==='F6'){
  const pane=folder?0:target.closest('.mail-message-list')?1:target.closest('.mail-reader-pane')?2:-1,next=(pane+(event.shiftKey?-1:1)+3)%3;
  handled=next===0?focusFolders():next===1?focusList():focusReader();
 }
 else if(editable)return;
 else if(composer){if(plain&&!event.shiftKey&&event.key==='Escape')handled=click('[aria-label="Close composer"]');}
 else if(plain&&event.key==='?')handled=click('[aria-label="Mail keyboard shortcuts"]');
 else if((plain&&event.key==='/')||(!mac&&event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&key==='e')||(!mac&&plain&&!event.shiftKey&&event.key==='F3')||(mac&&event.metaKey&&event.altKey&&!event.ctrlKey&&!event.shiftKey&&key==='f'))handled=focus(root.querySelector('[aria-label="Search mail"]'));
 else if(event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&key==='y')handled=focusFolders();
 else if(folder&&plain){
  const buttons=[...root.querySelectorAll<HTMLButtonElement>('.mail-folders .mail-nav-row:not(:disabled)')],at=buttons.indexOf(target.closest('button')??buttons[0]);
  if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){const index=event.key==='Home'?0:event.key==='End'?buttons.length-1:Math.max(0,Math.min(buttons.length-1,at+(event.key==='ArrowDown'?1:-1)));handled=focus(buttons[index]);}
  else if(event.key==='ArrowLeft')handled=focus(target.closest('.mail-account-folders')?.parentElement?.querySelector('.mail-account-row'));
  else if(event.key==='ArrowRight'&&target.closest('.mail-account-row')){target.closest<HTMLButtonElement>('.mail-account-row')?.click();requestAnimationFrame(()=>focus(target.closest('.mail-account-row')?.parentElement?.querySelector('.mail-account-folders button')));handled=true;}
  else if(!event.shiftKey&&event.key.length===1&&/[\p{L}\p{N}]/u.test(event.key)){const now=Date.now();memory.prefix=now-memory.time<800?memory.prefix+key:key;memory.time=now;const prefix=memory.prefix;let match=buttons.slice(at+1).concat(buttons.slice(0,at+1)).find(button=>button.textContent?.trim().toLocaleLowerCase().startsWith(prefix));if(!match&&[...prefix].every(char=>char===key)){memory.prefix=key;match=buttons.slice(at+1).concat(buttons.slice(0,at+1)).find(button=>button.textContent?.trim().toLocaleLowerCase().startsWith(key));}handled=focus(match);}
 }
 else if((mod&&!event.altKey&&event.shiftKey&&key==='m')||(plain&&!event.shiftKey&&(key==='n'||key==='c')))handled=click('[aria-label="Compose"]');
 else if(!event.altKey&&((mod&&key==='r')||(plain&&key==='r')))handled=click(event.shiftKey?'[aria-label="Reply all"]':'[aria-label="Reply"]');
 else if((!mac&&mod&&!event.altKey&&!event.shiftKey&&key==='f')||(plain&&event.shiftKey&&key==='f'))handled=click('[aria-label="Forward"]');
 else if((plain&&!event.shiftKey&&(key==='q'||key==='u'))||(event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&(key==='q'||key==='u')))handled=click(key==='q'?'[aria-label="Mark read"]':'[aria-label="Mark unread"]');
 else if((plain&&!event.shiftKey&&event.key==='Insert')||(plain&&event.shiftKey&&key==='l'))handled=click('[aria-label="Flag"],[aria-label="Unflag"]');
 else if((plain&&!event.shiftKey&&key==='e')||(mac&&event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&key==='e'))handled=click('[aria-label="Archive"]');
 else if(plain&&!event.shiftKey&&(event.key==='Delete'||mac&&event.key==='Backspace'))handled=click('[aria-label="Move to Trash"]');
 else if(list&&mod&&!event.altKey&&!event.shiftKey&&key==='a'){for(const input of root.querySelectorAll<HTMLInputElement>('.mail-message-select-row input[type="checkbox"]'))if(!input.checked&&!input.disabled)input.click();handled=true;memory.anchor=null;}
 else if(list&&plain&&!event.shiftKey&&event.key===' '){const checkbox=target.closest('.mail-message-select-row')?.querySelector('input');if(checkbox instanceof HTMLInputElement&&!checkbox.disabled){checkbox.click();handled=true;memory.anchor=null;}}
 else if(list&&plain&&!event.shiftKey&&event.key==='Enter'){target.closest<HTMLButtonElement>('.mail-message-row,.mail-search-subject')?.click();requestAnimationFrame(()=>{if(root.isConnected)focusReader();});handled=true;}
 else if((list&&plain&&['ArrowDown','ArrowUp','Home','End'].includes(event.key))||(!event.altKey&&!event.shiftKey&&((!mac&&mod&&[',','.'].includes(key))||(mac&&event.ctrlKey&&!event.metaKey&&['[',']'].includes(key))))){
  const buttons=rows(),current=target.closest<HTMLButtonElement>('.mail-message-row,.mail-search-subject')??buttons.find(row=>row.getAttribute('aria-pressed')==='true'),at=Math.max(0,buttons.indexOf(current??buttons[0])),forward=['ArrowDown','.',']'].includes(event.key),next=event.key==='Home'?0:event.key==='End'?buttons.length-1:Math.max(0,Math.min(buttons.length-1,at+(forward?1:-1))),button=buttons[next];
  if(button){if(event.shiftKey){if(!memory.anchor||!buttons.includes(memory.anchor))memory.anchor=current??buttons[0];const anchor=buttons.indexOf(memory.anchor);for(const [index,row] of buttons.entries()){const checkbox=row.closest('.mail-message-select-row')?.querySelector('input');const wanted=index>=Math.min(anchor,next)&&index<=Math.max(anchor,next);if(checkbox instanceof HTMLInputElement&&!checkbox.disabled&&checkbox.checked!==wanted)checkbox.click();}}else memory.anchor=null;button.click();handled=focus(button);}
 }
 else if(plain&&!event.shiftKey&&event.key==='Escape'){const checked=[...root.querySelectorAll<HTMLInputElement>('.mail-message-select-row input:checked')];if(checked.length){for(const input of checked)input.click();handled=true;memory.anchor=null;}else handled=focusList();}
 if(handled){event.preventDefault();event.stopPropagation();}
}
