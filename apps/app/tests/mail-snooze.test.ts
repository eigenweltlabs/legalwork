import { test, expect } from 'bun:test';
import { MailClient, UnifiedMailPages, type MailMessageView } from '../src/react-app/domains/mail/mail-client';
import { readMailSnooze, setMailSnooze } from '../src/react-app/domains/mail/mail-snooze-client';

const item:MailMessageView={accountId:'a',key:'["gmail","one"]',locator:{provider:'gmail',messageId:'one'},subject:'Reminder',threadId:'thread',rfcMessageId:null,memberships:['INBOX'],removed:false,contentState:'complete',metadata:null,receivedAt:10};
const version={generation:'11111111-1111-4111-8111-111111111111',revision:1};
const time={at:Date.now()+60000,timeZone:'Europe/Berlin'};
const state={accountId:'a',locator:item.locator,version,time,scope:'conversation',count:2,available:true};

test('snooze uses the existing host client and sends only the pinned locator, reviewed version and time',async()=>{
 const calls:{path:string;body:unknown}[]=[];
 const client=new MailClient('http://127.0.0.1:8787','fixture',async(url,init)=>{
  expect(init?.headers).toMatchObject({'X-LegalWork-Host-Token':'fixture'});
  calls.push({path:String(url),body:JSON.parse(String(init?.body))});return Response.json(state);
 });
 const current=await readMailSnooze(client,item,new AbortController().signal);
 await setMailSnooze(client,item,current,time,new AbortController().signal);
 expect(calls).toEqual([{path:'http://127.0.0.1:8787/mail/v1/accounts/a/messages/snooze/read',body:{locator:item.locator}},{path:'http://127.0.0.1:8787/mail/v1/accounts/a/messages/snooze/set',body:{locator:item.locator,expected:version,time}}]);
 const changed=new MailClient('http://127.0.0.1:8787','fixture',async()=>Response.json({...state,accountId:'other'}));
 await expect(readMailSnooze(changed,item,new AbortController().signal)).rejects.toThrow('Snooze account changed.');
 const stale=new MailClient('http://127.0.0.1:8787','fixture',async()=>Response.json({code:'mail_snooze_conflict',message:'private-provider-marker'},{status:409}));
 try{await readMailSnooze(stale,item,new AbortController().signal);throw Error('Expected conflict');}
 catch(error){expect(error).toMatchObject({code:'conflict'});expect(String(error)).not.toContain('private-provider-marker');}
});

test('woken Inbox items merge across accounts by their local position while preserving original received dates',async()=>{
 const other:MailMessageView={...item,accountId:'b',receivedAt:200};
 const requests:unknown[]=[];
 const client=new MailClient('http://127.0.0.1:8787','fixture',async(url,init)=>{
  requests.push(JSON.parse(String(init?.body)));
  return Response.json({items:[String(url).includes('/accounts/a/')?{...item,sortAt:300}:other],nextCursor:null});
 });
 const pager=new UnifiedMailPages(client,[{id:'a',provider:'gmail',displayName:'A'},{id:'b',provider:'gmail',displayName:'B'}],undefined,undefined,true);
 const rows=await pager.next(new AbortController().signal);
 expect(rows.map(value=>value.accountId)).toEqual(['a','b']);expect(rows[0].receivedAt).toBe(10);expect(rows[0].sortAt).toBe(300);
 expect(requests.every(input=>typeof input==='object'&&input!==null&&Reflect.get(input,'inboxOnly')===true)).toBe(true);
});
