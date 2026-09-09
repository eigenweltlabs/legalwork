import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GmailReadTransport } from './gmail.js';
const raw=(value)=>({id:'opaque-message',threadId:'opaque-thread',labelIds:['INBOX','TRASH'],historyId:'18446744073709551615',internalDate:'1700000000000',sizeEstimate:1,raw:Buffer.from(value).toString('base64url')});
test('Node pagination uses fixed endpoint and retains opaque continuation',async()=>{
 const token='https://example.invalid/+?a=b';let n=0;
 const client=new GmailReadTransport({accessToken:'synthetic-private-access',fetch:async(url,options)=>{
  const parsed=new URL(url);assert.equal(parsed.origin,'https://gmail.googleapis.com');assert.equal(parsed.searchParams.get('includeSpamTrash'),'true');assert.equal(options.redirect,'error');
  assert.equal(options.headers.Authorization,'Bearer synthetic-private-access');
  if(n++) {assert.equal(parsed.searchParams.get('pageToken'),token);return Response.json({messages:[{id:'b',threadId:'t'}]});}
  return Response.json({messages:[{id:'a',threadId:'t'}],nextPageToken:token});
 }});const first=await client.listMessages();const last=await client.listMessages({pageToken:first.nextPageToken});assert.equal(last.nextPageToken,null);
});
test('Node raw delivery is sequential and bounded, metadata follows successful sink',async()=>{
 const mime=Buffer.alloc(160000,97);const chunks=[];let active=0;
 const client=new GmailReadTransport({accessToken:'synthetic-private-access',fetch:async()=>Response.json(raw(mime))});
 const result=await client.consumeRaw('opaque-message',async(chunk)=>{assert.equal(active++,0);assert.ok(chunk.length<=49152);await new Promise(r=>setTimeout(r,1));chunks.push(chunk);active--;});
 assert.deepEqual(Buffer.concat(chunks),mime);assert.equal(result.rawBytes,mime.length);assert.equal(result.historyId,'18446744073709551615');
});
test('Node cancellation fences late sink calls and timeouts reject hanging sinks',async()=>{
 const controller=new AbortController();let calls=0;
 const client=new GmailReadTransport({accessToken:'synthetic-private-access',timeoutMs:10,fetch:async()=>Response.json(raw(Buffer.alloc(100000)))});
 await assert.rejects(client.consumeRaw('opaque-message',async()=>{calls++;controller.abort();},{signal:controller.signal}),/cancelled/);assert.equal(calls,1);
 await assert.rejects(client.consumeRaw('opaque-message',async()=>new Promise(()=>{})),/timeout/);
});
