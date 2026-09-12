import {z} from 'zod';
const id=z.string().min(1).max(4096),uuid=z.string().uuid(),size=z.number().int().nonnegative(),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const storageRootViewSchema=z.object({id,name:z.string(),kind:z.string(),writable:z.boolean(),revision:z.string().optional()});
export const storageRootsViewSchema=z.object({roots:z.array(storageRootViewSchema),teamError:z.string().optional()});
export const storageFolderViewSchema=z.object({entries:z.array(z.object({path:z.string(),name:z.string(),kind:z.enum(['file','folder']),size:z.number().nullable(),modifiedAt:z.string().nullable()})),nextCursor:z.string().optional()});
export const storageSavePartSchema=z.object({ordinal:size,partIndex:z.number().int().min(-1),path:z.string().max(240),bytes:size,sha256:hash,mimeType:z.string(),state:z.enum(['queued','uploading','uncertain','saved']),version:z.string().nullable()});
export const storageSaveSchema=z.object({id:uuid,snapshotId:uuid,accountId:id,workspaceId:id,storageId:id,rootRevision:z.string(),folderPath:z.string(),selection:z.array(size).min(1).max(101),state:z.enum(['queued','uploading','uncertain','complete','cancelled']),generation:z.string(),currentGeneration:z.string(),revision:size,error:z.string().nullable(),quarantined:z.boolean(),parts:z.array(storageSavePartSchema).max(102)});
export const storageSaveInputSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('create'),accountId:id,snapshotId:uuid,workspaceId:id,storageId:id,rootRevision:z.string().min(1).max(4096),folderPath:z.string().max(2048),selection:z.array(size.max(100)).min(1).max(101)}).strict(),
 z.object({action:z.literal('read'),accountId:id,id:uuid}).strict(),
 z.object({action:z.literal('list'),accountIds:z.array(id).min(1).max(100),workspaceId:id,after:uuid.optional()}).strict(),
 z.object({action:z.literal('part'),accountId:id,id:uuid,revision:size,generation:z.string(),ordinal:size.max(101),state:z.enum(['uploading','uncertain','saved']),version:z.string().min(1).max(1000).nullable(),error:z.string().max(100).nullable()}).strict(),
]);
export const storageSaveResultSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('create'),save:storageSaveSchema}),
 z.object({action:z.literal('read'),save:storageSaveSchema}),
 z.object({action:z.literal('part'),save:storageSaveSchema}),
 z.object({action:z.literal('list'),items:z.array(storageSaveSchema).max(50),nextCursor:uuid.nullable()}),
]);
export type StorageSave=z.infer<typeof storageSaveSchema>;
export type StorageSaveInput=z.infer<typeof storageSaveInputSchema>;
export type StorageSaveResult=z.infer<typeof storageSaveResultSchema>;
export function storageSaveFolder(path:string){if(path&&(/[\\\x00-\x1f\x7f]/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..')))throw Error('Choose a relative storage folder');return path;}
export function storageSaveResultMatches(input:StorageSaveInput,result:StorageSaveResult):boolean{
 if(input.action!==result.action)return false;
 if(input.action==='list'&&result.action==='list')return result.items.every(item=>input.accountIds.includes(item.accountId)&&item.workspaceId===input.workspaceId);
 if(input.action==='create'&&result.action==='create')return result.save.accountId===input.accountId&&result.save.snapshotId===input.snapshotId&&result.save.workspaceId===input.workspaceId&&result.save.storageId===input.storageId&&result.save.rootRevision===input.rootRevision;
 if((input.action==='read'||input.action==='part')&&(result.action==='read'||result.action==='part'))return result.save.accountId===input.accountId&&result.save.id===input.id;
 return false;
}
