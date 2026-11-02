import { mailRulesSchema, mailRuleSaveSchema, mailRuleDeleteSchema, type MailRuleSave, type MailRuleDelete } from '../../../../../server/src/mail/rules-view';
import { MailClient } from './mail-client';

export async function requestMailRules(client: MailClient, accountId: string, signal: AbortSignal, change?: { kind: 'save'; input: MailRuleSave } | { kind: 'delete'; input: MailRuleDelete }) {
  const input = change?.kind === 'save' ? mailRuleSaveSchema.parse(change.input) : change?.kind === 'delete' ? mailRuleDeleteSchema.parse(change.input) : {};
  const result = await client.request(`/accounts/${encodeURIComponent(accountId)}/rules/${change?.kind ?? 'read'}`, mailRulesSchema, signal, input);
  if (result.accountId !== accountId) throw Error('Rule account changed.');
  return result;
}
