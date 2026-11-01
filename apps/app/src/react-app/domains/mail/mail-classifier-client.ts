import { MailClassifierError, mailClassifierDisplaySchema, mailClassifierDisplayPreviewSchema, mailClassifierSaveSchema, type MailClassifierSave } from '../../../../../server/src/mail/classifier-view';
import { providerMessageKey } from '../../../../../server/src/mail/model';
import type { MailClient, MailMessageView } from './mail-client';

export async function requestMailClassifier(client: MailClient, accountId: string, signal: AbortSignal, change?: MailClassifierSave) {
  const input = change ? mailClassifierSaveSchema.parse(change) : undefined;
  const value = await client.request('/classifier', mailClassifierDisplaySchema, signal, input ? { operation: 'mail.classifier.save', accountId, input } : { operation: 'mail.classifier.read', accountId });
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (value.accountId !== accountId) throw new MailClassifierError('unavailable');
  if (input) {
    const expected = input.expected;
    if (expected ? value.version?.generation !== expected.generation || value.version.revision !== expected.revision + 1 : value.version?.revision !== 1) throw new MailClassifierError('unavailable');
    if (value.definition.mode !== input.definition.mode || JSON.stringify(value.definition.exclusions) !== JSON.stringify(input.definition.exclusions) || value.definition.rules.length !== input.definition.rules.length || value.definition.rules.some((rule, index) => {
      const requested = input.definition.rules[index];
      return rule.id !== requested.id || rule.name !== requested.name || rule.order !== requested.order || rule.enabled !== requested.enabled || JSON.stringify(rule.criteria) !== JSON.stringify(requested.criteria) || requested.project && rule.project && (requested.project.id !== rule.project.id || requested.project.binding !== rule.project.binding);
    })) throw new MailClassifierError('unavailable');
  }
  return value;
}

export async function previewMailClassification(client: MailClient, item: MailMessageView, signal: AbortSignal) {
  const value = await client.request('/classifier', mailClassifierDisplayPreviewSchema, signal, { operation: 'mail.classifier.preview', accountId: item.accountId, input: { locator: item.locator } });
  if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
  if (value.accountId !== item.accountId || providerMessageKey(value.locator) !== providerMessageKey(item.locator)) throw new MailClassifierError('unavailable');
  return value;
}
