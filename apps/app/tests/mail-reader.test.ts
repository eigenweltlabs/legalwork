import {test,expect} from 'bun:test';
import {MailClient,UnifiedMailPages,compareMail,mailOrigin,type MailMessageView,type MailPartView} from '../src/react-app/domains/mail/mail-client';
import {safeFilename,rasterType} from '../src/react-app/domains/mail/mail-html';
import {createHash} from 'node:crypto';
const make=(accountId:string,index:number):MailMessageView=>({accountId,key:String(index).padStart(3,'0'),locator:{provider:'gmail',messageId:String(index)},subject:'Synthetic',threadId:null,rfcMessageId:null,removed:false,memberships:['INBOX'],contentState:'complete',metadata:null,receivedAt:index===60?null:1000-Math.floor(index/2)});
test('literal loopback validation precedes token forwarding and rejects URL normalization tricks',()=>{
 for(const host of ['127.1','2130706433','0177.0.0.1','localhost','127.0.0.1.example','user@127.0.0.1','127.0.0.1/../','[::ffff:127.0.0.1]'])expect(()=>mailOrigin(`http://${host}:8787`)).toThrow();
 for(const value of ['http://127.0.0.1:8787/mail','http://127.0.0.1:8787?x','https://127.0.0.1:8787','http://127.0.0.1:99999'])expect(()=>mailOrigin(value)).toThrow();
 expect(mailOrigin('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');expect(mailOrigin('http://[::1]:8787')).toBe('http://[::1]:8787');
});
test('unified merge replenishes exhausted heads before choosing a page; tied and unknown dates never disappear',async()=>{
 const source={a:Array.from({length:61},(_,i)=>make('a',i)),b:Array.from({length:61},(_,i)=>make('b',i))};let calls=0;
 const client=new MailClient('http://127.0.0.1:8787','synthetic',async(url,init)=>{calls++;expect(init?.redirect).toBe('error');expect(init?.headers).toMatchObject({'X-LegalWork-Host-Token':'synthetic'});const accountId=String(url).includes('/accounts/a/')?'a':'b';const input=JSON.parse(String(init?.body));expect(input.order).toBe('received');expect(input.inboxOnly).toBe(true);const offset=Number(input.after??0);return Response.json({items:source[accountId].slice(offset,offset+7),nextCursor:offset+7<61?String(offset+7):null});});
 const pager=new UnifiedMailPages(client,[{id:'a',provider:'gmail',displayName:'A'},{id:'b',provider:'gmail',displayName:'B'}],undefined,undefined,true);const found:MailMessageView[]=[];while(pager.hasMore)found.push(...await pager.next(new AbortController().signal));expect(found).toEqual([...source.a,...source.b].sort(compareMail));expect(new Set(found.map(item=>item.accountId+item.key)).size).toBe(122);expect(calls).toBe(18);
});
test('never-opened stored content is fetched in bounded verified chunks and rejects swapped references',async()=>{
 const bytes=Buffer.alloc(65001,97),sha256=createHash('sha256').update(bytes).digest('hex');const part:MailPartView={key:'p',kind:'attachment',partId:'p',state:'stored',referenceId:'sha256:'+sha256,bytes:bytes.length,sha256,bytesAvailable:true,filename:'file.txt',contentType:'text/plain',contentId:null};let swapped=false,calls=0;
 const client=new MailClient('http://127.0.0.1:8787','synthetic',async(url,init)=>{calls++;const {request}=JSON.parse(String(init?.body));const end=Math.min(bytes.length,request.offset+request.limit);return Response.json({accountId:'a',referenceId:swapped?'sha256:other':part.referenceId,offset:request.offset,totalBytes:bytes.length,sha256,data:bytes.subarray(request.offset,end).toString('base64'),nextOffset:end===bytes.length?null:end});});
 expect(Buffer.from(await client.bytes(make('a',0),part,new AbortController().signal))).toEqual(bytes);expect(calls).toBe(3);swapped=true;await expect(client.bytes(make('a',0),part,new AbortController().signal)).rejects.toThrow('changed');
});
test('unsafe names and SVG disguised as raster are never accepted as inline images',()=>{expect(safeFilename('../evil.exe')).toBe('.._evil.exe');expect(safeFilename('CON.txt')).toBe('mail-CON.txt');expect(rasterType(new TextEncoder().encode('<svg onload="alert(1)"/>'))).toBeNull();});
