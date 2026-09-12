import { z } from 'zod';
const id = z.string().min(1).max(4096);
export const graphMailboxInputSchema = z.object({
  credentialAccountId: id,
  address: z.string().email().max(320).transform(value => value.toLowerCase()),
  kind: z.enum(['shared', 'delegated']),
  writeConfirmed: z.boolean().default(false),
  sendMode: z.enum(['none', 'send_as', 'send_on_behalf']).default('none'),
}).strict();
export const graphMailboxIdentitySchema = z.object({
  address: z.string().email(), kind: z.enum(['shared', 'delegated']),
  credentialAccountId: id, state: z.enum(['connected', 'revoked', 'disconnected']),
  writeConfirmed: z.boolean(),
  read: z.boolean(), write: z.boolean(), sendAs: z.boolean(), sendOnBehalf: z.boolean(),
  sendMode: z.enum(['none', 'send_as', 'send_on_behalf']), sendAllowed: z.boolean(),
  sentItems: z.literal('signed_in_mailbox'), capabilitySource: z.literal('administrator_confirmed'),
  missingGrants: z.array(z.enum(['Mail.Read.Shared', 'Mail.ReadWrite.Shared', 'Mail.Send.Shared', 'Exchange mailbox access', 'Exchange write access', 'Exchange Send As or Send on Behalf'])),
  revision: z.number().int().positive(),
}).strict();
export const graphMailboxResultSchema = z.object({ accountId: id, identity: graphMailboxIdentitySchema }).strict();
export type GraphMailboxInput = z.input<typeof graphMailboxInputSchema>;
export type GraphMailboxIdentity = z.infer<typeof graphMailboxIdentitySchema>;
