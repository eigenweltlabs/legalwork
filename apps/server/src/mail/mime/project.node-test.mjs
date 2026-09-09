import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {projectMime,MimeProjectionError} from './project.js';
import {fixture} from '../testing/corpus.js';
const hash=source=>{const h=createHash('sha256');for(const chunk of source)h.update(chunk);return h.digest('hex');};
const text=lines=>Buffer.from(lines.join('\r\n')+'\r\n');
const discard=async(_part,source)=>{for await(const chunk of source){assert.ok(chunk.byteLength<=65536);}};
const parse=(raw,extra={})=>projectMime({source:[raw],originalSha256:hash([raw]),onAttachment:discard,...extra});
const reject=code=>({message:`mail_mime_${code}`});
function multipart(body,tail='--x--\r\n'){return text(['MIME-Version: 1.0','Content-Type: multipart/mixed; boundary=x','','--x','Content-Type: application/octet-stream','Content-Transfer-Encoding: base64','',body])+tail;}

test('German headers, quoted printable and charset decoding remain bounded deterministic metadata',async()=>{
 const f=fixture(6),result=await projectMime({source:f.chunks(),originalSha256:hash(f.chunks()),onAttachment:discard});
 assert.equal(result.metadata.subject,'Prüfung der Verträge');assert.equal(result.metadata.from,'Jürgen Müller <sender@example.invalid>');assert.match(result.bodies[0].text,/Prüfung/);
 const latin=text(['Subject: =?ISO-8859-1?Q?Pr=FCfung?=','Date: clearly-not-a-date','Content-Type: text/plain; charset=iso-8859-1','Content-Transfer-Encoding: quoted-printable','','Pr=FCfung=20der=20Vertr=E4ge']);
 const decoded=await parse(latin);assert.equal(decoded.metadata.subject,'Prüfung');assert.equal(decoded.metadata.date,null);assert.match(decoded.bodies[0].text,/Prüfung der Verträge/);
 const empty=await parse(text(['Content-Type: text/plain','','']));assert.equal(empty.bodies.length,1);assert.equal(empty.bodies[0].text,'\r\n');
});
test('inline CID, HTML, attached text and message/rfc822 are preserved without expansion',async()=>{
 const f=fixture(7),attachments=[];
 const result=await projectMime({source:f.chunks(),originalSha256:hash(f.chunks()),onAttachment:async(part,chunks)=>{const parts=[];for await(const bytes of chunks)parts.push(bytes);attachments.push({part,bytes:Buffer.concat(parts)});}});
 assert.equal(result.bodies.length,2);assert.match(result.bodies[1].text,/cid:pixel@example.invalid/);assert.ok(!result.bodies[1].text.includes('data:image'));
 assert.deepEqual(result.attachments.map(a=>a.contentType),['image/png','message/rfc822','text/plain']);assert.equal(result.attachments[0].disposition,'inline');assert.equal(result.attachments[0].contentId,'pixel@example.invalid');
 assert.equal(result.attachments[2].filename,'Prüfung.txt');assert.match(attachments[1].bytes.toString(),/Subject: Embedded synthetic message/);assert.equal(attachments[2].bytes.toString(),'Prüfung\r\n');
 for(let i=0;i<attachments.length;i++){assert.equal(result.attachments[i].bytes,attachments[i].bytes.length);assert.equal(result.attachments[i].sha256,hash([attachments[i].bytes]));}
});
test('part IDs and output are independent of original chunk boundaries',async()=>{
 const f=fixture(7),raw=Buffer.concat([...f.chunks()]);const first=await parse(raw);
 async function* tiny(){for(let i=0;i<raw.length;i+=7)yield raw.subarray(i,i+7);}
 const second=await parse(raw,{source:tiny()});assert.deepEqual(second,first);assert.ok(first.attachments.every(a=>a.partId.startsWith(`mime-v1:${hash([raw])}:part:`)));
});
test('8MiB generated attachment streams to awaited sink without full-content materialization',async()=>{
 const f=fixture(9),digest=createHash('sha256');let received=0,calls=0,max=0;
 const result=await projectMime({source:f.chunks(),originalSha256:hash(f.chunks()),onAttachment:async(_meta,chunks)=>{for await(const bytes of chunks){received+=bytes.byteLength;max=Math.max(max,bytes.byteLength);digest.update(bytes);if(calls++%50===0)await new Promise(r=>setImmediate(r));}}});
 assert.equal(received,8*1024*1024);assert.ok(max<=65536);assert.ok(calls>128);assert.equal(result.attachments[0].bytes,received);assert.equal(result.attachments[0].sha256,digest.digest('hex'));
});
test('malformed base64 and unclosed boundaries fail visibly instead of completing',async()=>{
 const f=fixture(8);await assert.rejects(projectMime({source:f.chunks(),originalSha256:hash(f.chunks()),onAttachment:discard}),reject('malformed'));
 for(const body of ['!!!!','YQ=','Y===','YQ==AAAA'])await assert.rejects(parse(Buffer.from(multipart(body))),reject('malformed'));
 await assert.rejects(parse(Buffer.from(multipart('YQ==',''))),reject('malformed'));
 await assert.rejects(parse(text(['Content-Type: text/plain','Content-Transfer-Encoding: quoted-printable','','hello=ZQ'])),reject('malformed'));
});
test('input, headers, body, attachment bytes and counts reject at bounded limits',async()=>{
 const f=fixture(7),raw=Buffer.concat([...f.chunks()]);
 for(const limits of [{maxInputBytes:10},{maxHeaderBytes:20},{maxBodyBytes:5},{maxAttachmentBytes:2},{maxTotalAttachmentBytes:69},{maxParts:2},{maxAttachments:1},{maxDepth:1}])await assert.rejects(parse(raw,{limits}),reject('limit'));
 await assert.rejects(parse(Buffer.alloc(65537)),reject('invalid_input'));
 await assert.rejects(parse(raw,{limits:{timeoutMs:0}}),reject('invalid_input'));
});
test('unsupported encoding/charset/flowed and duplicate structure headers remain incomplete',async()=>{
 for(const raw of [text(['Content-Type: text/plain; charset=no-such-charset','','hello']),text(['Content-Type: text/plain; format=flowed','','hello']),text(['Content-Transfer-Encoding: x-custom','','hello'])])await assert.rejects(parse(raw),reject('unsupported'));
 await assert.rejects(parse(text(['Content-Type: text/plain','Content-Type: text/html','','hello'])),reject('malformed'));
});
test('sink must consume fully; sink/source exceptions remain fixed and original stays unchanged',async()=>{
 const f=fixture(7),raw=Buffer.concat([...f.chunks()]),original=Buffer.from(raw);
 await assert.rejects(parse(raw,{onAttachment:async()=>{}}),reject('sink_failed'));
 await assert.rejects(parse(raw,{onAttachment:async()=>{throw Error('synthetic-private-error');}}),reject('sink_failed'));
 async function* source(){yield raw.subarray(0,100);throw Error('synthetic-source-private');}
 await assert.rejects(parse(raw,{source:source()}),reject('source_failed'));assert.deepEqual(raw,original);
 await assert.rejects(parse(raw,{originalSha256:'a'.repeat(64)}),reject('hash_mismatch'));
});
test('deadline and cancellation bound ignored source/sink waits and fence later writes',async()=>{
 const raw=text(['Content-Type: text/plain','','hello']);
 async function* hanging(){await new Promise(()=>{});yield raw;}
 await assert.rejects(parse(raw,{source:hanging(),limits:{timeoutMs:10}}),reject('timeout'));
 const f=fixture(7),mime=Buffer.concat([...f.chunks()]);let sinkSignal;
 await assert.rejects(parse(mime,{limits:{timeoutMs:10},onAttachment:async(_meta,_chunks,signal)=>{sinkSignal=signal;await new Promise(()=>{});}}),reject('timeout'));assert.equal(sinkSignal.aborted,true);
 const controller=new AbortController();controller.abort();let calls=0;
 await assert.rejects(parse(mime,{signal:controller.signal,onAttachment:async()=>{calls++;}}),reject('cancelled'));assert.equal(calls,0);
 const active=new AbortController();await assert.rejects(parse(mime,{signal:active.signal,onAttachment:async(_meta,chunks)=>{active.abort();for await(const bytes of chunks){throw Error('must not emit after abort');}}}),reject('cancelled'));
});
