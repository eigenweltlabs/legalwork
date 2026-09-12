import {z} from 'zod';
import {mailLocalVersionSchema} from './local-view.js';
const id=z.string().min(1).max(4096),uuid=z.string().uuid();
export const draftRemoteRefSchema=z.object({id,version:id,messageId:id.nullable().default(null),folder:id.nullable().default(null),uidValidity:z.number().int().positive().nullable().default(null)}).strict();
export type DraftRemoteRef=z.infer<typeof draftRemoteRefSchema>;
export const draftSyncRequestSchema=z.object({draftId:uuid,expected:mailLocalVersionSchema,action:z.enum(['sync','retry','keep_local','use_remote','delete','disable']),remoteHash:z.string().regex(/^[0-9a-f]{64}$/).optional()}).strict();
export const draftSyncReadSchema=z.object({draftId:uuid}).strict();
export const draftSyncStatusSchema=z.object({accountId:id,draftId:uuid,state:z.enum(['local','queued','syncing','synced','conflict','uncertain','error','removed']),enabled:z.boolean(),recipientInputLocalOnly:z.boolean().default(false),dirty:z.boolean(),revision:z.number().int().nonnegative(),remote:draftRemoteRefSchema.nullable(),remoteHash:z.string().nullable(),error:z.enum(['sender_unavailable','incomplete','unsupported','permission','remote_changed','remote_missing','dispatch_unknown','retryable','local_changed','provider_rejected']).nullable(),operation:z.enum(['upsert','delete','cleanup','adopt']),updatedAt:z.number().int().nonnegative()}).strict();
export type DraftSyncStatus=z.infer<typeof draftSyncStatusSchema>;
export type DraftSyncRequest=z.infer<typeof draftSyncRequestSchema>;
export const draftSyncCommandSchema=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('mail.draft.sync.read'),accountId:id,input:draftSyncReadSchema}).strict(),
 z.object({operation:z.literal('mail.draft.sync.request'),accountId:id,input:draftSyncRequestSchema}).strict(),
]);
export type DraftSyncCommand=z.infer<typeof draftSyncCommandSchema>;
