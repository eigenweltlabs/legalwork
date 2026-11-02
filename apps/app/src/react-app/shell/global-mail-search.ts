import { MailClient, MailRequestError, type MailAccountView } from '../domains/mail/mail-client';
import { runMailSearch, type MailSearchResult } from '../domains/mail/mail-search-client';

export type GlobalMailHit = MailSearchResult['items'][number] & {
  kind: 'mail';
  id: string;
  account: string;
  serverOrigin: string;
};
export type GlobalMailPage = {
  accountRevision?: number;
  accounts: MailAccountView[];
  items: GlobalMailHit[];
  limited: boolean;
  incomplete: boolean;
};

/** Uses the desktop mail index without unlocking storage or reading message bodies. */
export async function searchGlobalMail(client: MailClient, query: string, accountId: string, signal: AbortSignal): Promise<GlobalMailPage | null> {
  const status = await client.status(signal);
  if (status.state !== 'ready') {
    if (status.state === 'locked' || status.state === 'locking' || status.state === 'unlocking') return null;
    throw new MailRequestError(503, 'Mail is unavailable.');
  }
  const accounts: MailAccountView[] = [];
  let after: string | undefined;
  do {
    const page = await client.accounts(signal, after);
    signal.throwIfAborted();
    accounts.push(...page.items);
    after = page.nextCursor ?? undefined;
  } while (after);
  if (accountId && !accounts.some(account => account.id === accountId)) throw new MailRequestError(404, 'Mail account changed.');
  const result = query.length >= 2
    ? await runMailSearch(client, { literal: query, ...(accountId ? { accountIds: [accountId] } : {}), limit: 25 }, signal)
    : { items: [], total: 0, pending: 0, incomplete: 0, nextOffset: null };
  signal.throwIfAborted();
  if (result.items.some(hit => !accounts.some(account => account.id === hit.accountId) || accountId && hit.accountId !== accountId)) throw new MailRequestError(409, 'Mail account changed.');
  const current = await client.status(signal);
  signal.throwIfAborted();
  if (current.state !== 'ready') return null;
  if (current.accountRevision !== status.accountRevision) throw new MailRequestError(409, 'Mail accounts changed.');
  return {
    accountRevision: current.accountRevision,
    accounts,
    items: result.items.map(hit => ({ ...hit, kind: 'mail', id: JSON.stringify([hit.accountId, hit.locator]), account: accounts.find(account => account.id === hit.accountId)?.displayName ?? hit.accountId, serverOrigin: client.serverOrigin })),
    limited: result.nextOffset !== null,
    incomplete: result.pending > 0 || result.incomplete > 0,
  };
}
