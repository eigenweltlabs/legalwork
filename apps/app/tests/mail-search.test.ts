import {test,expect} from 'bun:test';
import {MailClient} from '../src/react-app/domains/mail/mail-client';
import {SearchRequests,runMailSearch,savedMailSearch} from '../src/react-app/domains/mail/mail-search-client';
test('search carries exact punctuation and structured scope only through authenticated local POST; late generations are cancelled',async()=>{
 const requests=new SearchRequests(),first=requests.start(),second=requests.start();expect(requests.generation).toBe(2);expect(first.aborted).toBe(true);expect(second.aborted).toBe(false);
 const query={literal:'Änderung AZ-12/34.5',phrase:'gerichtliche Prüfung',accountIds:['a'],sender:'a@example.test',recipient:'b@example.test',filename:'Änderung.pdf',unread:true,hasAttachment:true,folderId:'INBOX',beforeDate:'2026-09-10T00:00:00.000Z'};
 const client=new MailClient('http://127.0.0.1:8787','synthetic',async(_url,init)=>{expect(init?.method).toBe('POST');expect(init?.headers).toMatchObject({'X-LegalWork-Host-Token':'synthetic'});expect(JSON.parse(String(init?.body))).toEqual(query);return Response.json({items:[],total:0,pending:2,incomplete:1,nextOffset:null});});
 expect((await runMailSearch(client,query,second)).pending).toBe(2);requests.cancel();expect(requests.generation).toBe(3);expect(second.aborted).toBe(true);
});
test('saved queries reject pagination and invented matter associations before HTTP',async()=>{
 let calls=0;const client=new MailClient('http://127.0.0.1:8787','synthetic',async()=>{calls++;throw Error('unexpected');});
 expect(()=>savedMailSearch(client,{action:'save',id:crypto.randomUUID(),expectedRevision:null,name:'Saved',query:{offset:20}},new AbortController().signal)).toThrow();expect(calls).toBe(0);
});
