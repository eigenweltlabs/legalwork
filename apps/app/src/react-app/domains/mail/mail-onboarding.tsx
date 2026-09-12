import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { openDesktopUrl } from '@/app/lib/desktop';
import { MailClient, type MailAccountView, type SyncStatus } from './mail-client';
import { MailOnboardingClient, authorizationUrl, type AccountChoice } from './mail-onboarding-client';

const choices: { id: AccountChoice; label: string }[] = [
  { id: 'gmail', label: 'Google / Gmail' }, { id: 'outlook', label: 'Personal Outlook / Hotmail' },
  { id: 'microsoft-work', label: 'Microsoft work account' }, { id: 'icloud', label: 'iCloud Mail' }, { id: 'manual', label: 'Other IMAP account' },
];
const errors: Record<string, string> = {
  authentication_failed: 'Sign-in was rejected. Check the username and app-specific password.',
  certificate_failed: 'The server certificate could not be verified. Check the server name; insecure connections are not allowed.',
  timeout: 'The mail server did not respond in time. Check the connection and try again.',
  reconnect_required: 'This account is already stored. Use Reconnect on that account.',
  binding_mismatch: 'This is a different account. Choose the original account when reconnecting, or add it separately.',
  permissions_missing: 'Required mail permissions were not granted. Try signing in again and review the consent screen.',
  identity_failed: 'The signed-in mailbox identity could not be verified.',
  unavailable: 'Mail setup is unavailable. Check the local provider configuration and network connection.',
  cancelled: 'Connection cancelled.', expired: 'Sign-in expired. Start again.',
};
function errorText(code: string) { return errors[code] ?? 'The account could not be connected. Check the provider settings and try again.'; }
export function MailOnboarding({ client, accounts, onChanged, onClose }: {
  client: MailClient; accounts: MailAccountView[]; onChanged: () => void; onClose?: () => void;
}) {
  const [progress, setProgress] = useState<Record<string, SyncStatus>>({});
  useEffect(() => {
    const controller = new AbortController(); let pending = false;
    const poll = async () => {
      if (pending) return; pending = true;
      try {
        const entries = await Promise.all(accounts.map(async (account): Promise<[string, SyncStatus] | null> => {
          try { return [account.id, await client.sync(account.id, controller.signal)]; }
          catch { return null; }
        }));
        if (!controller.signal.aborted) setProgress(Object.fromEntries(entries.filter(entry => entry !== null)));
      } finally { pending = false; }
    };
    void poll(); const timer = setInterval(() => void poll(), 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [client, accounts]);
  async function retrySync(accountId: string) {
    try { const value = await client.sync(accountId, AbortSignal.timeout(15000), 'start'); setProgress(current => ({...current, [accountId]: value})); }
    catch { setFailure('Sync could not be started. Check your connection or reconnect the account.'); }
  }
  const api = useRef(new MailOnboardingClient(client)).current;
  const [choice, setChoice] = useState<AccountChoice>('gmail');
  const [reconnect, setReconnect] = useState('');
  const [username, setUsername] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(993);
  const [password, setPassword] = useState('');
  const [folderText, setFolderText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [failure, setFailure] = useState('');
  const [signInUrl, setSignInUrl] = useState('');
  const abort = useRef(new AbortController());
  const connection = useRef<string | undefined>(undefined);
  const imapRequest = useRef<string | undefined>(undefined);
  const imap = choice === 'icloud' || choice === 'manual';
  useEffect(() => () => {
    abort.current.abort();
    if(imapRequest.current) void api.cancelImap(imapRequest.current).catch(()=>{});
    if (connection.current) void api.cancel(connection.current).catch(() => {});
  }, [api]);
  function reset() {
    abort.current.abort(); abort.current = new AbortController();
    if (connection.current) void api.cancel(connection.current).catch(() => {});
    if(imapRequest.current) void api.cancelImap(imapRequest.current).catch(()=>{});
    imapRequest.current = undefined;
    connection.current = undefined; setPassword(''); setSignInUrl(''); setBusy(false);
  }
  async function connect() {
    reset(); const signal = abort.current.signal;
    setFailure(''); setNotice(''); setBusy(true);
    try {
      if (imap) {
        const requestId=crypto.randomUUID();imapRequest.current=requestId;
        const secret = password; setPassword('');
        const folders = folderText.split('\n').map(value => value.trim()).filter(Boolean);
        const result = await api.imap({ host: choice === 'icloud' ? 'imap.mail.me.com' : host, port: choice === 'icloud' ? 993 : port, username, password: secret,
          ...(folders.length ? { folders } : {}), ...(reconnect ? { reconnectAccountId: reconnect } : {}) }, signal, requestId);
        if (signal.aborted) return;
        imapRequest.current=undefined;
        if ('error' in result) throw Error(errorText(result.error));
        setNotice('Connected. Mail downloads automatically unless you previously paused this account.'); onChanged(); return;
      }
      const flow = await api.begin(choice, signal, reconnect || undefined);
      if (signal.aborted) { void api.cancel(flow.connectionId).catch(() => {}); return; }
      connection.current = flow.connectionId;
      const url = authorizationUrl(flow.authorizationUrl, choice); setSignInUrl(url);
      try { await openDesktopUrl(url); } catch { setNotice('Use Open sign-in again to finish in your browser.'); }
      while (!signal.aborted) {
        const value = await api.status(flow.connectionId, signal);
        if (signal.aborted) return;
        if (value.state === 'connected') {
          connection.current = undefined; setSignInUrl('');
          setNotice(value.renewable ? 'Connected. Mail downloads automatically unless you previously paused this account.' : 'Connected for this session. The provider did not grant background renewal.'); onChanged(); return;
        }
        if (value.state === 'failed') throw Error(errorText(value.error));
        if (value.state === 'cancelled' || value.state === 'expired') throw Error(errorText(value.state));
        setNotice(value.state === 'verifying' ? 'Verifying your mailbox…' : 'Finish sign-in in your browser.');
        await new Promise<void>(resolve => { const timer = setTimeout(done, 1000); function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); } signal.addEventListener('abort', done, { once: true }); });
      }
    } catch (error) {
      if (!signal.aborted) setFailure(error instanceof Error ? error.message : 'Connection failed.');
    } finally { if (!signal.aborted) { setBusy(false); setPassword(''); } }
  }
  async function selectReconnect(account: MailAccountView) {
    reset(); setReconnect(account.id); setFailure(''); setNotice('Reconnect must use the same mailbox identity.');
    setChoice(account.provider === 'gmail' ? 'gmail' : account.provider === 'graph' ? (account.personal ? 'outlook' : 'microsoft-work') : 'manual');
    if (account.provider === 'imap') {
      const signal = abort.current.signal;
      try { const { settings } = await api.discovery(account.id, signal); if (signal.aborted) return; setHost(settings.host); setPort(settings.port); setUsername(settings.username); setFolderText(settings.folders?.join('\n') ?? ''); }
      catch { if (!signal.aborted) setNotice('Enter the original server and username to reconnect this account.'); }
    }
  }
  async function disconnect(account: MailAccountView) {
    reset(); setBusy(true); setFailure(''); const signal = abort.current.signal;
    try { await api.disconnect(account.id, signal); if (!signal.aborted) { setNotice('Disconnected. Local copies remain locked until you reconnect. Use retention settings to export, back up or explicitly delete local copies.'); onChanged(); } }
    catch { if (!signal.aborted) setFailure('The account could not be disconnected. Try again.'); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  return (
    <section aria-label="Mail account setup" className="mail-onboarding bg-background">
      <div className="flex items-center justify-between gap-4">{onClose && <h2 className="text-lg font-semibold">Mail accounts</h2>}{onClose && <Button variant="outline" onClick={() => { reset(); onClose(); }}>Close setup</Button>}</div>
      <p className="mt-2 text-sm text-muted-foreground">Connect directly to your provider. Mail stays in the encrypted store on this computer.</p>
      {accounts.length > 0 && <ul className="my-4 space-y-2">{accounts.map(account => (
        <li key={account.id} className="flex flex-wrap items-center gap-2"><span className="flex-1 break-words">{account.displayName}{progress[account.id] && <small className="block text-muted-foreground" role="status">{progress[account.id].state === 'syncing' ? 'Downloading mail' : progress[account.id].state === 'waiting' ? 'Waiting to retry' : progress[account.id].state === 'paused' ? 'Sync paused' : progress[account.id].state === 'complete' ? 'Up to date' : 'Sync needs attention'} · {progress[account.id].projected} messages available{progress[account.id].error && ` · ${progress[account.id].error?.replaceAll('_', ' ')}`}</small>}</span>{progress[account.id] && ['paused','waiting','attention','idle'].includes(progress[account.id].state) && <Button size="sm" variant="outline" disabled={busy} onClick={() => void retrySync(account.id)}>{progress[account.id].state === 'paused' ? 'Resume' : 'Retry sync'}</Button>}{!account.identity&&<Button size="sm" variant="outline" disabled={busy} onClick={() => void selectReconnect(account)}>Reconnect</Button>}<Button size="sm" variant="outline" disabled={busy} onClick={() => void disconnect(account)}>Disconnect</Button></li>
      ))}</ul>}
      <form className="mt-4 max-w-xl space-y-4" onSubmit={event => { event.preventDefault(); void connect(); }}>
        <label className="block text-sm font-medium">Provider
          <select className="mt-1 block w-full rounded border bg-background p-2" value={choice} disabled={busy} onChange={event => { const selected = choices.find(item => item.id === event.target.value); if (selected) { setChoice(selected.id); setPassword(''); } }}>
            {choices.map(value => <option key={value.id} value={value.id}>{value.label}</option>)}
          </select>
        </label>
        {reconnect && <p className="text-sm">Reconnecting {accounts.find(account => account.id === reconnect)?.displayName}. <button type="button" className="underline" disabled={busy} onClick={() => setReconnect('')}>Add a different account</button></p>}
        {imap ? <>
          <p className="text-sm">{choice === 'icloud' ? 'Use an app-specific password created in your Apple Account, not your main Apple password. Apple requires two-factor authentication. The username is usually the part before @icloud.com; try the full address if needed.' : 'Use the server’s direct TLS port. Certificate validation is always enabled; STARTTLS and insecure connections are not supported.'}</p>
          <label className="block text-sm font-medium">Email / IMAP username<input required autoComplete="username" className="mt-1 block w-full rounded border bg-background p-2" value={username} onChange={event => setUsername(event.target.value)} disabled={busy}/></label>
          {choice === 'manual' && <div className="grid grid-cols-[1fr_90px] gap-3"><label className="text-sm font-medium">IMAP server<input required className="mt-1 block w-full rounded border bg-background p-2" placeholder="imap.example.com" value={host} onChange={event => setHost(event.target.value)} disabled={busy}/></label><label className="text-sm font-medium">TLS port<input type="number" required min={1} max={65535} className="mt-1 block w-full rounded border bg-background p-2" value={port} onChange={event => setPort(Number(event.target.value))} disabled={busy}/></label></div>}
          <label className="block text-sm font-medium">App-specific password<input required type="password" autoComplete="new-password" className="mt-1 block w-full rounded border bg-background p-2" value={password} onChange={event => setPassword(event.target.value)} disabled={busy}/></label>
          <details><summary className="cursor-pointer text-sm">Folder selection (optional)</summary><label className="block text-sm">One exact folder path per line. Leave blank for all selectable folders.<textarea className="mt-1 block w-full rounded border bg-background p-2" value={folderText} onChange={event => setFolderText(event.target.value)} disabled={busy}/></label></details>
        </> : <p className="text-sm">Sign in securely in your browser. LegalWork never asks for your Google or Microsoft password.{choice === 'microsoft-work' && ' This installation uses its configured organizational tenant.'}</p>}
        <div className="flex gap-2"><Button type="submit" disabled={busy}>{busy ? 'Connecting…' : reconnect ? 'Reconnect account' : imap ? 'Connect securely' : 'Continue in browser'}</Button>{busy && <Button type="button" variant="outline" onClick={() => { reset(); setNotice('Cancellation requested. If connection had already finished, the account may still appear. Refresh accounts to check.'); }}>Cancel</Button>}</div>
      </form>
      {signInUrl && <Button variant="outline" className="mt-3" onClick={() => void openDesktopUrl(signInUrl)}>Open sign-in again</Button>}
      {notice && <p role="status" className="mt-3 text-sm">{notice}</p>}
      {failure && <p role="alert" className="mt-3 text-sm text-destructive">{failure}</p>}
    </section>
  );
}
