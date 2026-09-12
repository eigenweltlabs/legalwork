import {z} from 'zod';
import {providerMessageLocatorSchema} from './model.js';
import {mailSearchInputSchema,mailSearchResultSchema} from './search-view.js';
const id=z.string().min(1).max(4096),uuid=z.string().uuid(),hash=z.string().regex(/^[a-f0-9]{64}$/),size=z.number().int().nonnegative();
export const filingPartSchema=z.object({kind:z.enum(['original','attachment']),filename:z.string().min(1).max(512),mime_type:z.string().min(1).max(255),size:size.max(64*1024*1024),sha256:hash,content_id:z.string().max(1024).nullable().default(null)}).strict();
export const filingManifestSchema=z.object({version:z.literal(1),source_account:id,provider:z.enum(['gmail','graph','imap','archive']),locator:providerMessageLocatorSchema,headers:z.record(z.string(),z.array(z.string())),received_at:z.string().nullable(),captured_at:z.string(),parts:z.array(filingPartSchema).min(1).max(101)}).strict();
export const filingReceiptSchema=z.object({id:uuid,state:z.literal('committed'),matter_id:id,project_id:id,manifest_hash:hash,filed_at:z.string(),parts:z.array(z.object({ordinal:size,document_id:uuid,version_id:uuid,source_object_id:uuid,sha256:hash,size}).strict()).min(1).max(101),ingestion:z.literal('queued')}).strict();
export const filingItemSchema=z.object({id:uuid,snapshotId:uuid,accountId:id,workspaceId:id,backendKey:hash,principalKey:hash,matterId:id,state:z.enum(['queued','uploading','uncertain','filed','error','cancelled']),remoteId:uuid.nullable(),receipt:filingReceiptSchema.nullable(),error:z.string().nullable(),generation:z.string(),revision:size,quarantined:z.boolean()}).strict();
export const filingSnapshotSchema=z.object({id:uuid,accountId:id,messageKey:z.string(),manifest:filingManifestSchema,manifestHash:hash}).strict();
const scopeBindingSchema=z.object({workspaceId:id,backendKey:hash,generation:hash}).strict();
export const filingInputSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('capture'),accountId:id,locator:providerMessageLocatorSchema}).strict(),
 z.object({action:z.literal('snapshot'),accountId:id,snapshotId:uuid}).strict(),
 z.object({action:z.literal('chunk'),accountId:id,snapshotId:uuid,part:size.max(100),offset:size,limit:size.min(1).max(24576)}).strict(),
 z.object({action:z.literal('list'),accountIds:z.array(id).min(1).max(100),workspaceId:id,backendKey:hash,locator:providerMessageLocatorSchema.optional(),after:uuid.optional(),limit:size.min(1).max(100).default(50)}).strict(),
 z.object({action:z.literal('create'),accountId:id,snapshotId:uuid,workspaceId:id,backendKey:hash,principalKey:hash,matterId:id}).strict(),
 z.object({action:z.literal('update'),accountId:id,id:uuid,revision:size, generation:z.string(),state:z.enum(['uploading','uncertain','filed','error','cancelled']),remoteId:uuid.nullable(),receipt:filingReceiptSchema.nullable(),error:z.string().max(100).nullable()}).strict(),
 z.object({action:z.literal('scope-open'),binding:scopeBindingSchema,accountIds:z.array(id).min(1).max(100)}).strict(),
 z.object({action:z.literal('scope-add'),scopeId:uuid,filingIds:z.array(uuid).max(200)}).strict(),
 z.object({action:z.literal('scope-drop'),scopeId:uuid}).strict(),
 z.object({action:z.literal('search'),input:mailSearchInputSchema,scopeId:uuid,binding:scopeBindingSchema}).strict(),
]);
export const filingResultSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('capture'),snapshot:filingSnapshotSchema}).strict(),
 z.object({action:z.literal('snapshot'),snapshot:filingSnapshotSchema}).strict(),
 z.object({action:z.literal('chunk'),data:z.string().max(32768),nextOffset:size,done:z.boolean()}).strict(),
 z.object({action:z.literal('list'),items:z.array(filingItemSchema).max(100),nextCursor:uuid.nullable()}).strict(),
 z.object({action:z.literal('create'),item:filingItemSchema}).strict(),
 z.object({action:z.literal('update'),item:filingItemSchema}).strict(),
 z.object({action:z.literal('scope-open'),scopeId:uuid}).strict(),
 z.object({action:z.literal('scope-add')}).strict(),
 z.object({action:z.literal('scope-drop')}).strict(),
 z.object({action:z.literal('search'),search:mailSearchResultSchema}).strict(),
]);
export type FilingInput=z.infer<typeof filingInputSchema>;
export type FilingResult=z.infer<typeof filingResultSchema>;
export type FilingItem=z.infer<typeof filingItemSchema>;
export type FilingSnapshot=z.infer<typeof filingSnapshotSchema>;
export type FilingReceipt=z.infer<typeof filingReceiptSchema>;
/** Canonical JSON agrees with the backend's sorted UTF-8 manifest digest. */
export function canonicalFilingJson(value:unknown):string {
 if(value===null||typeof value==='string'||typeof value==='number'||typeof value==='boolean')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonicalFilingJson).join(',')+']';
 if(typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>JSON.stringify(key)+':'+canonicalFilingJson(item)).join(',')+'}';
 throw Error('Invalid filing manifest');
}
export function filingResultMatches(input:FilingInput,result:FilingResult):boolean{
 if(input.action!==result.action)return false;
 if((input.action==='capture'||input.action==='snapshot')&&(result.action==='capture'||result.action==='snapshot'))return result.snapshot.accountId===input.accountId&&(input.action!=='snapshot'||result.snapshot.id===input.snapshotId);
 if(input.action==='list'&&result.action==='list')return result.items.every(item=>input.accountIds.includes(item.accountId)&&item.workspaceId===input.workspaceId&&item.backendKey===input.backendKey);
 if(input.action==='create'&&result.action==='create')return result.item.accountId===input.accountId&&result.item.snapshotId===input.snapshotId&&result.item.workspaceId===input.workspaceId&&result.item.backendKey===input.backendKey&&result.item.principalKey===input.principalKey&&result.item.matterId===input.matterId;
 if(input.action==='update'&&result.action==='update')return result.item.accountId===input.accountId&&result.item.id===input.id&&result.item.revision===input.revision+1;
 if(input.action==='search'&&result.action==='search')return result.search.items.every(item=>input.input.accountIds?.includes(item.accountId));
 return true;
}
