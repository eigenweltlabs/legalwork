import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {createMailImages,fetchMailImage,imageUrl,publicMailAddress,messageImageUrls,rasterDimensions} from './mail-images.mjs';
const png=await readFile(new URL('../../server/src/mail/testing/html-fixtures/brand.png',import.meta.url));
test('mail image addresses reject private, mapped, local, documentation, credential and unusual-port targets',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.1.1','172.31.255.1','192.168.1.1','198.19.1.1','::1','::ffff:8.8.8.8','fe80::1','fc00::1','2001:db8::1','2002:0808:0808::1','3fff::1'])assert.equal(publicMailAddress(ip),false,ip);
 for(const ip of ['8.8.8.8','2606:4700:4700::1111'])assert.equal(publicMailAddress(ip),true);
 for(const url of ['file:///etc/passwd','data:image/png;base64,aa','https://u:p@example.test/a','http://example.test:8080/a','javascript:alert(1)'])assert.equal(imageUrl(url),null);
});
test('HTML/CSS resources decode entities and CSS escapes without treating unrelated text as a resource',()=>{
 assert.deepEqual(messageImageUrls([{contentType:'text/html',text:'<p>https://text.example.test</p><img src="https://images.example.test/a?a=1&amp;b=2"><style>.a{background:url(https://images.example.test/bg)}</style><img src="cid:brand">'}]),['https://images.example.test/bg','https://images.example.test/a?a=1&b=2']);
 assert.deepEqual(messageImageUrls([{contentType:'text/html',presentation:false,text:'<img src="https://old.example.test/a">'}]),[]);
});
test('native image download pins checked DNS, blocks redirect-to-private and sends no ambient credentials',async()=>{
 let requests=0;const resolve=async host=>[{address:host==='images.example.test'?'8.8.8.8':'127.0.0.1',family:4}];
 const transport=()=>function(url,options,callback){requests++;assert.equal(options.headers.Cookie,undefined);assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers.Referer,undefined);assert.equal(options.agent,false);options.lookup(url.hostname,{},(_error,address)=>assert.equal(address,'8.8.8.8'));const request=new EventEmitter();request.setTimeout=()=>{};request.end=()=>{const response=Readable.from([]);response.statusCode=302;response.headers={location:'https://internal.example.test/secret'};callback(response);};return request;};
 await assert.rejects(fetchMailImage('https://images.example.test/a',new AbortController().signal,resolve,transport),/private/);assert.equal(requests,1);
 await assert.rejects(fetchMailImage('https://images.example.test/a',new AbortController().signal,async()=>[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],transport),/private/);assert.equal(requests,1);
});
test('encoded dimensions reject bombs before raster decode',()=>{assert.deepEqual(rasterDimensions(png),{width:72,height:40,type:'png'});const bomb=Buffer.from(png);bomb.writeUInt32BE(100000,16);assert.throws(()=>rasterDimensions(bomb),/dimensions/);assert.throws(()=>rasterDimensions(Buffer.from('<svg/>')),/dimensions/);});
test('native image grants read the current stored body, bound returned bytes, and reject caller URLs or a lock',async()=>{
 const body=Buffer.from(JSON.stringify({version:1,bodies:[{contentType:'text/html',text:'<img src="https://images.example.test/a">'}]})),hash=createHash('sha256').update(body).digest('hex');let locked=false,calls=0;
 const server=createServer(async(req,res)=>{assert.equal(req.headers['x-legalwork-host-token'],'synthetic');if(locked){res.writeHead(423);res.end();return;}let text='';for await(const data of req)text+=data;const input=JSON.parse(text),offset=input.request.offset,bytes=body.subarray(offset,offset+input.request.limit);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({accountId:'archive',offset,totalBytes:body.length,referenceId:'sha256:'+hash,sha256:hash,data:bytes.toString('base64'),nextOffset:offset+bytes.length===body.length?null:offset+bytes.length}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const api=createMailImages({connection:async()=>({running:true,baseUrl:'http://127.0.0.1:'+server.address().port,hostToken:'synthetic'}),decode:()=>({width:72,height:40}),download:async url=>{calls++;assert.equal(url,'https://images.example.test/a');return png;}}),input={accountId:'archive',locator:{provider:'archive',namespace:'synthetic',entryId:'one'},referenceId:'sha256:'+hash,partId:''};
 try{const result=await api.perform(input);assert.equal(result.failed,0);assert.equal(result.items.length,1);assert.deepEqual(Buffer.from(result.items[0].data.split(',')[1],'base64'),png);await assert.rejects(api.perform({...input,url:'https://arbitrary.example.test'}));assert.equal(calls,1);locked=true;await assert.rejects(api.perform(input));assert.equal(calls,1);}finally{api.cancel();await new Promise(resolve=>server.close(resolve));}
});
test('cancellation ends a stalled DNS lookup before any connection',async()=>{const abort=new AbortController();const result=fetchMailImage('https://images.example.test/a',abort.signal,()=>new Promise(()=>{}));abort.abort();await assert.rejects(result,/cancelled/);});
test('native transport reads bounded raster bytes and rejects oversized or encoded responses',async()=>{
 const resolve=async()=>[{address:'8.8.8.8',family:4}];
 const transport=(chunks,headers={})=>()=>function(_url,_options,callback){const request=new EventEmitter();request.setTimeout=()=>{};request.end=()=>{const response=Readable.from(chunks);response.statusCode=200;response.headers=headers;callback(response);};return request;};
 assert.deepEqual(await fetchMailImage('https://images.example.test/a',new AbortController().signal,resolve,transport([png])),png);
 await assert.rejects(fetchMailImage('https://images.example.test/a',new AbortController().signal,resolve,transport([Buffer.alloc(4*1024*1024),Buffer.alloc(1)])),/limit/);
 await assert.rejects(fetchMailImage('https://images.example.test/a',new AbortController().signal,resolve,transport([png],{'content-encoding':'gzip'})),/response/);
});
