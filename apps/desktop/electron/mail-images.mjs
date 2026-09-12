import {rasterDimensions} from './mail-image-dimensions.mjs';
export {rasterDimensions} from './mail-image-dimensions.mjs';
import {createHash} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {BlockList,isIP} from 'node:net';
import {request as httpsRequest} from 'node:https';
import {request as httpRequest} from 'node:http';
import {parse} from 'parse5';
import {parse as parseCss,walk} from 'css-tree';
import {z} from 'zod';
const id=z.string().min(1).max(4096),locator=z.union([z.object({provider:z.literal('gmail'),messageId:id}).strict(),z.object({provider:z.literal('graph'),messageId:id}).strict(),z.object({provider:z.literal('imap'),mailboxId:id,uidValidity:z.number().int().positive(),uid:z.number().int().positive()}).strict(),z.object({provider:z.literal('archive'),namespace:id,entryId:id}).strict()]);
const inputSchema=z.object({accountId:id,locator,partId:z.string().max(4096),referenceId:z.string().regex(/^sha256:[0-9a-f]{64}$/)}).strict();
const blocked=new BlockList();
for(const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]])blocked.addSubnet(address,prefix,'ipv4');
for(const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]])blocked.addSubnet(address,prefix,'ipv6');
export function publicMailAddress(address){const family=isIP(address);return family===4?!blocked.check(address,'ipv4'):family===6&&/^[23][0-9a-f]{3}:/i.test(address)&&!blocked.check(address,'ipv6');}
export function imageUrl(value){try{if(typeof value!=='string'||value.length>4096)return null;const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&(!url.port||url.port==='443'||url.port==='80')?url:null;}catch{return null;}}
/** Only URLs recovered from the immutable stored MIME body are eligible. */
export function messageImageUrls(bodies){const urls=new Set();let nodes=0;
 const add=value=>{const url=imageUrl(value);if(url&&urls.size<100)urls.add(url.href);};
 const css=(value,inline)=>{if(value.length>128*1024)return;try{const ast=parseCss(value,{context:inline?'declarationList':'stylesheet'});walk(ast,function(node){if(node.type==='Atrule'&&node.name.toLowerCase()!=='media')return walk.skip;if(node.type==='Declaration'){if(['background','background-image'].includes(node.property.toLowerCase()))walk(node.value,child=>{if(child.type==='Url')add(child.value);});return walk.skip;}});}catch{}};
 for(const body of bodies){if(body.contentType!=='text/html'||body.presentation===false)continue;const root=parse(body.text);const queue=[root];while(queue.length){const node=queue.pop();if(++nodes>15000)throw Error('mail_image_limit');for(const attr of node.attrs??[]){if(node.tagName==='img'&&attr.name==='src'||attr.name==='background')add(attr.value);if(attr.name==='style')css(attr.value,true);}if(node.tagName==='style')css((node.childNodes??[]).map(child=>child.value??'').join(''),false);queue.push(...node.childNodes??[]);}}
 return [...urls];
}
export async function fetchMailImage(url,signal,resolve=lookup,requestFor=protocol=>protocol==='https:'?httpsRequest:httpRequest){
 let current=imageUrl(url);if(!current)throw Error('mail_image_url');
 for(let redirects=0;redirects<=4;redirects++){
  if(signal.aborted)throw Error('mail_image_cancelled');
  const hostname=current.hostname.replace(/^\[|\]$/g,''),addresses=await new Promise((done,fail)=>{const cancel=()=>fail(Error('mail_image_cancelled'));signal.addEventListener('abort',cancel,{once:true});if(signal.aborted){cancel();signal.removeEventListener('abort',cancel);return;}Promise.resolve(resolve(hostname,{all:true,verbatim:true})).then(done,fail).finally(()=>signal.removeEventListener('abort',cancel));});
  if(!addresses.length||addresses.some(value=>!publicMailAddress(value.address)))throw Error('mail_image_private');
  const pinned=addresses[0];
  const result=await new Promise((resolveResult,reject)=>{
   const request=requestFor(current.protocol)(current,{method:'GET',signal,agent:false,headers:{Accept:'image/png,image/jpeg,image/gif,image/webp','Accept-Encoding':'identity','User-Agent':'LegalWork-Mail-Images'},lookup:(_name,options,done)=>{if(options.all)done(null,[pinned]);else done(null,pinned.address,pinned.family);}},response=>{
    if([301,302,303,307,308].includes(response.statusCode)){response.destroy();resolveResult({redirect:response.headers.location});return;}
    if(response.statusCode!==200||response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'||Number(response.headers['content-length']??0)>4*1024*1024){response.destroy();reject(Error('mail_image_response'));return;}
    const chunks=[];let total=0;response.on('data',bytes=>{total+=bytes.length;if(total>4*1024*1024){response.destroy(Error('mail_image_limit'));return;}chunks.push(bytes);});response.on('error',reject);response.on('end',()=>resolveResult({bytes:Buffer.concat(chunks)}));
   });request.setTimeout(15000,()=>request.destroy(Error('mail_image_timeout')));request.on('error',reject);request.end();
  });
  if(result.bytes)return result.bytes;
  const next=result.redirect&&imageUrl(new URL(result.redirect,current).href);if(!next||current.protocol==='https:'&&next.protocol!=='https:')throw Error('mail_image_redirect');current=next;
 }
 throw Error('mail_image_redirect');
}
export function createMailImages({connection,decode,download=fetchMailImage}){
 let pending;
 async function perform(value){const input=inputSchema.parse(value);if(pending)throw Error('mail_image_busy');const abort=new AbortController();pending=abort;const timer=setTimeout(()=>abort.abort(),90000);
 try{
  const info=await connection();if(!info.running||!info.hostToken||!/^http:\/\/(127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}\/?$/.test(info.baseUrl))throw Error('mail_image_unavailable');
  const base=new URL(info.baseUrl).origin+'/mail/v1/accounts/'+encodeURIComponent(input.accountId)+'/messages/';
  const post=async(path,body)=>{const response=await fetch(base+path,{method:'POST',headers:{'X-LegalWork-Host-Token':info.hostToken,'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:abort.signal});if(!response.ok)throw Error('mail_image_unavailable');return response.json();};
  const request={kind:'body',partId:input.partId,referenceId:input.referenceId};let offset=0,total,buffer=[];
  do{const value=await post('content',{locator:input.locator,request:{...request,offset,limit:24576}});if(typeof value.data!=='string'||value.data.length>32768)throw Error('mail_image_invalid');const bytes=Buffer.from(value.data,'base64');if(value.accountId!==input.accountId||value.referenceId!==input.referenceId||value.sha256!==input.referenceId.slice(7)||!Number.isSafeInteger(value.totalBytes)||value.totalBytes>8*1024*1024||value.offset!==offset||value.data!==bytes.toString('base64')||!bytes.length||offset+bytes.length>value.totalBytes||total!==undefined&&total!==value.totalBytes||value.nextOffset!==(offset+bytes.length===value.totalBytes?null:offset+bytes.length))throw Error('mail_image_invalid');total=value.totalBytes;buffer.push(bytes);offset+=bytes.length;}while(offset<total);
  const bytes=Buffer.concat(buffer);buffer=[];if(createHash('sha256').update(bytes).digest('hex')!==input.referenceId.slice(7))throw Error('mail_image_integrity');
  const envelope=z.object({version:z.literal(1),bodies:z.array(z.object({contentType:z.enum(['text/plain','text/html']),text:z.string().max(2*1024*1024),presentation:z.boolean().optional()})).max(1000)}).parse(JSON.parse(bytes.toString('utf8')));
  const urls=messageImageUrls(envelope.bodies),items=[];let failed=Math.max(0,urls.length-30),size=0;
  let attempted=0;for(const url of urls.slice(0,30)){attempted++;try{
   await post('content',{locator:input.locator,request:{...request,offset:0,limit:1}});
   const bytes=await download(url,abort.signal);size+=bytes.length;if(size>8*1024*1024)throw Error('mail_image_limit');const expected=rasterDimensions(bytes),actual=decode(bytes);if(!(actual.width===expected.width&&actual.height===expected.height||actual.width===expected.height&&actual.height===expected.width))throw Error('mail_image_decode');
   items.push({url,data:`data:image/${expected.type};base64,${bytes.toString('base64')}`});
  }catch{failed++;}if(abort.signal.aborted||size>8*1024*1024){failed+=Math.min(30,urls.length)-attempted;break;}}
  await post('content',{locator:input.locator,request:{...request,offset:0,limit:1}});if(abort.signal.aborted)throw Error('mail_image_cancelled');return {items,failed:Math.max(0,failed)};
 }finally{clearTimeout(timer);if(pending===abort)pending=undefined;}}
 return {perform,cancel:()=>pending?.abort()};
}
