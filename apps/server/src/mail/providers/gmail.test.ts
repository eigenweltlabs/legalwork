import {linkTestModules} from '../../../../../scripts/mail/link-test-modules.mjs';
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, copyFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { GmailReadTransport, GmailTransportError, type GmailTransportErrorCode, type GmailLabel } from "./gmail.js";
import type { OAuthFetch } from "./oauth.js";
const ACCESS="synthetic-private-access";
const raw=(value:Uint8Array|string)=>({id:"m",threadId:"t",labelIds:["INBOX","SPAM","TRASH"],historyId:"18446744073709551615",internalDate:"1700000000000",sizeEstimate:100,raw:Buffer.from(value).toString("base64url")});
const client=(fetch:OAuthFetch,options:{timeoutMs?:number;maxRawBytes?:number}={})=>new GmailReadTransport({accessToken:ACCESS,fetch,...options});
test("labels return bounded unique metadata without mutation calls",async()=>{
 const labels:GmailLabel[]=[{id:"INBOX",name:"Inbox",type:"system"},{id:"Label_1",name:"Matter / Ä",type:"user"}];
 const result=await client(async(url,options)=>{expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/labels");expect(options.method).toBe("GET");expect(options.redirect).toBe("error");expect(new Headers(options.headers).get("Authorization")).toBe(`Bearer ${ACCESS}`);return Response.json({labels});}).listLabels();expect(result.labels).toEqual(labels);
 for(const body of [{labels:null},{labels:[labels[0],labels[0]]},{labels:[{...labels[0],type:"unexpected"}]},{labels:[{...labels[0],name:"x".repeat(4097)}]}])await expect(client(async()=>Response.json(body)).listLabels()).rejects.toThrow("invalid_response");
});
test("message pagination includes spam/trash, encodes opaque token and does not infer completeness from estimates",async()=>{
 const next="https://not-followed.invalid/?q=a+b&x=1";let calls=0;
 const transport=client(async(url)=>{const parsed=new URL(url);expect(parsed.origin).toBe("https://gmail.googleapis.com");expect(parsed.searchParams.get("includeSpamTrash")).toBe("true");expect(parsed.searchParams.has("q")).toBe(false);
 if(calls++===0)return Response.json({messages:[{id:"a",threadId:"t"}],nextPageToken:next,resultSizeEstimate:999});expect(parsed.searchParams.get("pageToken")).toBe(next);return Response.json({});});
 const first=await transport.listMessages({pageSize:500});expect(first.nextPageToken).toBe(next);const last=await transport.listMessages({pageToken:next});expect(last).toEqual({messages:[],nextPageToken:null,resultSizeEstimate:null});expect(calls).toBe(2);
});
test("invalid page IDs, duplicate rows, continuation cycles and null arrays never silently skip",async()=>{
 for(const data of [{messages:null},{messages:[{id:"a"}]},{messages:[{id:"a",threadId:"t"},{id:"a",threadId:"t"}]},{nextPageToken:""},{nextPageToken:"same"},{nextLink:"https://evil.invalid"},{resultSizeEstimate:-1}])await expect(client(async()=>Response.json(data)).listMessages({pageToken:"same"})).rejects.toThrow("invalid_response");
 const c=client(async()=>{throw new Error("should not fetch");});for(const pageSize of [0,501,1.5])await expect(c.listMessages({pageSize})).rejects.toThrow("invalid_input");
 await expect(c.listMessages({pageToken:"x".repeat(4097)})).rejects.toThrow("invalid_input");await expect(c.consumeRaw("..",async()=>{})).rejects.toThrow("invalid_input");
});
test("raw MIME bytes are exact and await each bounded sink chunk",async()=>{
 const mime=Buffer.alloc(160000,255);const chunks:Uint8Array[]=[];let active=0;
 const result=await client(async(url)=>{expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/messages/m?format=raw");return Response.json(raw(mime));}).consumeRaw("m",async(chunk)=>{expect(active++).toBe(0);expect(chunk.length).toBeLessThanOrEqual(49152);await new Promise(r=>setTimeout(r,1));chunks.push(chunk);active--;});
 expect(Buffer.concat(chunks)).toEqual(mime);expect(result.rawBytes).toBe(160000);expect(result.labelIds).toEqual(["INBOX","SPAM","TRASH"]);expect(result.historyId).toBe("18446744073709551615");
});
test("canonical base64url padded/unpadded accepted; malformed bits/padding/identity rejected before sink",async()=>{
 for(const value of ["YQ","YQ==","YWI","YWI=","YWJj"]){let size=0;await client(async()=>Response.json({...raw("a"),raw:value})).consumeRaw("m",async(bytes)=>{size+=bytes.length;});expect(size).toBeGreaterThan(0);}
 for(const patch of [{raw:"YR"},{raw:"YWJ"},{raw:"YQ="},{raw:"YQ==="},{raw:"Y Q"},{raw:"Y+=="},{raw:"a"},{raw:""},{id:"other"},{labelIds:null},{historyId:123},{internalDate:"1.5"}]){let calls=0;await expect(client(async()=>Response.json({...raw("a"),...patch})).consumeRaw("m",async()=>{calls++;})).rejects.toThrow("invalid_response");expect(calls).toBe(0);}
});
test("raw decoded/envelope byte limits fail explicitly with zero sink writes",async()=>{
 let calls=0;await expect(client(async()=>Response.json(raw("abcd")),{maxRawBytes:3}).consumeRaw("m",async()=>{calls++;})).rejects.toThrow("raw_too_large");
 await expect(client(async()=>Response.json({...raw("a"),extra:"x".repeat(65536)}),{maxRawBytes:1}).consumeRaw("m",async()=>{calls++;})).rejects.toThrow("response_too_large");expect(calls).toBe(0);
});
test("typed access/reconsent/rate/quota errors never reflect Google descriptions or IDs",async()=>{
 const cases:[number,string,GmailTransportErrorCode][]=[[401,"authError","access_token_rejected"],[403,"insufficientPermissions","reconsent_required"],[403,"domainPolicy","forbidden"],[403,"dailyLimitExceeded","quota_exceeded"],[403,"userRateLimitExceeded","rate_limited"],[403,"rateLimitExceeded","rate_limited"],[429,"anything","rate_limited"],[500,"anything","transient"],[404,"anything","not_found"],[302,"anything","request_rejected"]];
 for(const [status,reason,expected] of cases){try{await client(async()=>Response.json({error:{errors:[{reason,message:ACCESS}],message:ACCESS}},{status,headers:{"Retry-After":"12"}})).listLabels();throw new Error("expected failure");}catch(error){if(!(error instanceof GmailTransportError))throw error;expect(error.code).toBe(expected);expect(error.retryAfterMs).toBe(12000);expect(error.message+JSON.stringify(error)).not.toContain(ACCESS);}}
});
test("bounded JSON and redacted transport failure; cancellation stops late network/sink delivery",async()=>{
 await expect(client(async()=>new Response("x".repeat(1024*1024+1),{headers:{"content-type":"application/json"}})).listMessages()).rejects.toThrow("response_too_large");
 await expect(client(async()=>{throw new Error(ACCESS);}).listLabels()).rejects.toThrow("mail_gmail_transient");
 await expect(client(async()=>new Promise(()=>{}),{timeoutMs:10}).listMessages()).rejects.toThrow("timeout");
 await expect(client(async()=>new Response(new ReadableStream({start(){}}),{headers:{"content-type":"application/json"}}),{timeoutMs:10}).listMessages()).rejects.toThrow("timeout");
 const controller=new AbortController();let calls=0;await expect(client(async()=>Response.json(raw(Buffer.alloc(100000)))).consumeRaw("m",async()=>{calls++;controller.abort();},{signal:controller.signal})).rejects.toThrow("cancelled");expect(calls).toBe(1);
 await expect(client(async()=>Response.json(raw("a")),{timeoutMs:10}).consumeRaw("m",async()=>new Promise(()=>{}))).rejects.toThrow("timeout");
 await expect(client(async()=>Response.json(raw("a"))).consumeRaw("m",async()=>{throw new Error(ACCESS);})).rejects.toThrow("consumer_failed");
});
test("compiled gmail module passes actual Node tests",async()=>{
 const node=Bun.which("node");if(!node)throw new Error("Node required");
 const server=fileURLToPath(new URL("../../../",import.meta.url));const directory=await mkdtemp(join(tmpdir(),"legalwork-gmail-node-"));
 try {
  await writeFile(join(directory,"package.json"),'{"type":"module"}');await linkTestModules(join(server,"node_modules"),join(directory,"node_modules"));
  execFileSync("pnpm",["exec","tsc","--outDir",directory,"--rootDir","src","--target","ES2022","--module","NodeNext","--moduleResolution","NodeNext","--strict","--skipLibCheck","--types","bun-types,node","src/mail/providers/gmail.ts"],{cwd:server,timeout:30000,stdio:"pipe"});
  const path=join(directory,"mail/providers/gmail.node-test.mjs");await copyFile(fileURLToPath(new URL("./gmail.node-test.mjs",import.meta.url)),path);
  const output=execFileSync(node,["--test",path],{encoding:"utf8",timeout:15000,stdio:"pipe"});expect(output).toContain("tests 3");expect(output).toContain("fail 0");
 }finally{await rm(directory,{recursive:true,force:true});}
},45000);

test("elapsed deadline prevents sinks even when synchronous response work delays timer",async()=>{
 let calls=0;await expect(client(async()=>{const until=Date.now()+20;while(Date.now()<until){}return Response.json(raw("a"));},{timeoutMs:10}).consumeRaw("m",async()=>{calls++;})).rejects.toThrow("timeout");expect(calls).toBe(0);
});
test("opaque IDs stay path data, invalid options and invalid UTF-8 reject safely",async()=>{
 const messageId="https://evil.invalid/a?b=c";
 const result=await client(async(url)=>{expect(new URL(url).origin).toBe("https://gmail.googleapis.com");expect(new URL(url).pathname).toEndWith(encodeURIComponent(messageId));return Response.json({...raw("a"),id:messageId});}).consumeRaw(messageId,async()=>{});expect(result.id).toBe(messageId);
 for(const maxRawBytes of [0,128*1024*1024+1,1.5])expect(()=>client(async()=>Response.json({}),{maxRawBytes})).toThrow("invalid_input");
 await expect(client(async()=>new Response(Uint8Array.from([123,34,120,34,58,34,255,34,125]),{headers:{"content-type":"application/json"}})).listLabels()).rejects.toThrow("invalid_response");
});

test("fixed recent window uses numeric Gmail after query and retains spam/trash",async()=>{
 const c=client(async url=>{const parsed=new URL(url);expect(parsed.searchParams.get("q")).toBe("after:1700000000");expect(parsed.searchParams.get("includeSpamTrash")).toBe("true");return Response.json({});});
 await c.listMessages({recentAfterSeconds:1700000000});
 for(const recentAfterSeconds of [-1,1.5,Number.MAX_SAFE_INTEGER+1])await expect(c.listMessages({recentAfterSeconds})).rejects.toThrow("invalid_input");
});

test("history preserves large sequence IDs, specific events and exact fixed endpoint pagination",async()=>{
 const start="90071992547409930001",current="90071992547409930009";
 const c=client(async url=>{const u=new URL(url);expect(u.pathname).toBe("/gmail/v1/users/me/history");expect(u.searchParams.get("startHistoryId")).toBe(start);expect(u.searchParams.get("pageToken")).toBe("opaque+token");return Response.json({historyId:current,nextPageToken:"next",history:[{id:current,messages:[{id:"m",threadId:"t"}],labelsAdded:[{message:{id:"m",threadId:"t"},labelIds:["UNREAD"]}]}]});});
 const result=await c.listHistory({startHistoryId:start,pageToken:"opaque+token"});expect(result.historyId).toBe(current);expect(result.records[0]?.changes).toEqual([{kind:"labelsAdded",messageId:"m",threadId:"t",labelIds:["UNREAD"]}]);
});
test("history rejects backwards IDs, malformed events and oversized event fanout without checkpointing",async()=>{
 for(const data of [{historyId:"9"},{historyId:"11",history:[{id:"10"}]},{historyId:"12",history:[{id:"12"},{id:"11"}]},{historyId:"11",history:[{id:"11",labelsAdded:[{message:{id:"m",threadId:"t"}}]}]},{historyId:"11",history:[{id:"11",messages:[{id:"m"}]}]},{historyId:"11",history:[{id:"11",messagesAdded:Array.from({length:1001},()=>({message:{id:"m",threadId:"t"}}))}]}])await expect(client(async()=>Response.json(data)).listHistory({startHistoryId:"10"})).rejects.toThrow("invalid_response");
 expect(await client(async()=>Response.json({historyId:"10"})).listHistory({startHistoryId:"10"})).toEqual({historyId:"10",nextPageToken:null,records:[]});
 await expect(client(async()=>new Response(null,{status:404})).listHistory({startHistoryId:"10"})).rejects.toThrow("not_found");
});
test("profile anchor and minimal snapshots remain bounded and validate requested identity",async()=>{
 expect(await client(async()=>Response.json({historyId:"90071992547409930000"})).getProfile()).toEqual({historyId:"90071992547409930000"});
 const c=client(async url=>{expect(new URL(url).searchParams.get("format")).toBe("minimal");return Response.json({id:"m",threadId:"t",historyId:"10"});});
 expect((await c.getMetadata("m")).labelIds).toEqual([]);
 await expect(client(async()=>Response.json({id:"other",threadId:"t",historyId:"10",labelIds:[]})).getMetadata("m")).rejects.toThrow("invalid_response");
});

test('history accepts untyped message references, deduplicates specific events and bounds reconciliation',async()=>{
 const c=client(async()=>Response.json({historyId:'20',history:[{id:'15',messages:[{id:'only',threadId:'t'},{id:'only',threadId:'t'}]},{id:'20',messages:[{id:'typed',threadId:'t'},{id:'extra',threadId:'t'}],labelsAdded:[{message:{id:'typed',threadId:'t'},labelIds:['UNREAD']}]}]}));
 const page=await c.listHistory({startHistoryId:'10'});
 expect(page.records[0]?.changes).toEqual([{kind:'changed',messageId:'only',threadId:'t',labelIds:[]}]);
 expect(page.records[1]?.changes.map(change=>[change.kind,change.messageId])).toEqual([['labelsAdded','typed'],['changed','extra']]);
 for(const messages of [null,[{id:'missing-thread'}],Array.from({length:1001},(_,i)=>({id:String(i),threadId:'t'}))])await expect(client(async()=>Response.json({historyId:'20',history:[{id:'20',messages}]})).listHistory({startHistoryId:'10'})).rejects.toThrow('invalid_response');
});
