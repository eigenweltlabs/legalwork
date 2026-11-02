import { useEffect, useState } from 'react';
import { MailClient, MailRequestError } from '../domains/mail/mail-client';
import { resolveLegalworkConnection } from './legalwork-connection';
import { searchGlobalMail, type GlobalMailPage } from './global-mail-search';

type MailSearchState = { query: string; accountId: string; revision: number } & (
  { status: 'ready'; page: GlobalMailPage } | { status: 'locked' | 'unavailable' | 'too-long' }
);

export function useGlobalMailSearch(open: boolean, query: string, accountId: string) {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<MailSearchState>();
  useEffect(() => {
    const changed = () => { setState(undefined); setRevision(value => value + 1); };
    window.addEventListener('legalwork-server-settings-changed', changed);
    return () => window.removeEventListener('legalwork-server-settings-changed', changed);
  }, []);
  useEffect(() => {
    if (!open) { setState(undefined); return; }
    const controller = new AbortController(), identity = { query, accountId, revision };
    if (query.length > 512) { setState({ ...identity, status: 'too-long' }); return; }
    let poll: ReturnType<typeof setInterval> | undefined;
    const timer = setTimeout(() => void (async () => {
      try {
        const connection = await resolveLegalworkConnection();
        controller.signal.throwIfAborted();
        const client = new MailClient(connection.normalizedBaseUrl, connection.resolvedHostToken);
        const page = await searchGlobalMail(client, query, accountId, controller.signal);
        controller.signal.throwIfAborted();
        setState(page ? { ...identity, status: 'ready', page } : { ...identity, status: 'locked' });
        if (page) poll = setInterval(() => {
          void client.status(controller.signal).then(current => {
            if (controller.signal.aborted) return;
            if (current.state !== 'ready') { setState({ ...identity, status: ['locked', 'locking', 'unlocking'].includes(current.state) ? 'locked' : 'unavailable' }); controller.abort(); }
            else if (current.accountRevision !== page.accountRevision) { setState(undefined); setRevision(value => value + 1); controller.abort(); }
          }).catch(() => { if (!controller.signal.aborted) { setState({ ...identity, status: 'unavailable' }); controller.abort(); } });
        }, 2000);
      } catch (error) {
        if (!controller.signal.aborted) setState({ ...identity, status: error instanceof MailRequestError && error.status === 423 ? 'locked' : 'unavailable' });
      }
    })(), 220);
    controller.signal.addEventListener('abort', () => clearInterval(poll), { once: true });
    return () => { clearTimeout(timer); clearInterval(poll); controller.abort(); };
  }, [open, query, accountId, revision]);
  return {
    state: open && state?.query === query && state.accountId === accountId && state.revision === revision ? state : undefined,
    accounts: open && state?.status === 'ready' && state.revision === revision ? state.page.accounts : [],
    retry: () => setRevision(value => value + 1),
  };
}
