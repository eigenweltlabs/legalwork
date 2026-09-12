import {MailAgentAccessView} from './mail-agent-access-view';
import {MailRetentionView} from './mail-retention-view';
import {MailDesktopPreferences} from '../../mail/mail-desktop';
import {MailSmtpView} from './mail-smtp-view';
import {MailPortabilityView} from './mail-portability-view';
/** @jsxImportSource react */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {MailSendersView} from './mail-senders-view';
import { GraphMailboxesView } from './graph-mailboxes-view';
import { Switch } from '@/components/ui/switch';
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
    <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">Notifications, app badge and background mail</summary><div className="space-y-6 pt-4"><MailBadgePreference /><MailDesktopPreferences /></div></details>
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
    <MailOnboarding client={client} accounts={accounts.filter(account=>account.provider!=='archive')} onChanged={() => setRevision(value => value + 1)} />
    <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">Agent access and requests</summary><div className="pt-4"><MailAgentAccessView client={client} accounts={accounts} /></div></details>
    <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">Sender identities and signatures</summary><div className="pt-4"><MailSendersView client={client} accounts={accounts.filter(account=>account.provider!=='archive')} /></div></details>
    <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">Shared mailboxes and outgoing SMTP</summary><div className="space-y-6 pt-4"><GraphMailboxesView client={client} accounts={accounts} onChanged={() => setRevision(value => value + 1)} /><MailSmtpView client={client} accounts={accounts.filter(account=>account.provider!=='archive')} /></div></details>
    <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">Retention, encrypted backup and restore</summary><div className="pt-4"><MailRetentionView client={client} accounts={accounts} onChanged={() => setRevision(value => value + 1)} /></div></details>
    <details className="rounded-lg border p-4"><summary className="cursor-pointer text-sm font-medium">Import and export</summary><div className="pt-4"><MailPortabilityView accounts={accounts} onChanged={() => setRevision(value => value + 1)} /></div></details>
  </>;
}

function MailBadgePreference() {
  const invoke = window.__LEGALWORK_ELECTRON__?.invokeDesktop;
  const [enabled, setEnabled] = useState<boolean>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void invoke?.('getMailBadgeEnabled').then(value => { if (active) setEnabled(value); }).catch(() => { if (active) setError('App icon badge settings are unavailable.'); });
    return () => { active = false; };
  }, [invoke]);
  if (!invoke) return null;
  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-4 text-sm"><span>Show unread mail count on app icon</span><Switch aria-label="Show unread mail count on app icon" checked={enabled ?? true} disabled={busy || enabled === undefined} onCheckedChange={async next => {
      setBusy(true); setError('');
      try { setEnabled(await invoke('setMailBadgeEnabled', next)); }
      catch { setError('The app icon badge setting could not be saved. Try again.'); }
      finally { setBusy(false); }
    }} /></div>
    <p className="text-xs text-muted-foreground">Unread Inbox messages across connected accounts. Notification banners and sounds are controlled separately.</p>
    {error && <p role="alert">{error}</p>}
  </div>;
}
