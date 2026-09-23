import {test,expect} from 'bun:test';
import {mailDraftAttachmentSchema,mailUploadSchema,mailDraftContentSchema,mailDraftPreview,mailDraftSaveSchema,mailDraftViewSchema,mailSubmissionSchema} from '../../server/src/mail/local-view';
import {outboxItemSchema} from '../../server/src/mail/outbox-view';
import {outboxPresentation} from '../src/react-app/domains/mail/mail-outbox-model';
import {copyComposeAttachments,prepareOutboxEdit} from '../src/react-app/domains/mail/mail-compose-client';
import {MailClient} from '../src/react-app/domains/mail/mail-client';
const content=mailDraftContentSchema.parse({from:'self@example.test',to:['client@example.test'],subject:'Review',text:'Full message '.repeat(60),attachments:[{locator:null,partId:'part',referenceId:'draft:sha256:'+'a'.repeat(64),filename:'redline.pdf',contentType:'application/pdf',disposition:'attachment',contentId:null}]});
const item=outboxItemSchema.parse({id:'send',accountId:'firm',draftId:'11111111-1111-4111-8111-111111111111',version:{generation:'22222222-2222-4222-8222-222222222222',revision:1},subject:content.subject,from:content.from,state:'queued',attempts:0,createdAt:1,updatedAt:1,error:null,result:null,cancellationGuaranteed:true});
test('cancel and immediately re-send unchanged draft advances the version and retains attachment references',async()=>{
 const requests:string[]=[];let stopped=false;let draft=mailDraftViewSchema.parse({id:item.draftId,version:item.version,subject:content.subject,updatedAt:1,deleted:false,content});
 const client=new MailClient('http://127.0.0.1:4321','synthetic',async(input,init)=>{const path=new URL(String(input)).pathname,body=typeof init?.body==='string'?JSON.parse(init.body):{};requests.push(path.split('/').at(-1)??'');
 if(path.endsWith('/outbox/action')){stopped=true;return Response.json({...item,state:'cancelled'});}
 if(path.endsWith('/drafts/read')){expect(stopped).toBe(true);return Response.json(draft);}
 if(path.endsWith('/drafts/save')){const saved=mailDraftSaveSchema.parse(body);expect(saved.expected).toEqual(draft.version);draft={...draft,version:{...draft.version,revision:draft.version.revision+1},content:saved.content};return Response.json(draft);}
 const submission=mailSubmissionSchema.parse(body);expect(submission.version.revision).toBe(2);return Response.json({...item,id:'fresh-send',version:submission.version});});
 const edit=await prepareOutboxEdit(client,item,new AbortController().signal);expect(edit.content).toEqual(content);expect(edit.version.revision).toBe(2);
 const queued=await client.request('/accounts/firm/outbox/queue',outboxItemSchema,new AbortController().signal,{draftId:edit.id,version:edit.version,replayKey:'fresh'});expect(queued.id).not.toBe(item.id);expect(requests).toEqual(['action','read','save','queue']);
});
test('raced dispatch prevents edit recovery and never reads or copies the draft',async()=>{let calls=0;const client=new MailClient('http://127.0.0.1:4321','synthetic',async()=>{calls++;return Response.json({...item,state:'uncertain',cancellationGuaranteed:false});});await expect(prepareOutboxEdit(client,item,new AbortController().signal)).rejects.toThrow('may already have started');expect(calls).toBe(1);});
test('uncertain, restored and preparation-unknown submissions never expose retry or edit',()=>{for(const value of [{...item,state:'uncertain',cancellationGuaranteed:false},{...item,state:'failed',restored:true},{...item,state:'failed',error:'preparation_unknown'}]){const presentation=outboxPresentation(outboxItemSchema.parse(value));expect(presentation.canEdit).toBe(false);expect(presentation.canRetry).toBe(false);}expect(outboxPresentation({...item,state:'failed'}).canRetry).toBe(true);expect(mailDraftPreview(content).attachmentCount).toBe(1);expect(mailDraftPreview(content).preview.length).toBe(160);});

test('changing accounts verifies attachment bytes and preserves inline content IDs under new blob custody',async()=>{
 const bytes=new TextEncoder().encode('Synthetic attachment contents'),sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),value=>value.toString(16).padStart(2,'0')).join('');
 const part={...content.attachments[0],referenceId:'draft:sha256:'+sha,filename:'signature.png',contentType:'image/png',disposition:'inline',contentId:'signature@legalwork'};
 const parts=mailDraftContentSchema.parse({...content,attachments:[part]}).attachments,paths:string[]=[];
 const client=new MailClient('http://127.0.0.1:4321','synthetic',async(input,init)=>{const path=new URL(String(input)).pathname,body=typeof init?.body==='string'?JSON.parse(init.body):{};paths.push(path);
 if(path.endsWith('/attachment')){const request=mailDraftAttachmentSchema.parse(body);expect(request.version).toEqual(item.version);return Response.json({draftId:item.draftId,version:item.version,ordinal:0,chunk:{accountId:'firm',locator:null,referenceId:part.referenceId,offset:0,totalBytes:bytes.length,sha256:sha,data:btoa(String.fromCharCode(...bytes)),nextOffset:null}});}
 const upload=mailUploadSchema.parse(body);expect(upload.sha256).toBe(sha);expect(atob(upload.data)).toBe('Synthetic attachment contents');return Response.json({uploadId:upload.uploadId,nextOffset:bytes.length,bytes:bytes.length,referenceId:part.referenceId});});
 const copied=await copyComposeAttachments(client,{account:'firm',id:item.draftId,version:item.version},'litigation',parts);
 expect(copied[0].contentId).toBe('signature@legalwork');expect(copied[0].disposition).toBe('inline');expect(copied[0].filename).toBe(part.filename);expect(copied[0].partId).not.toBe(part.partId);expect(parts[0].partId).toBe(part.partId);expect(paths).toEqual(['/mail/v1/accounts/firm/drafts/attachment','/mail/v1/accounts/litigation/drafts/upload']);
});
