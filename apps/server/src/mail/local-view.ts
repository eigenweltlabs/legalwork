import {mailContentChunkSchema} from "./read-view.js";
import {z} from "zod";
import {providerMessageLocatorSchema} from "./model.js";
const id=z.string().min(1).max(4096),uuid=z.string().uuid(),integer=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const mailLocalVersionSchema=z.object({generation:uuid,revision:integer.min(1)}).strict();
export const mailAddressSchema=z.string().email().max(320);
const header=z.string().max(512).refine(value=>!/[\r\n]/.test(value));
const messageId=z.string().max(512).regex(/^<[^<>\s@]+@[^<>\s@]+>$/);
export const mailUploadSchema=z.object({uploadId:uuid,offset:integer.max(10*1024*1024),data:z.string().max(21848).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),complete:z.boolean(),cancel:z.boolean().default(false),totalBytes:integer.max(10*1024*1024),sha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
export const mailUploadViewSchema=z.object({uploadId:uuid,nextOffset:integer,referenceId:id.nullable(),bytes:integer}).strict();
export type MailUpload=z.input<typeof mailUploadSchema>;export type MailUploadView=z.infer<typeof mailUploadViewSchema>;
export const mailDraftContentSchema=z.object({subject:header,to:z.array(mailAddressSchema).max(50),cc:z.array(mailAddressSchema).max(50).default([]),bcc:z.array(mailAddressSchema).max(50).default([]),from:mailAddressSchema.nullable().default(null),text:z.string().max(24000),html:z.string().max(24000).nullable().default(null),
  editor:z.object({to:z.string().max(4096),cc:z.string().max(4096),bcc:z.string().max(4096),from:z.string().max(320)}).strict().optional(),inReplyTo:messageId.nullable().default(null),references:z.array(messageId).max(40).default([]),
  attachments:z.array(z.object({locator:providerMessageLocatorSchema.nullable(),bytes:integer.max(10*1024*1024).optional(),disposition:z.enum(["attachment","inline"]).default("attachment"),contentId:z.string().regex(/^[a-zA-Z0-9._@-]{1,200}$/).nullable().default(null),partId:id,referenceId:id,filename:header.min(1),contentType:z.string().min(1).max(256).refine(value=>!/[\r\n]/.test(value))}).strict()).max(20).default([]),
}).strict().refine(value=>new TextEncoder().encode(JSON.stringify(value)).byteLength<=24576);
export const mailDraftSaveSchema=z.object({draftId:uuid,expected:mailLocalVersionSchema.nullable(),content:mailDraftContentSchema}).strict();
export const mailDraftReadSchema=z.object({draftId:uuid,version:mailLocalVersionSchema.optional()}).strict();
export const mailDraftDeleteSchema=z.object({draftId:uuid,expected:mailLocalVersionSchema}).strict();
export const mailLocalPageSchema=z.object({after:id.optional(),limit:z.number().int().min(1).max(25).default(20)}).strict();
export const mailActionPageInputSchema=mailLocalPageSchema.extend({pendingOnly:z.boolean().default(false)});
export type MailActionPageInput=z.input<typeof mailActionPageInputSchema>;
export const mailDraftSummarySchema=z.object({id:uuid,version:mailLocalVersionSchema,updatedAt:integer,deleted:z.boolean(),subject:header}).strict();
export const mailDraftViewSchema=mailDraftSummarySchema.extend({content:mailDraftContentSchema}).strict();
export const mailDraftPageSchema=z.object({accountId:id,items:z.array(mailDraftSummarySchema).max(25),nextCursor:id.nullable()}).strict();
const replay=z.string().regex(/^[\x21-\x7e]{1,256}$/);
export const mailSubmissionSchema=z.object({replayKey:replay,draftId:uuid,version:mailLocalVersionSchema}).strict();
export const mailMutationSchema=z.object({replayKey:replay,locator:providerMessageLocatorSchema.optional(),precondition:z.string().min(1).max(4096),change:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('read'),read:z.boolean()}).strict(),
 z.object({kind:z.literal('special'),operation:z.enum(['archive','trash','spam','inbox'])}).strict(),
 z.object({kind:z.literal('flags'),add:z.array(z.string().max(128)).max(100),remove:z.array(z.string().max(128)).max(100)}).strict(),
 z.object({kind:z.literal('move'),destination:id}).strict(),
 z.object({kind:z.literal('copy'),destination:id}).strict(),
 z.object({kind:z.literal('delete')}).strict(),
 z.object({kind:z.literal('mailbox'),operation:z.enum(['create','rename','delete']),path:z.string().min(1).max(512),destination:z.string().min(1).max(512).optional()}).strict(),
  z.object({kind:z.literal('memberships'),add:z.array(id).max(100),remove:z.array(id).max(100)}).strict().refine(value=>!value.add.some(id=>value.remove.includes(id))),
])}).strict();
export const mailActionReadSchema=z.object({actionId:uuid}).strict();
export const mailActionCancelSchema=z.object({actionId:uuid,expected:mailLocalVersionSchema}).strict();
const actionState=z.enum(['queued','running','dispatching','retry','succeeded','failed','cancelled','uncertain']);
export const mailLocalActionSchema=z.object({id:uuid,kind:z.enum(['mutation','submission']),state:actionState,version:mailLocalVersionSchema,attempts:integer,maxAttempts:integer,availableAt:integer,cancelRequested:z.boolean(),lastError:z.enum(['preflight_retryable','preflight_permanent','lease_expired','outcome_unknown','rejected','conflict','cancelled','reconciled']).nullable(),conflictPolicy:z.enum(['manual','refresh_then_reapply']),mutation:mailMutationSchema.omit({replayKey:true}).nullable().optional(),executionSupported:z.boolean(),providerResult:z.enum(['confirmed','unknown','unsupported','conflict','rejected']).nullable().optional(),credentialCurrent:z.boolean()}).strict();
export const mailActionPageSchema=z.object({accountId:id,items:z.array(mailLocalActionSchema).max(25),nextCursor:id.nullable()}).strict();
const stream=z.string().regex(/^[0-9a-f]{32}$/);
export const mailEventQuerySchema=z.object({stream:stream.optional(),after:integer.default(0),cursorOnly:z.boolean().default(false),limit:z.number().int().min(1).max(25).default(20)}).strict().refine(value=>value.after===0||value.stream!==undefined);
const eventBase=z.object({sequence:integer.min(1)});
export const mailLocalEventSchema=z.discriminatedUnion('kind',[
 eventBase.extend({kind:z.literal('draft.saved'),entityId:uuid,state:z.literal('active'),version:mailLocalVersionSchema}).strict(),
 eventBase.extend({kind:z.literal('draft.deleted'),entityId:uuid,state:z.literal('deleted'),version:mailLocalVersionSchema}).strict(),
 eventBase.extend({kind:z.literal('action.changed'),entityId:uuid,state:actionState,version:mailLocalVersionSchema}).strict(),
 eventBase.extend({kind:z.literal('message.changed'),entityId:z.string().min(1).max(32768),state:z.null(),version:z.null()}).strict(),
]);
export const mailEventPageSchema=z.object({accountId:id,stream,resetRequired:z.boolean(),items:z.array(mailLocalEventSchema).max(25),nextCursor:integer,hasMore:z.boolean()}).strict();
export type MailDraftSave=z.input<typeof mailDraftSaveSchema>;export type MailDraftRead=z.input<typeof mailDraftReadSchema>;export type MailDraftDelete=z.input<typeof mailDraftDeleteSchema>;
export type MailLocalPage=z.input<typeof mailLocalPageSchema>;export type MailSubmission=z.input<typeof mailSubmissionSchema>;export type MailMutation=z.input<typeof mailMutationSchema>;export type MailActionCancel=z.input<typeof mailActionCancelSchema>;export type MailEventQuery=z.input<typeof mailEventQuerySchema>;
export type MailDraftView=z.infer<typeof mailDraftViewSchema>;export type MailDraftSummary=z.infer<typeof mailDraftSummarySchema>;export type MailDraftPage=z.infer<typeof mailDraftPageSchema>;export type MailLocalAction=z.infer<typeof mailLocalActionSchema>;export type MailActionPage=z.infer<typeof mailActionPageSchema>;export type MailEventPage=z.infer<typeof mailEventPageSchema>;

