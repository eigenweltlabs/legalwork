import {z} from 'zod';


export const mailPolicyActionSchema=z.enum(['allow','ask','deny']);
export const mailAccountActionsSchema=z.object({
 search:mailPolicyActionSchema,read:mailPolicyActionSchema,attachments:mailPolicyActionSchema,
 export:mailPolicyActionSchema,draft:mailPolicyActionSchema,propose_send:mailPolicyActionSchema,propose_delete:mailPolicyActionSchema,
}).strict();
export type MailAccountActions=z.infer<typeof mailAccountActionsSchema>;
export const mailAccountPolicySchema=z.object({accountId:z.string(),revision:z.number().int().nonnegative(),migrationRequired:z.boolean(),actions:mailAccountActionsSchema}).strict();
export type MailAccountPolicy=z.infer<typeof mailAccountPolicySchema>;
export const defaultMailAccountActions:MailAccountActions={search:'allow',read:'allow',attachments:'allow',export:'ask',draft:'allow',propose_send:'ask',propose_delete:'ask'};
export const deniedMailAccountActions:MailAccountActions={search:'deny',read:'deny',attachments:'deny',export:'deny',draft:'deny',propose_send:'deny',propose_delete:'deny'};
export const mailActionLabels:Record<keyof MailAccountActions,string>={search:'Search mail',read:'Read messages',attachments:'Read attachments',export:'Export original messages',draft:'Create and edit drafts',propose_send:'Send mail',propose_delete:'Move mail to Trash'};

export const mailPendingApprovalSchema=z.object({id:z.string(),sessionId:z.string(),workspaceId:z.string(),accountId:z.string(),accountLabel:z.string(),action:z.string(),description:z.string(),createdAt:z.number()});
export type MailPendingApproval=z.infer<typeof mailPendingApprovalSchema>;
