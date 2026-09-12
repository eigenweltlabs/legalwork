/** This standalone predicate is embedded into the isolated sender document. No mutation/send keys. */
export function mailReaderKeyAllowed(event:Pick<KeyboardEvent,'key'|'ctrlKey'|'metaKey'|'altKey'|'shiftKey'>,mac:boolean){
 const key=event.key.toLowerCase(),plain=!event.ctrlKey&&!event.metaKey&&!event.altKey,mod=mac?event.metaKey&&!event.ctrlKey:event.ctrlKey&&!event.metaKey;
 return plain&&['?','/','Escape','F6'].includes(event.key)
  ||!event.altKey&&(mod||plain)&&key==='r'
  ||plain&&event.shiftKey&&key==='f'
  ||!mac&&mod&&!event.altKey&&!event.shiftKey&&['f','e',',','.'].includes(key)
  ||!mac&&plain&&!event.shiftKey&&event.key==='F3'
  ||mac&&event.metaKey&&event.altKey&&!event.ctrlKey&&!event.shiftKey&&key==='f'
  ||event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&(key==='y'||mac&&['[',']'].includes(key));
}
