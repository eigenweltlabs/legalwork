/** @jsxImportSource react */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { resolveLegalworkConnection } from '@/react-app/shell/legalwork-connection';
import { MailClient, type MailAccountView } from '../../mail/mail-client';
import { MailOnboarding } from '../../mail/mail-onboarding';
import { SettingsStack } from '../settings-section';

/** Resolve the host independently of the selected workspace. Repeated desktop
 * announcements retain active sign-in; a different resolved identity retires it. */
export function MailAccountsView() {
  const [client, setClient] = useState<MailClient>();
  const identity = useRef('');
  const [clientVersion, setClientVersion] = useState(0);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const changed = () => setRevision(value => value + 1);
    window.addEventListener('legalwork-server-settings-changed', changed);
    return () => window.removeEventListener('legalwork-server-settings-changed', changed);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void (async () => {
      try {
        const connection = await resolveLegalworkConnection();
        if (controller.signal.aborted) return;
        const nextIdentity = connection.normalizedBaseUrl + '\n' + connection.resolvedHostToken;
        if (identity.current === nextIdentity) return;
        identity.current = '';
        setClient(undefined);
        if (!connection.normalizedBaseUrl) throw Error('unavailable');
        const next = new MailClient(connection.normalizedBaseUrl, connection.resolvedHostToken);
        let status = await next.status(controller.signal);
        if (status.state !== 'ready') status = await next.unlock(controller.signal);
        if (status.state !== 'ready') throw Error('unavailable');
        if (!controller.signal.aborted) { identity.current = nextIdentity; setClient(next); setClientVersion(value => value + 1); }
      } catch {
        if (!controller.signal.aborted) { identity.current = ''; setClient(undefined); setError('Mail accounts are unavailable. Check the local connection and retry.'); }
      }
    })();
    return () => controller.abort();
  }, [revision]);
  return <SettingsStack>
    {client ? <MailAccountControls key={clientVersion} client={client} /> : error ? <div role="alert">{error} <Button variant="outline" onClick={() => setRevision(value => value + 1)}>Retry</Button></div> : <p role="status">Opening mail accounts…</p>}
  </SettingsStack>;
}

export function MailAccountControls({ client }: { client: MailClient }) {
  const [accounts, setAccounts] = useState<MailAccountView[]>([]);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const result: MailAccountView[] = [];
        let cursor: string | undefined;
        do {
          const page = await client.accounts(controller.signal, cursor);
          result.push(...page.items);
          if (result.length > 500) throw Error('limit');
          cursor = page.nextCursor ?? undefined;
        } while (cursor && !controller.signal.aborted);
        if (!controller.signal.aborted) { setAccounts(result); setError(''); }
      } catch { if (!controller.signal.aborted) { setAccounts([]); setError('Accounts could not be refreshed. Retry to check their current status.'); } }
    })();
    return () => controller.abort();
  }, [client, revision]);
  return <>
    {error && <p role="alert">{error}</p>}
    <div><Button variant="outline" onClick={() => setRevision(value => value + 1)}>Refresh accounts</Button></div>
    <MailOnboarding client={client} accounts={accounts} onChanged={() => setRevision(value => value + 1)} />
  </>;
}
