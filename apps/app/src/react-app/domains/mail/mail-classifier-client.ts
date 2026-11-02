import { MailClassifierError, mailClassifierDisplaySchema, mailClassifierDisplayPreviewSchema, mailClassifierSaveSchema, type MailClassifierSave } from '../../../../../server/src/mail/classifier-view';
import { mailClassifierDisplayActivitySchema, mailClassifierActivityInputSchema, mailClassifierReviewActionSchema, mailClassifierActionResultSchema } from '../../../../../server/src/mail/classifier-incoming-view';
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
    if (value.definition.mode !== input.definition.mode || value.definition.automaticThreshold !== input.definition.automaticThreshold || JSON.stringify(value.definition.exclusions) !== JSON.stringify(input.definition.exclusions) || value.definition.rules.length !== input.definition.rules.length || value.definition.rules.some((rule, index) => {
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

export async function mailClassificationActivity(client: MailClient, accountId: string, signal: AbortSignal, supplied: {filter: 'review'|'assigned'|'all'; beforeId?:number}) {
  const input=mailClassifierActivityInputSchema.parse(supplied);
  const value=await client.request('/classifier',mailClassifierDisplayActivitySchema,signal,{operation:'mail.classifier.activity',accountId,input});
  signal.throwIfAborted();
  if(value.accountId!==accountId||value.items.some((item,index)=>(input.beforeId!==undefined&&item.id>=input.beforeId)||(index>0&&value.items[index-1].id<=item.id))||value.nextCursor!==null&&((input.beforeId!==undefined&&value.nextCursor>=input.beforeId)||(value.items.length>0&&value.nextCursor>value.items[value.items.length-1].id)))throw new MailClassifierError('unavailable');
  return value;
}
export async function changeMailClassification(client:MailClient,accountId:string,signal:AbortSignal,action:'undo'|'dismiss',supplied:import('zod').infer<typeof mailClassifierReviewActionSchema>){
  const input=mailClassifierReviewActionSchema.parse(supplied);
  const value=await client.request('/classifier',mailClassifierActionResultSchema,signal,{operation:action==='undo'?'mail.classifier.undo':'mail.classifier.dismiss',accountId,input});
  signal.throwIfAborted();
  if(value.accountId!==accountId||value.id!==input.id||value.version.generation!==input.expected.generation||value.version.revision!==input.expected.revision+1||value.outcome!==(action==='undo'?'undone':'dismissed'))throw new MailClassifierError('unavailable');
  return value;
}
