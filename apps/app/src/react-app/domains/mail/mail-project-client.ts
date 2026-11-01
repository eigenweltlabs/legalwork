import { mailProjectCatalogSchema, mailProjectDisplaySchema, mailProjectDisplayHistorySchema, MailProjectError, type MailProjectDisplay, type MailProjectReference } from '../../../../../server/src/mail/project-association-view';
import { providerMessageKey } from '../../../../../server/src/mail/model';
import type { MailClient, MailMessageView } from './mail-client';

function matches(item: MailMessageView, value: { accountId: string; locator: MailMessageView['locator'] }) {
  if (value.accountId !== item.accountId || providerMessageKey(value.locator) !== providerMessageKey(item.locator)) throw new MailProjectError('unavailable');
}
export function mailProjectCatalog(client: MailClient, signal: AbortSignal, after?: string) {
  return client.request('/projects', mailProjectCatalogSchema, signal, { action: 'catalog', ...(after ? { after } : {}) });
}
export async function readMailProject(client: MailClient, item: MailMessageView, signal: AbortSignal) {
  const value = await client.request('/projects', mailProjectDisplaySchema, signal, { action: 'read', accountId: item.accountId, input: { locator: item.locator } });
  matches(item, value); return value;
}
export async function setMailProject(client: MailClient, item: MailMessageView, current: MailProjectDisplay, project: MailProjectReference | null, signal: AbortSignal) {
  matches(item, current);
  const value = await client.request('/projects', mailProjectDisplaySchema, signal, { action: 'set', accountId: item.accountId, input: { locator: item.locator, expected: current.version, project } });
  matches(item, value);
  if (!value.unavailable && JSON.stringify(value.project ? { id: value.project.id, binding: value.project.binding } : null) !== JSON.stringify(project)) throw new MailProjectError('unavailable');
  if (current.version ? value.version?.generation !== current.version.generation || ![current.version.revision, current.version.revision + 1].includes(value.version.revision) : !(value.version?.revision === 1 || value.version === null && project === null)) throw new MailProjectError('unavailable');
  return value;
}
export async function mailProjectHistory(client: MailClient, item: MailMessageView, signal: AbortSignal, beforeRevision?: number) {
  const value = await client.request('/projects', mailProjectDisplayHistorySchema, signal, { action: 'history', accountId: item.accountId, input: { locator: item.locator, ...(beforeRevision ? { beforeRevision } : {}) } });
  matches(item, value);
  if (value.items.some((entry, index) => beforeRevision !== undefined && entry.version.revision >= beforeRevision || index > 0 && value.items[index - 1].version.revision <= entry.version.revision) || value.nextRevision !== null && value.nextRevision !== value.items.at(-1)?.version.revision) throw new MailProjectError('unavailable');
  return value;
}