export const mailDraftAttachmentSchema=z.object({draftId:uuid,version:mailLocalVersionSchema,ordinal:z.number().int().min(0).max(19),referenceId:id,offset:integer.default(0),limit:z.number().int().min(1).max(24576).default(24576)}).strict();
export const mailDraftAttachmentViewSchema=z.object({draftId:uuid,version:mailLocalVersionSchema,ordinal:z.number().int().min(0).max(19),chunk:z.object({...mailContentChunkSchema.shape,locator:providerMessageLocatorSchema.nullable()}).strict().refine(v=>{const size=atob(v.data).length;return (v.referenceId===`sha256:${v.sha256}`||v.referenceId===`draft:sha256:${v.sha256}`)&&v.offset+size===(v.nextOffset??v.totalBytes)&&(v.nextOffset===null?v.offset<=v.totalBytes:size>0&&v.nextOffset<v.totalBytes);})}).strict();
export type MailDraftAttachment=z.input<typeof mailDraftAttachmentSchema>;export type MailDraftAttachmentView=z.infer<typeof mailDraftAttachmentViewSchema>;
// Separate literal declarations preserve discriminated command/result types at the worker boundary.
export const mailLocalCommandSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('mail.local.draft.upload'),accountId:id,input:mailUploadSchema}).strict(),
 z.object({operation:z.literal('mail.local.draft.save'),accountId:id,input:mailDraftSaveSchema}).strict(),
 z.object({operation:z.literal('mail.local.draft.read'),accountId:id,input:mailDraftReadSchema}).strict(),
 z.object({operation:z.literal('mail.local.draft.delete'),accountId:id,input:mailDraftDeleteSchema}).strict(),
 z.object({operation:z.literal('mail.local.draft.attachment'),accountId:id,input:mailDraftAttachmentSchema}).strict(),
 z.object({operation:z.literal('mail.local.draft.list'),accountId:id,input:mailLocalPageSchema}).strict(),
 z.object({operation:z.literal('mail.local.action.submission'),accountId:id,input:mailSubmissionSchema}).strict(),
 z.object({operation:z.literal('mail.local.action.mutation'),accountId:id,input:mailMutationSchema}).strict(),
 z.object({operation:z.literal('mail.local.action.read'),accountId:id,input:mailActionReadSchema}).strict(),
 z.object({operation:z.literal('mail.local.action.list'),accountId:id,input:mailActionPageInputSchema}).strict(),
 z.object({operation:z.literal('mail.local.action.cancel'),accountId:id,input:mailActionCancelSchema}).strict(),
 z.object({operation:z.literal('mail.local.events'),accountId:id,input:mailEventQuerySchema}).strict(),
]);
export const mailLocalResultSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('mail.local.draft.upload'),accountId:id,value:mailUploadViewSchema}).strict(),
 z.object({operation:z.literal('mail.local.draft.save'),accountId:id,value:mailDraftViewSchema}).strict(),
 z.object({operation:z.literal('mail.local.draft.read'),accountId:id,value:mailDraftViewSchema}).strict(),
 z.object({operation:z.literal('mail.local.draft.delete'),accountId:id,value:mailDraftSummarySchema}).strict(),
 z.object({operation:z.literal('mail.local.draft.attachment'),accountId:id,value:mailDraftAttachmentViewSchema}).strict(),
 z.object({operation:z.literal('mail.local.draft.list'),accountId:id,value:mailDraftPageSchema}).strict(),
 z.object({operation:z.literal('mail.local.action.submission'),accountId:id,value:mailLocalActionSchema}).strict(),
 z.object({operation:z.literal('mail.local.action.mutation'),accountId:id,value:mailLocalActionSchema}).strict(),
 z.object({operation:z.literal('mail.local.action.read'),accountId:id,value:mailLocalActionSchema}).strict(),
 z.object({operation:z.literal('mail.local.action.list'),accountId:id,value:mailActionPageSchema}).strict(),
 z.object({operation:z.literal('mail.local.action.cancel'),accountId:id,value:mailLocalActionSchema}).strict(),
 z.object({operation:z.literal('mail.local.events'),accountId:id,value:mailEventPageSchema}).strict(),
]);
export type MailLocalCommand=z.input<typeof mailLocalCommandSchema>;export type MailLocalResult=z.infer<typeof mailLocalResultSchema>;
export function localResultMatches(command:MailLocalCommand,result:MailLocalResult):boolean{
 if(command.operation!==result.operation||command.accountId!==result.accountId)return false;
 if('accountId' in result.value&&result.value.accountId!==command.accountId)return false;
 if((command.operation==='mail.local.draft.save'||command.operation==='mail.local.draft.read'||command.operation==='mail.local.draft.delete')&&'id' in result.value&&command.input.draftId!==result.value.id)return false;
 if(command.operation==='mail.local.draft.read'&&result.operation==='mail.local.draft.read'&&command.input.version&&(command.input.version.generation!==result.value.version.generation||command.input.version.revision!==result.value.version.revision))return false;
 if(command.operation==='mail.local.draft.upload'&&result.operation==='mail.local.draft.upload'){const input=command.input,value=result.value,bytes=input.cancel?0:input.offset+Buffer.from(input.data,'base64').length;return input.uploadId===value.uploadId&&value.bytes===bytes&&value.nextOffset===bytes&&value.referenceId===(input.complete&&!input.cancel?'draft:sha256:'+input.sha256:null);}
 if('actionId' in command.input&&'id' in result.value&&command.input.actionId!==result.value.id)return false;
 if(command.operation==='mail.local.draft.attachment'&&result.operation==='mail.local.draft.attachment'){
  const request=command.input,value=result.value;return value.draftId===request.draftId&&value.version.generation===request.version.generation&&value.version.revision===request.version.revision&&value.ordinal===request.ordinal&&value.chunk.accountId===command.accountId&&value.chunk.referenceId===request.referenceId&&value.chunk.offset===(request.offset??0)&&Buffer.from(value.chunk.data,'base64').byteLength<=(request.limit??24576);
 }
 return true;
}
