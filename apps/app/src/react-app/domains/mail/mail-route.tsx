/** @jsxImportSource react */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { resolveLegalworkConnection } from '../../shell/legalwork-connection';
import { MailClient, UnifiedMailPages, bodyEnvelope, type MailAccountView, type MailFolderView, type MailMessageView, type MailPartView, type SyncStatus } from './mail-client';
import { mailHtml, rasterType, safeFilename } from './mail-html';
const textError = (error: unknown) => error instanceof Error ? error.message : 'Mail is unavailable.';
function dataUrl(bytes: Uint8Array, type: string) { let binary = ''; for (let at = 0; at < bytes.length; at += 8192)
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192)); return `data:${type};base64,${btoa(binary)}`; }
function saveBytes(bytes: Uint8Array<ArrayBuffer>, name: string, type: string) { const url = URL.createObjectURL(new Blob([bytes], { type })); const link = document.createElement('a'); link.href = url; link.download = safeFilename(name); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
export function MailRoute() {
    const [client, setClient] = useState<MailClient>();
    const [accounts, setAccounts] = useState<MailAccountView[]>([]);
    const [account, setAccount] = useState('');
    const [folders, setFolders] = useState<MailFolderView[]>([]);
    const [folder, setFolder] = useState('');
    const [inbox, setInbox] = useState(true);
    const [items, setItems] = useState<MailMessageView[]>([]);
    const [selected, setSelected] = useState<MailMessageView>();
    const [thread, setThread] = useState<string>();
    const [error, setError] = useState('');
    const [locked, setLocked] = useState(true);
    const [busy, setBusy] = useState(false);
    const [revision, setRevision] = useState(0);
    const [more, setMore] = useState(false);
    const [sync, setSync] = useState<SyncStatus>();
    const pager = useRef<UnifiedMailPages | undefined>(undefined);
    const request = useRef(new AbortController());
    const purge = () => { request.current.abort(); request.current = new AbortController(); pager.current = undefined; setItems([]); setSelected(undefined); setSync(undefined); setMore(false); };
    useEffect(() => {
        const controller = new AbortController();
        void resolveLegalworkConnection().then(connection => {
            if (controller.signal.aborted) return;
            if (!connection.normalizedBaseUrl) return;
            setClient(new MailClient(connection.normalizedBaseUrl, connection.resolvedHostToken));
            setError('');
        }).catch(error => { if (!controller.signal.aborted) setError(textError(error)); });
        return () => { controller.abort(); request.current.abort(); };
    }, [revision]);
    useEffect(() => {
        const changed = () => setRevision(value => value + 1);
        window.addEventListener('legalwork-server-settings-changed', changed);
        return () => window.removeEventListener('legalwork-server-settings-changed', changed);
    }, []);
    useEffect(() => { if (!client)
        return; const controller = new AbortController(); void (async () => { try {
        let status = await client.status(controller.signal);
        if (status.state !== 'ready') status = await client.unlock(controller.signal);
        if (status.state !== 'ready') throw Error('Mail could not be opened. Please retry.');
        if (controller.signal.aborted) return;
        setLocked(false);
        let next: string | null = null;
        const result: MailAccountView[] = [];
        do {
            const page = await client.accounts(controller.signal, next ?? undefined);
            result.push(...page.items);
            next = page.nextCursor;
            if (result.length > 500)
                throw Error('Too many accounts for this reader.');
        } while (next);
        if (!controller.signal.aborted)
            setAccounts(result);
    }
    catch (error) {
        if (!controller.signal.aborted)
            { setLocked(true); setError(textError(error)); }
    } })(); return () => controller.abort(); }, [client, revision]);
    useEffect(() => { if (!client || locked)
        return; const controller = new AbortController(); const poll = setInterval(() => { void client.status(controller.signal).then(status => { if (status.state !== 'ready') {
        purge();
        setLocked(true);
        setAccounts([]);
        setError('Mail service is unavailable. Please retry.');
    } }).catch(() => { purge(); setLocked(true); setError('Mail service is unavailable. Please retry.'); }); }, 5000); return () => { clearInterval(poll); controller.abort(); }; }, [client, locked]);
    useEffect(() => { purge(); setFolder(''); setFolders([]); if (!client || !account)
        return; const controller = new AbortController(); void (async () => { try {
        const result: MailFolderView[] = [];
        let next: string | null = null;
        do {
            const page = await client.folders(account, controller.signal, next ?? undefined);
            result.push(...page.items);
            next = page.nextCursor;
            if (result.length > 2000)
                throw Error('Too many folders for this reader.');
        } while (next);
        if (!controller.signal.aborted)
            setFolders(result);
        const status = await client.sync(account, controller.signal);
        if (!controller.signal.aborted)
            setSync(status);
    }
    catch (error) {
        if (!controller.signal.aborted)
            setError(textError(error));
    } })(); return () => controller.abort(); }, [client, account]);
    useEffect(() => { purge(); if (!client || locked || !accounts.length)
        return; const signal = request.current.signal; const stream = new UnifiedMailPages(client, account ? accounts.filter(item => item.id === account) : accounts, folder || undefined, thread, inbox && !thread && !folder); pager.current = stream; setBusy(true); setError(''); void stream.next(signal).then(rows => { if (!signal.aborted) {
        setItems(rows);
        setMore(stream.hasMore);
        if (stream.exclusions.length)
            setError(stream.exclusions.map(value => `${accounts.find(account => account.id === value.accountId)?.displayName ?? value.accountId}: ${value.reason}`).join(" · "));
    } }).catch(error => { if (!signal.aborted)
        setError(textError(error)); }).finally(() => { if (!signal.aborted)
        setBusy(false); }); return () => request.current.abort(); }, [client, accounts, account, folder, thread, inbox, locked, revision]);
    async function loadMore() { const signal = request.current.signal, stream = pager.current; if (!stream)
        return; setBusy(true); try {
        const rows = await stream.next(signal);
        if (!signal.aborted) {
            setSelected(undefined);
            setItems(rows);
            setMore(stream.hasMore);
            if (stream.exclusions.length)
                setError(stream.exclusions.map(value => `${accounts.find(account => account.id === value.accountId)?.displayName ?? value.accountId}: ${value.reason}`).join(" · "));
        }
    }
    catch (error) {
        if (!signal.aborted)
            setError(textError(error));
    }
    finally {
        if (!signal.aborted)
            setBusy(false);
    } }
    useEffect(() => { if (!client || !account || locked)
        return; const abort = new AbortController(); let pending = false; const poll = setInterval(() => { if (pending)
        return; pending = true; void client.sync(account, abort.signal).then(value => { if (!abort.signal.aborted)
        setSync(value); }).catch(error => { if (!abort.signal.aborted)
        setError(textError(error)); }).finally(() => { pending = false; }); }, 3000); return () => { abort.abort(); clearInterval(poll); }; }, [client, account, locked]);
    async function control(operation: 'start' | 'pause') { if (!client || !account)
        return; try {
        setSync(await client.sync(account, request.current.signal, operation));
    }
    catch (error) {
        setError(textError(error));
    } }
    return <main className="flex h-screen flex-col bg-background text-foreground" aria-label="Local mail">
    <header className="flex flex-wrap items-center gap-3 border-b p-4"><Link to="/session" className="underline">← Tasks</Link><h1 className="text-xl font-semibold">Mail</h1><span className="text-sm text-muted-foreground">Stored on this computer</span><div className="ml-auto flex gap-2"><Button variant="outline" onClick={() => { purge(); setRevision(value => value + 1); }}>Refresh</Button></div></header>
    {error && <p role="alert" className="border-b p-3 text-destructive">{error}</p>}
    {locked ? <div className="m-auto max-w-md p-8"><h2 className="text-lg font-medium" role="status">{error ? 'Mail is unavailable' : 'Opening mail…'}</h2>{error && <Button className="mt-3" onClick={() => { setError(''); setRevision(value => value + 1); }}>Retry</Button>}</div> : <div className="grid min-h-0 flex-1 grid-cols-[190px_minmax(240px,1fr)_minmax(320px,2fr)] max-lg:grid-cols-[150px_1fr]">
      <nav aria-label="Mail accounts and folders" className="overflow-auto border-r p-3 space-y-3"><button className="block w-full rounded p-2 text-left hover:bg-muted" aria-current={!account ? 'page' : undefined} onClick={() => { setThread(undefined); setFolder(''); setInbox(true); setAccount(''); }}>Unified Inbox</button><button className="block w-full rounded p-2 text-left" onClick={() => { setThread(undefined); setFolder(''); setInbox(false); setAccount(''); }}>All stored mail</button>
        {accounts.map(item => <button key={item.id} className={`block w-full break-words rounded p-2 text-left ${account === item.id ? 'bg-muted' : ''}`} aria-current={account === item.id ? 'page' : undefined} onClick={() => { setThread(undefined); setAccount(item.id); }}>{item.displayName}<span className="block text-xs text-muted-foreground">{item.provider}</span></button>)}
        {account && <><h2 className="font-medium">Folders and labels</h2>{!folders.some(value => value.role === 'inbox') && <p className="text-xs">Inbox not identified yet. Resume synchronization; all stored folders remain accessible.</p>}<button onClick={() => { setInbox(false); setFolder(''); setThread(undefined); }}>All mail</button>{folders.map(item => <button key={item.id} className={`block w-full break-words rounded p-2 text-left ${folder === item.id ? 'bg-muted' : ''}`} aria-current={folder === item.id ? 'page' : undefined} onClick={() => { setThread(undefined); setFolder(item.id); }}>{item.parentId ? '↳ ' : ''}{item.name}</button>)}<div className="border-t pt-3 text-xs"><p>Sync: {sync?.state ?? 'Not checked'}</p>{sync && <><p>{sync.downloaded} originals · {sync.projected} readable · {sync.pending} pending · {sync.failed} failed</p>{sync.error && <p role="status">{sync.error.replaceAll('_', ' ')}</p>}{sync.unsupportedScopes?.map(value => <p key={value}>Excluded: {value.replaceAll('-', ' ')}</p>)}{Boolean(sync.inaccessible) && <p>{sync.inaccessible} inaccessible items</p>}</>}<div className="mt-2 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => control('start')}>Resume</Button><Button size="sm" variant="outline" onClick={() => control('pause')}>Pause</Button></div></div></>}
      </nav>
      <section aria-label="Messages" className="overflow-auto border-r"><div className="border-b p-3"><h2 className="font-semibold">{thread ? 'Thread' : folder ? folders.find(value => value.id === folder)?.name : inbox ? 'Inbox' : 'All stored mail'}</h2><p className="text-xs text-muted-foreground">Newest received first. Unknown dates last.</p><button className="text-xs underline" onClick={() => setRevision(value => value + 1)}>Newest page</button>{thread && <button className="underline" onClick={() => setThread(undefined)}>Back to messages</button>}</div>
        {!accounts.length && <p className="p-4">No local mail accounts. Connect an account through mail setup first.</p>}{!busy && !items.length && accounts.length > 0 && <p className="p-4">No stored messages in this view. Select an account to check synchronization.</p>}
        {items.map(item => <button key={item.accountId + '|' + item.key} className={`block w-full border-b p-3 text-left hover:bg-muted ${selected?.accountId === item.accountId && selected.key === item.key ? 'bg-muted' : ''}`} onClick={() => setSelected(item)} aria-pressed={selected?.accountId === item.accountId && selected.key === item.key}><span className={item.isRead === false ? 'font-bold' : 'font-medium'}>{item.subject || '(No subject)'}</span>{item.isRead === false && <span className="ml-2 text-xs">Unread</span>}<span className="block truncate text-sm">{item.metadata?.from ?? 'Sender not downloaded'}</span><span className="block text-xs text-muted-foreground">{accounts.find(account => account.id === item.accountId)?.displayName} · {item.receivedAt ? new Date(item.receivedAt).toLocaleString() : 'Received date unavailable'}</span><span className="text-xs">{item.contentState === 'complete' ? 'Available offline' : item.contentState === 'downloading' ? 'Downloading content' : 'Content needs attention'}</span></button>)}
        {busy && <p role="status" className="p-3">Loading stored mail…</p>}{more && <Button className="m-3" variant="outline" disabled={busy} onClick={loadMore}>Next page</Button>}
      </section>
      <section aria-label="Message reader" className="overflow-auto max-lg:col-span-2 max-lg:border-t">{selected && client ? <MailReader key={selected.accountId + '|' + selected.key} client={client} item={selected} account={accounts.find(value => value.id === selected.accountId)?.displayName ?? selected.accountId} onUnavailable={() => { purge(); setError('Mail access changed. Refresh to continue.'); }} onThread={() => { setAccount(selected.accountId); setThread(selected.threadId ?? undefined); }}/> : <p className="p-8 text-muted-foreground">Select a message to read its stored content.</p>}</section>
    </div>}
  </main>;
}
function MailReader({ client, item, account, onThread, onUnavailable }: {
    client: MailClient;
    item: MailMessageView;
    account: string;
    onThread: () => void;
    onUnavailable: () => void;
}) {
    const [parts, setParts] = useState<MailPartView[]>([]), [bodies, setBodies] = useState<{
        contentType: string;
        text: string;
    }[]>([]), [inline, setInline] = useState<ReadonlyMap<string, string>>(new Map()), [error, setError] = useState(''), [busy, setBusy] = useState(true), [plain, setPlain] = useState(false), [preview, setPreview] = useState<{
        name: string;
        text?: string;
        image?: string;
    }>();
    const controller = useRef(new AbortController());
    useEffect(() => { const abort = new AbortController(); controller.current = abort; void (async () => { try {
        const values: MailPartView[] = [];
        let next: string | null = null;
        do {
            const result = await client.parts(item, abort.signal, next ?? undefined);
            values.push(...result.items);
            next = result.nextCursor;
            if (values.length > 2000)
                throw Error('Too many attachments for this reader.');
        } while (next);
        if (abort.signal.aborted)
            return;
        setParts(values);
        const body = values.find(part => part.kind === 'body' && part.bytesAvailable);
        if (body) {
            const bytes = await client.bytes(item, body, abort.signal, 8 * 1024 * 1024);
            const value = bodyEnvelope.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
            if (!abort.signal.aborted)
                setBodies(value.bodies);
        }
        const images = new Map<string, string>();
        let total = 0;
        for (const part of values) {
            if (!part.contentId || !part.bytesAvailable || !part.bytes || part.bytes > 4 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(part.contentType ?? ''))
                continue;
            total += part.bytes;
            if (total > 8 * 1024 * 1024)
                break;
            const bytes = await client.bytes(item, part, abort.signal, 4 * 1024 * 1024);
            const type = rasterType(bytes);
            if (type)
                images.set(part.contentId.replace(/^<|>$/g, ''), dataUrl(bytes, type));
        }
        if (!abort.signal.aborted)
            setInline(images);
    }
    catch (error) {
        if (!abort.signal.aborted)
            setError(textError(error));
    }
    finally {
        if (!abort.signal.aborted)
            setBusy(false);
    } })(); const poll = setInterval(() => void client.check(item, abort.signal).then(current => { if (current.rawReferenceId !== item.rawReferenceId || current.contentState !== item.contentState)
        throw Error('Mail changed'); }).catch(() => { if (!abort.signal.aborted) {
        abort.abort();
        setParts([]);
        setBodies([]);
        setInline(new Map());
        setPreview(undefined);
        onUnavailable();
    } }), 5000); return () => { abort.abort(); clearInterval(poll); void window.__LEGALWORK_ELECTRON__?.mailArtifactCancel?.(); }; }, [client, item.accountId, item.key]);
    async function content(part: MailPartView, save: boolean) { setBusy(true); setError(''); try {
        const native = window.__LEGALWORK_ELECTRON__?.mailArtifact;
        if (native && part.referenceId && (save || part.kind === 'attachment')) {
            await native({ accountId: item.accountId, locator: item.locator, kind: part.kind === 'raw' ? 'raw' : 'attachment', partId: part.partId, referenceId: part.referenceId, operation: save ? 'save' : 'open' });
            return;
        }
        const bytes = await client.bytes(item, part, controller.current.signal);
        if (controller.current.signal.aborted)
            return;
        const name = part.kind === 'raw' ? 'original.eml' : safeFilename(part.filename);
        if (save) {
            saveBytes(bytes, name, part.contentType ?? 'application/octet-stream');
            return;
        }
        const type = rasterType(bytes);
        if (type)
            setPreview({ name, image: dataUrl(bytes, type) });
        else if (part.kind === 'raw' || part.contentType?.startsWith('text/'))
            setPreview({ name, text: new TextDecoder().decode(bytes) });
        else
            setPreview({ name, text: 'This attachment is stored and verified. Use Save to open this file in its desktop application.' });
    }
    catch (error) {
        if (!controller.current.signal.aborted)
            setError(textError(error));
    }
    finally {
        if (!controller.current.signal.aborted)
            setBusy(false);
    } }
    const raw = parts.find(part => part.kind === 'raw'), html = bodies.filter(body => body.contentType === 'text/html'), texts = bodies.filter(body => body.contentType === 'text/plain');
    return <article id="mail-print-root" className="p-5"><style>{`@media print{body *{visibility:hidden}#mail-print-root,#mail-print-root *{visibility:visible}#mail-print-root{position:absolute;inset:0;overflow:visible}#mail-print-root button,#mail-print-root iframe,#mail-print-root>h3,#mail-print-root>ul,#mail-print-root>section,#mail-print-content>:not(.mail-print-copy){display:none}#mail-print-root .mail-print-copy{display:block!important;white-space:pre-wrap}}`}</style><header><p className="text-xs text-muted-foreground">{account}</p><h2 className="text-xl font-semibold break-words">{item.subject || '(No subject)'}</h2><p className="break-words">From: {item.metadata?.from ?? 'Not downloaded'}</p><p className="break-words">To: {item.metadata?.to ?? 'Not downloaded'}</p><p className="text-sm">{item.contentState === 'complete' ? 'Available offline' : 'Content is incomplete. Headers alone are not an offline copy.'}</p><div className="my-3 flex flex-wrap gap-2">{item.threadId && <Button variant="outline" size="sm" onClick={onThread}>Show thread</Button>}<Button size="sm" variant="outline" disabled={!raw?.bytesAvailable || busy} onClick={() => raw && content(raw, false)}>View source</Button><Button size="sm" variant="outline" disabled={!raw?.bytesAvailable || busy} onClick={() => raw && content(raw, true)}>Export original</Button><Button size="sm" variant="outline" disabled={!bodies.length} onClick={() => window.print()}>Print</Button>{html.length > 0 && <Button size="sm" variant="outline" onClick={() => setPlain(value => !value)}>{plain ? 'Show HTML' : 'Plain text'}</Button>}</div></header>
    {error && <p role="alert" className="text-destructive">{error}</p>}{busy && <p role="status">Reading encrypted content…</p>}
    <div id="mail-print-content"><pre className="mail-print-copy" style={{ display: "none" }}>{(texts.length ? texts.map(body => body.text) : html.map(body => new DOMParser().parseFromString(mailHtml(body.text), 'text/html').body.textContent)).join("\n\n")}</pre><p className="my-2 text-xs text-muted-foreground">Scripts, links and external resources are blocked. Only stored inline images are shown.</p>{html.length && !plain ? html.map((body, index) => <iframe key={index} title={`Message HTML ${index + 1}`} sandbox="" referrerPolicy="no-referrer" srcDoc={mailHtml(body.text, inline)} className="w-full min-h-[420px] rounded border bg-white"/>) : texts.length ? texts.map((body, index) => <pre key={index} className="whitespace-pre-wrap break-words font-sans text-sm">{body.text}</pre>) : html.length ? <pre className="whitespace-pre-wrap text-sm">{new DOMParser().parseFromString(mailHtml(html[0].text), 'text/html').body.textContent}</pre> : !busy ? <p>No readable body is stored yet.</p> : null}</div>
    <h3 className="mt-6 font-semibold">Attachments</h3><ul>{parts.filter(part => part.kind === 'attachment').map(part => <li key={part.key} className="flex flex-wrap items-center gap-2 border-b py-3"><span className="min-w-0 flex-1 break-words">{part.filename || 'Unnamed attachment'}<span className="block text-xs">{part.bytesAvailable ? `${part.bytes?.toLocaleString()} bytes · available offline` : part.state === 'pending' ? 'Download pending' : 'Unavailable / inaccessible'}</span></span><Button size="sm" variant="outline" disabled={!part.bytesAvailable || busy} onClick={() => content(part, false)}>Open</Button><Button size="sm" variant="outline" disabled={!part.bytesAvailable || busy} onClick={() => content(part, true)}>Save</Button></li>)}</ul>
    {preview && <section aria-label="Attachment preview" className="mt-4 rounded border p-3"><div className="flex justify-between"><h3 className="font-medium">{preview.name}</h3><Button size="sm" variant="outline" onClick={() => setPreview(undefined)}>Close preview</Button></div>{preview.image ? <img src={preview.image} alt={preview.name} className="max-w-full"/> : <pre className="whitespace-pre-wrap break-words text-sm">{preview.text}</pre>}</section>}
  </article>;
}
