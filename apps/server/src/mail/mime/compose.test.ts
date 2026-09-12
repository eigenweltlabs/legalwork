import { test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { buildMailMime } from './compose.js';
import { mailDraftContentSchema } from '../local-view.js';
import { projectMime } from './project.js';
const draft=()=>mailDraftContentSchema.parse({from:'lawyer@example.test',to:['client@example.test'],cc:['colleague@example.test'],bcc:['private@example.test'],subject:'Prüfung 秘密 🧑‍⚖️',text:'Guten Tag\n秘密 🧑‍⚖️',html:'<p>Guten <b>Tag</b> 秘密</p><img src="cid:picture@test">',inReplyTo:'<parent@example.test>',references:['<root@example.test>','<parent@example.test>']});
test('shared MIME round trips Unicode, alternatives, inline images, files and attached message without leaking BCC',async()=>{
 const content=draft();content.attachments=[{locator:null,partId:'1',referenceId:'local1',filename:'Bild.png',contentType:'image/png',contentId:'picture@test',disposition:'inline'},{locator:null,partId:'2',referenceId:'local2',filename:'秘密-Vertrag.txt',contentType:'text/plain',contentId:null,disposition:'attachment'},{locator:null,partId:'3',referenceId:'local3',filename:'Original.eml',contentType:'message/rfc822',contentId:null,disposition:'attachment'}];
 const sources=[Buffer.from([137,80,78,71,255]),Buffer.from('秘密'),Buffer.from('From: sender@example.test\r\nBcc: secret-original@example.test\r\nSubject: Forwarded\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nPrüfung')];
 const result=await buildMailMime(content,{authorizedSenders:['lawyer@example.test'],attachment:async(_,index)=>sources[index],messageId:'<test@example.test>',date:new Date('2026-09-12T10:00:00Z')});
 const raw=Buffer.from(result.raw).toString();expect(raw).not.toMatch(/^bcc:/im);expect(raw).not.toContain('private@example.test');expect(raw).not.toContain('secret-original@example.test');expect(result.envelope.to).toEqual(['client@example.test','colleague@example.test','private@example.test']);expect(raw).toContain('In-Reply-To: <parent@example.test>');expect(raw).toContain('References: <root@example.test>\r\n <parent@example.test>');
 const received:Buffer[]=[];const parsed=await projectMime({source:[result.raw],originalSha256:createHash('sha256').update(result.raw).digest('hex'),onAttachment:async(_,source)=>{const chunks:Uint8Array[]=[];for await(const chunk of source)chunks.push(chunk);received.push(Buffer.concat(chunks));}});
 expect(parsed.metadata.subject).toBe(content.subject);expect(parsed.bodies).toHaveLength(2);expect(parsed.bodies[0].text).toContain('秘密');expect(parsed.attachments[1].filename).toBe('秘密-Vertrag.txt');expect(received[0]).toEqual(sources[0]);expect(received[1]).toEqual(sources[1]);expect(received[2].toString()).toContain('Prüfung');expect(parsed.attachments[0].contentId).toBe('picture@test');
});
test('MIME rejects unauthorized sender, header injection, missing recipients and oversized attachments',async()=>{
 const options={authorizedSenders:['lawyer@example.test'],attachment:async()=>new Uint8Array()};
 await expect(buildMailMime({...draft(),from:'other@example.test'},options)).rejects.toThrow('not authorized');
 await expect(buildMailMime({...draft(),subject:'hello\r\nBcc: leak@example.test'},options)).rejects.toThrow();
 await expect(buildMailMime({...draft(),editor:{to:'client@example.test, incomplete@',cc:'colleague@example.test',bcc:'private@example.test',from:'lawyer@example.test'}},options)).rejects.toThrow('every recipient');
 await expect(buildMailMime({...draft(),to:[],cc:[],bcc:[]},options)).rejects.toThrow('recipient');
 const content=draft();content.attachments=[{locator:null,partId:'1',referenceId:'x',filename:'large',contentType:'application/octet-stream',contentId:null,disposition:'attachment'}];await expect(buildMailMime(content,{...options,attachment:async()=>new Uint8Array(10*1024*1024+1)})).rejects.toThrow('limit');
});

test('SMTPUTF8 mailboxes and non-ASCII message IDs are rejected instead of truncated',async()=>{
 const options={authorizedSenders:['lawyer@example.test','büro@example.test'],attachment:async()=>new Uint8Array()};
 for(const content of [{...draft(),from:'büro@example.test'},{...draft(),to:['律师@example.test']},{...draft(),cc:['client@例子.test']},{...draft(),bcc:['büro@example.test']}])await expect(buildMailMime(content,options)).rejects.toThrow('SMTPUTF8 mailbox addresses are not supported');
 await expect(buildMailMime({...draft(),inReplyTo:'<秘密@example.test>'},options)).rejects.toThrow('ASCII');
 await expect(buildMailMime(draft(),{...options,messageId:'<büro@example.test>'})).rejects.toThrow('ASCII');
 const content=draft();content.attachments=[{locator:null,partId:'1',referenceId:'raw',filename:'Original.eml',contentType:'message/rfc822',contentId:null,disposition:'attachment'}];
 const original=Buffer.concat([Buffer.from('From: source@example.test\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: 8bit\r\n\r\n'),Buffer.from([0x80,0xe9,0xff])]);
 const result=await buildMailMime(content,{...options,attachment:async()=>original});expect(result.requiresSmtpUtf8).toBe(false);expect(result.requires8BitMime).toBe(true);expect(Buffer.from(result.raw).includes(original)).toBe(true);
});

test('private draft MIME permits missing recipients and safely projects incomplete input without weakening sending',async()=>{
 const {buildDraftMailMime}=await import('./compose');const options={authorizedSenders:['lawyer@example.test'],attachment:async()=>new Uint8Array()};const blank={...draft(),to:[],cc:[],bcc:[]};const empty=await buildDraftMailMime(blank,options);expect(Buffer.from(empty.raw).toString()).not.toMatch(/^To:/im);expect('envelope' in empty).toBe(false);await expect(buildMailMime(blank,options)).rejects.toThrow('recipient');const bcc=await buildDraftMailMime({...blank,bcc:['private@example.test']},options);expect(Buffer.from(bcc.raw).toString()).toMatch(/^Bcc: private@example.test/m);const incomplete={...blank,editor:{from:'lawyer@example.test',to:'unfinished@, good@example.test',cc:'bad@',bcc:'private@example.test'}};const projected=await buildDraftMailMime(incomplete,options),raw=Buffer.from(projected.raw).toString();expect(projected.recipientInputLocalOnly).toBe(true);expect(raw).toContain('To: good@example.test');expect(raw).not.toContain('unfinished@');expect(raw).not.toContain('bad@');expect(raw).toContain('Bcc: private@example.test');await expect(buildMailMime(incomplete,options)).rejects.toThrow('recipient');
});
