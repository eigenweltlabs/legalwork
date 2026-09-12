import {z} from 'zod';
import {providerMessageLocatorSchema} from './model.js';
import {mailDraftSaveSchema,mailLocalVersionSchema,mailDraftViewSchema} from './local-view.js';
const id=z.string().min(1).max(4096),uuid=z.string().uuid();
export const agentPermissionSchema=z.enum(['search','read','attachments','export','draft','propose_send','propose_delete']);
export const agentGrantCreateSchema=z.object({accountId:id,workspaceId:id,matterId:id.nullable(),permissions:z.array(agentPermissionSchema).min(1).max(7),expiresAt:z.number().int().positive()}).strict();
export const agentGrantSchema=agentGrantCreateSchema.extend({id:uuid,directory:id,credentialGeneration:id,state:z.enum(['active','revoked']),createdAt:z.number(),revision:z.number().int().positive()}).strict();
export type AgentGrant=z.infer<typeof agentGrantSchema>;
export const agentProposalPayloadSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('send'),sourceVersion:z.string().length(64).nullable().default(null),draftId:uuid,version:mailLocalVersionSchema,contentHash:z.string().length(64),source:providerMessageLocatorSchema.nullable()}).strict(),
 z.object({kind:z.literal('trash'),sourceVersion:z.string().length(64).nullable().default(null),locator:providerMessageLocatorSchema,precondition:id,contentHash:z.string().length(64)}).strict(),
]);
export const agentProposalSchema=z.object({id:uuid,accountId:id,grantId:uuid,grantRevision:z.number(),payload:agentProposalPayloadSchema,sessionId:id,messageId:id,createdAt:z.number(),expiresAt:z.number(),state:z.enum(['pending','approved','rejected','revoked']),actionId:uuid.nullable()}).strict();
export type AgentProposal=z.infer<typeof agentProposalSchema>;
export const agentControlSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('create'),input:agentGrantCreateSchema,directory:id}).strict(),
 z.object({action:z.literal('list')}).strict(),
 z.object({action:z.literal('revoke'),id:uuid}).strict(),
 z.object({action:z.literal('resolve'),token:z.string().regex(/^[a-f0-9]{64}$/),permission:agentPermissionSchema.optional()}).strict(),
 z.object({action:z.literal('check'),id:uuid,revision:z.number().int(),permission:agentPermissionSchema.optional()}).strict(),
 z.object({action:z.literal('body'),grantId:uuid,revision:z.number(),locator:providerMessageLocatorSchema,sourceVersion:z.string().length(64).nullable(),offset:z.number().int().nonnegative().max(32000000).default(0),limit:z.number().int().min(1).max(12000).default(4000)}).strict(),
 z.object({action:z.literal('save-draft'),grantId:uuid,revision:z.number(),source:providerMessageLocatorSchema.nullable(),sourceVersion:z.string().length(64).nullable(),input:mailDraftSaveSchema}).strict(),
 z.object({action:z.literal('draft-bind'),grantId:uuid,draftId:uuid,sourceVersion:z.string().length(64).nullable().default(null),source:providerMessageLocatorSchema.nullable()}).strict(),
 z.object({action:z.literal('draft-source'),grantId:uuid,draftId:uuid}).strict(),
 z.object({action:z.literal('propose'),grantId:uuid,revision:z.number(),payload:agentProposalPayloadSchema,sessionId:id,messageId:id}).strict(),
 z.object({action:z.literal('proposals')}).strict(),
 z.object({action:z.literal('proposal'),id:uuid}).strict(),
 z.object({action:z.literal('approve'),id:uuid}).strict(),
 z.object({action:z.literal('decide'),id:uuid,approve:z.boolean(),actionId:uuid.nullable()}).strict(),
]);
export type AgentControl=z.input<typeof agentControlSchema>;
export const agentControlResultSchema=z.object({body:z.object({text:z.string().max(12000),offset:z.number(),nextOffset:z.number().nullable(),totalCharacters:z.number(),complete:z.boolean(),notice:z.string().nullable()}).strict().optional(),draft:mailDraftViewSchema.optional(),grants:z.array(agentGrantSchema).max(100).optional(),grant:agentGrantSchema.optional(),token:z.string().regex(/^[a-f0-9]{64}$/).optional(),proposals:z.array(agentProposalSchema).max(100).optional(),proposal:agentProposalSchema.optional(),source:providerMessageLocatorSchema.nullable().optional(),sourceVersion:z.string().length(64).nullable().optional(),ok:z.literal(true).optional()}).strict();
export type AgentControlResult=z.infer<typeof agentControlResultSchema>;
export {mailDraftSaveSchema};
export function agentControlResultMatches(input:AgentControl,result:AgentControlResult){
 const fields=input.action==='create'?['grant','token']:input.action==='list'?['grants']:input.action==='resolve'||input.action==='check'?['grant']:input.action==='body'?['body']:input.action==='save-draft'?['draft']:input.action==='draft-source'?['source','sourceVersion']:input.action==='proposals'?['proposals']:['propose','proposal','approve','decide'].includes(input.action)?['proposal']:['ok'];
 const keys=Object.keys(result);return keys.length===fields.length&&fields.every(key=>keys.includes(key));
}
