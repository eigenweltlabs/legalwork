import {MailListWindow} from './mail-list-window';
import {MailRowMenu,mailSelectionSignature} from './mail-context-menu';
import {mailSourceTargetSchema} from './mail-chat-source';
import {MailAttachmentChat} from './mail-attachment-chat';
import type {MailChatBridge} from './mail-chat';
import {MailStorageSavePanel} from './mail-storage-save';
import {MailFilingPanel} from './mail-filing';
import {mailKeyboard,mailShortcutProps} from './mail-keyboard';
import {MailKeyboardHelp} from './mail-keyboard-help';
import {MailBackgroundStatus} from './mail-desktop';
import {mailNotificationOpenSchema} from '../../../../../server/src/mail/notification-view';
import {MailActionBar,mailItemId,optimisticMail} from './mail-actions';
import type {ActionEntry} from './mail-actions-client';
import {MailOutbox} from './mail-outbox';
import {MailComposer,MailDrafts,type ComposeSelection} from "./mail-composer";
import {addresses,emptyCompose,replyCompose,type ComposeMode} from "./mail-compose-model";
import {uploadComposeFile} from "./mail-compose-client";
import { mailDocxText } from "../session/artifacts/mail-docx-source";
import { mailPreviewType, openMailPreview } from "../session/artifacts/mail-preview-source";
import {MailSearch} from './mail-search';
/** @jsxImportSource react */
import { useCallback, useEffect, useRef, useState } from 'react';
import { SendHorizontal, Flag, Inbox, Archive, ChevronLeft, ChevronRight, Folder, Mail, Search, RefreshCw, Settings2, FolderPlus, Paperclip, Download, FileText, Printer, MessagesSquare, X, PanelLeft, CircleAlert, Check, Pause, Play, SquarePen, Reply, ReplyAll, Forward } from 'lucide-react';
import './mail-reader.css';
import { Button } from '@/components/ui/button';
import { resolveLegalworkConnection } from '../../shell/legalwork-connection';
import { MailClient, UnifiedMailPages, bodyEnvelope, type MailAccountView, type MailFolderView, type MailMessageView, type MailPartView, type SyncStatus } from './mail-client';
import { useNavigate, useLocation } from 'react-router-dom';
import { MailHtmlParts } from './mail-html-frame';
import { mailHtml, boundedMailRaster, rasterType, safeFilename } from './mail-html';
const accountLabel = (provider: string) => provider === 'gmail' ? 'Google' : provider === 'graph' ? 'Microsoft' : provider==='archive'?'Local archive':'IMAP';
const shortDate = (value?: number | null) => value ? new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '';
const senderName = (value?: string | null) => value?.split('<')[0].trim() || value || 'Sender not downloaded';
const textError = (error: unknown) => error instanceof Error ? error.message : 'Mail is unavailable.';
function dataUrl(bytes: Uint8Array, type: string) { let binary = ''; for (let at = 0; at < bytes.length; at += 8192)
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192)); return `data:${type};base64,${btoa(binary)}`; }
function saveBytes(bytes: Uint8Array<ArrayBuffer>, name: string, type: string) { const url = URL.createObjectURL(new Blob([bytes], { type })); const link = document.createElement('a'); link.href = url; link.download = safeFilename(name); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
export function MailRoute({chatBridge}:{chatBridge?:MailChatBridge}) {
    const [filingOpen,setFilingOpen]=useState(false);const [matterFiling,setMatterFiling]=useState(false);
    const [compose,setCompose]=useState<ComposeSelection>();
    const [draftsOpen,setDraftsOpen]=useState(false);const [outboxOpen,setOutboxOpen]=useState(false);
    const [listWidth,setListWidth]=useState(()=>{try{return Math.max(240,Math.min(480,Number(localStorage.getItem('mail.layout.listWidth'))||330));}catch{return 330;}});
    const resizeList=(width:number)=>{const next=Math.max(240,Math.min(480,width));setListWidth(next);try{localStorage.setItem('mail.layout.listWidth',String(next));}catch{/* Layout preferences are optional. */}};
    const [foldersOpen, setFoldersOpen] = useState(false);
    const [searchTargets,setSearchTargets]=useState<MailMessageView[]>([]),[searchPending,setSearchPending]=useState(false);
    const updateSearchTargets=useCallback((items:MailMessageView[],pending=false)=>{setSearchTargets(items);setSearchPending(pending);},[]);
    const listScroll=useRef<HTMLDivElement>(null);
    const showWindow=(rows:MailMessageView[])=>{setItems(rows);const top=listWindow.current.scroll;requestAnimationFrame(()=>{if(listScroll.current)listScroll.current.scrollTop=top;});};
    const listWindow=useRef(new MailListWindow<MailMessageView>());
    const [newerAvailable,setNewerAvailable]=useState(false);
    const [selecting,setSelecting]=useState(false);
    const selectionAnchor=useRef<string|undefined>(undefined);
    const [checked,setChecked]=useState<Set<string>>(new Set());
    const [actionEntries,setActionEntries]=useState<ActionEntry[]>([]);
    const [actionPulse,setActionPulse]=useState(0);
    const navigate = useNavigate(),location=useLocation();
    const notificationOpened=useRef<unknown>(null);

    const openSettings = () => navigate('/settings/mail-accounts', { state: { from: '/mail' } });
    const [searchQuery, setSearchQuery] = useState('');
    const [savedSearchName, setSavedSearchName] = useState('');
    const searching = Boolean(searchQuery.trim() || savedSearchName);
    const setSearching = (value: boolean) => { if (!value) { setSearchQuery(''); setSavedSearchName(''); } };
    const [client, setClient] = useState<MailClient>();
    const [accounts, setAccounts] = useState<MailAccountView[]>([]);
    const [account, setAccount] = useState('');
    const [folders, setFolders] = useState<MailFolderView[]>([]);
    const [folder, setFolder] = useState('');
    useEffect(()=>{setChecked(new Set());setSearchTargets([]);},[account,folder,searchQuery,savedSearchName]);
    const [inbox, setInbox] = useState(true);
    const [items, setItems] = useState<MailMessageView[]>([]);
    const [selected, setSelected] = useState<MailMessageView>();
    const [thread, setThread] = useState<string>();
    const [error, setError] = useState('');
    const [locked, setLocked] = useState(true);
    useEffect(()=>{
      if(!client||locked)return;const state=location.state;if(!state||typeof state!=='object')return;
      const source=mailSourceTargetSchema.safeParse(Reflect.get(state,'mailSourceTarget'));
      const notification=mailNotificationOpenSchema.safeParse(Reflect.get(state,'mailNotificationTarget'));
      if(!source.success&&!notification.success)return;
      const raw=source.success?Reflect.get(state,'mailSourceTarget'):Reflect.get(state,'mailNotificationTarget');if(notificationOpened.current===raw)return;
      if(!source.success&&notification.success&&new URL(connectionIdentity.current.split('\n')[0]).origin!==notification.data.serverOrigin){setError('Open the local server connection in Settings to view this email.');return;}
      const target=source.success?source.data:notification.success?notification.data:null;if(!target)return;
      const controller=new AbortController();void(async()=>{
        const message=await client.readLocator(target.accountId,target.locator,controller.signal);if(message.removed)throw Error('Source removed');
        if(source.success){let after:string|undefined,found=false;for(let page=0;page<20;page++){const parts=await client.parts(message,controller.signal,after);if(parts.items.some(part=>part.kind==='attachment'&&part.referenceId===source.data.referenceId&&part.sha256===source.data.sha256&&part.bytesAvailable)){found=true;break;}after=parts.nextCursor??undefined;if(!after)break;}if(!found)throw Error('Source changed');}
        if(controller.signal.aborted)return;notificationOpened.current=raw;setSelected(message);setError('');setCompose(undefined);setDraftsOpen(false);setOutboxOpen(false);
        requestAnimationFrame(()=>{if(!controller.signal.aborted)document.getElementById('mail-print-root')?.focus();});
      })().catch(()=>{if(!controller.signal.aborted)setError('The source email is unavailable or changed. The copied workspace file remains available. Review the account connection in Settings.');});return()=>controller.abort();
    },[client,locked,location.state]);
    useEffect(()=>{if(locked){setCompose(undefined);setDraftsOpen(false);setOutboxOpen(false);}},[locked]);
    useEffect(()=>{setFilingOpen(false);setCompose(undefined);setDraftsOpen(false);setOutboxOpen(false);},[client]);
    const [busy, setBusy] = useState(false);
    const [revision, setRevision] = useState(0);
    const [connectionRevision, setConnectionRevision] = useState(0);
    const connectionIdentity = useRef('');
    const [more, setMore] = useState(false);
    const [sync, setSync] = useState<SyncStatus>();
    const [accountSync, setAccountSync] = useState<Record<string, SyncStatus>>({});
    const messageRequest = useRef(0);
    const pager = useRef<UnifiedMailPages | undefined>(undefined);
    const request = useRef(new AbortController());
    const purge = () => { messageRequest.current++; request.current.abort(); request.current = new AbortController(); pager.current = undefined; listWindow.current.reset();setNewerAvailable(false);setItems([]); setSelected(undefined); setSync(undefined); setMore(false); };
    useEffect(() => {
        const controller = new AbortController();
        void resolveLegalworkConnection().then(connection => {
            if (controller.signal.aborted) return;
            if (!connection.normalizedBaseUrl) return;
            const identity = connection.normalizedBaseUrl + '\n' + connection.resolvedHostToken;
            if (connectionIdentity.current !== identity) {
                connectionIdentity.current = identity;
                setClient(new MailClient(connection.normalizedBaseUrl, connection.resolvedHostToken));
                setError('');
            }
        }).catch(error => { if (!controller.signal.aborted) setError(textError(error)); });
        return () => controller.abort();
    }, [connectionRevision]);
    useEffect(() => {
        const changed = () => setConnectionRevision(value => value + 1);
        window.addEventListener('legalwork-server-settings-changed', changed);
        return () => window.removeEventListener('legalwork-server-settings-changed', changed);
    }, []);
    useEffect(() => { if (!client)
        return; const controller = new AbortController(); void (async () => { try {
        let status = await client.status(controller.signal);
        if (status.state !== 'ready') status = await client.unlock(controller.signal);
        if (status.state !== 'ready') throw Error('Mail could not be opened. Please retry.');
        if (controller.signal.aborted) return;
        let next: string | null = null;
        const result: MailAccountView[] = [];
        do {
            const page = await client.accounts(controller.signal, next ?? undefined);
            result.push(...page.items);
            next = page.nextCursor;
            if (result.length > 500)
                throw Error('Too many accounts for this reader.');
        } while (next);
        if (!controller.signal.aborted) {
            setAccounts(result); setLocked(false);
        }
    }
    catch (error) {
        if (!controller.signal.aborted)
            { setLocked(true); setError(textError(error)); }
    } })(); return () => controller.abort(); }, [client, revision]);
    useEffect(()=>{if(!client)return;const controller=new AbortController();let busy=false;const poll=setInterval(()=>{if(busy)return;busy=true;void client.status(controller.signal).then(status=>{if(controller.signal.aborted)return;if(status.state==='ready'&&locked){setError('');setRevision(value=>value+1);}else if(status.state!=='ready'&&!locked){purge();setLocked(true);setAccounts([]);setError('Mail is reconnecting. Local drafts remain saved.');}}).catch(()=>{if(!controller.signal.aborted&&!locked){purge();setLocked(true);setError('Mail connection is unavailable. Check the local server in Settings.');}}).finally(()=>{busy=false;});},3000);return()=>{clearInterval(poll);controller.abort();};},[client,locked]);
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
    useEffect(() => { if (searching) { request.current.abort(); pager.current = undefined; setBusy(false); return; } purge(); if (!client || locked || !accounts.length)
        return; const controller = request.current; const signal = controller.signal; const stream = new UnifiedMailPages(client, account ? accounts.filter(item => item.id === account) : accounts, folder || undefined, thread, inbox && !thread && !folder); pager.current = stream; const version = ++messageRequest.current; setBusy(true); setError(''); void stream.next(signal).then(rows => { if (!signal.aborted && version === messageRequest.current) {
        setItems(listWindow.current.reset(rows));
        setMore(stream.hasMore);
        if (stream.exclusions.length)
            setError(stream.exclusions.map(value => `${accounts.find(account => account.id === value.accountId)?.displayName ?? value.accountId}: ${value.reason}`).join(" · "));
    } }).catch(error => { if (!signal.aborted)
        setError(textError(error)); }).finally(() => { if (!signal.aborted)
        setBusy(false); }); return () => controller.abort(); }, [client, accounts, account, folder, thread, inbox, locked, revision, searching]);
    async function loadMore() { if(busy)return;listWindow.current.scroll=listScroll.current?.scrollTop??0;if(listWindow.current.canForward){showWindow(listWindow.current.forward());return;}const signal = request.current.signal, stream = pager.current; if (!stream)
        return; const version = ++messageRequest.current; setBusy(true); try {
        const rows = await stream.next(signal);
        if (!signal.aborted && version === messageRequest.current) {
            showWindow(listWindow.current.append(rows));
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
    useEffect(() => {
        if (!client || locked || !accounts.length) return;
        const abort = new AbortController();
        let pending = false;
        let previous = '';
        const poll = async () => {
            if (pending) return;
            pending = true;
            try {
                const visible = account ? accounts.filter(value => value.id === account) : accounts;
                const entries = await Promise.all(visible.map(async (value): Promise<[string, SyncStatus]> => {
                    try { return [value.id, await client.sync(value.id, abort.signal)]; }
                    catch { return [value.id, {state: 'attention', enumerated: 0, downloaded: 0, projected: 0, failed: 0, pending: 0, error: 'account_unavailable'}]; }
                }));
                if (abort.signal.aborted) return;
                const statuses = Object.fromEntries(entries);
                setAccountSync(statuses);
                setSync(account ? statuses[account] : undefined);
                const cursors=await Promise.all(visible.map(value=>client.changeCursor(value.id,abort.signal).catch(()=>null)));
                if(abort.signal.aborted)return;
                const signature = JSON.stringify([entries.map(([id, value]) => [id, value.projected, value.downloaded, value.state]),cursors]);
                if (signature !== previous && !searching && previous && listWindow.current.expanded) { setNewerAvailable(true); }
                if (signature !== previous && !searching && !listWindow.current.expanded) {
                    const stream = new UnifiedMailPages(client, visible, folder || undefined, thread, inbox && !thread && !folder);
                    const version = ++messageRequest.current;
                    const rows = await stream.next(abort.signal);
                    if (abort.signal.aborted || version !== messageRequest.current) return;
                    pager.current = stream;
                    setItems(listWindow.current.reset(rows));
                    setSelected(current=>current?(rows.find(item=>mailItemId(item)===mailItemId(current))??current):current);
                    setMore(stream.hasMore);
                    if (account) {
                        const collected: MailFolderView[] = [];
                        let next: string | undefined;
                        do {
                            const page = await client.folders(account, abort.signal, next);
                            collected.push(...page.items); next = page.nextCursor ?? undefined;
                        } while (next && collected.length <= 2000);
                        if (!abort.signal.aborted) setFolders(collected);
                    }
                }
                previous = signature;
            } catch (error) { if (!abort.signal.aborted) setError(textError(error)); }
            finally { pending = false; }
        };
        void poll();
        const timer = setInterval(() => void poll(), 3000);
        return () => { abort.abort(); clearInterval(timer); };
    }, [client, accounts, account, locked, folder, thread, inbox, searching,actionPulse]);
    async function control(operation: 'start' | 'pause', accountId = account) { if (!client || !accountId)
        return; const signal = request.current.signal; try {
        const status = await client.sync(accountId, signal, operation);
        if (!signal.aborted) { setAccountSync(values => ({...values, [accountId]: status})); if (accountId === account) setSync(status); }
    }
    catch (error) {
        if (!signal.aborted) setError(textError(error));
    } }
    const title = thread ? 'Conversation' : folder ? folders.find(value => value.id === folder)?.name ?? folder : inbox ? 'Inbox' : 'All mail';
    const refresh = () => { purge(); setConnectionRevision(value => value + 1); setRevision(value => value + 1); };
    const actionTargets=(searching&&(searchTargets.length||searchPending)?searchTargets:checked.size?items.filter(item=>checked.has(mailItemId(item))):selected?[selected]:[]).map(item=>optimisticMail(item,actionEntries));
    const composeReturn=useRef<HTMLElement|null>(null),mailRoot=useRef<HTMLElement|null>(null);
    const closeCompose=()=>{setCompose(undefined);requestAnimationFrame(()=>{const target=composeReturn.current;if(target?.isConnected)target.focus();else mailRoot.current?.querySelector<HTMLButtonElement>('.mail-message-row[aria-pressed="true"],.mail-message-row')?.focus();});};
    const openCompose=(value:ComposeSelection)=>{if(!compose&&document.activeElement instanceof HTMLElement)composeReturn.current=document.activeElement;setCompose(value);setDraftsOpen(false);setOutboxOpen(false);};
    const reader = filingOpen&&client ? (matterFiling?<MailFilingPanel client={client} accountIds={account?[account]:accounts.map(value=>value.id)} message={selected} onClose={()=>setFilingOpen(false)}/>:<MailStorageSavePanel client={client} accountIds={account?[account]:accounts.map(value=>value.id)} message={selected} onClose={()=>setFilingOpen(false)} onMatter={()=>setMatterFiling(true)}/>) : compose&&client ? <MailComposer key={compose.account+compose.id} client={client} accounts={accounts.filter(value=>value.provider!=='archive')} initial={compose} onClose={closeCompose} onSwitch={openCompose} onQueued={()=>{setCompose(undefined);setOutboxOpen(true);}}/> : outboxOpen&&client ? <MailOutbox client={client} accounts={accounts.filter(value=>value.provider!=='archive')} onClose={()=>setOutboxOpen(false)}/> : draftsOpen&&client ? <MailDrafts client={client} accounts={accounts.filter(value=>value.provider!=='archive')} onOpen={openCompose} onClose={()=>setDraftsOpen(false)}/> : selected && client ? <MailReader key={selected.accountId + '|' + selected.key} client={client} item={selected} chatBridge={chatBridge}
      onCompose={openCompose}
      account={accounts.find(value => value.id === selected.accountId)?.displayName ?? selected.accountId}
      onUnavailable={() => { purge(); setError('Mail access changed. Please refresh.'); }}
      onThread={() => { setSearching(false); setAccount(selected.accountId); setThread(selected.threadId ?? undefined); }}/>
      : <div className="mail-empty"><div className="mail-empty-icon"><Mail size={26} strokeWidth={1.3}/></div><h2>Select a message</h2><p>Conversations and attachments.<br/>Available wherever you work.</p></div>;
    return (
      <main ref={mailRoot} tabIndex={-1} className="mail-workspace" data-mail-selecting={selecting||checked.size>0||searchTargets.length>1} data-mail-selection={mailSelectionSignature(actionTargets)} data-mail-reader={JSON.stringify([selected?.accountId,selected?.key,compose?.id,filingOpen,draftsOpen,outboxOpen])} aria-label="Local mail" onKeyDown={event=>mailKeyboard(event.nativeEvent,event.currentTarget,{showFolders:()=>setFoldersOpen(true)})}>
        <header className="mail-toolbar">
          <button className="mail-icon-button mail-folder-toggle" aria-label="Toggle mail folders" onClick={() => setFoldersOpen(value => !value)}><PanelLeft size={17}/></button>
          <h1>Mail</h1><button className="mail-icon-button" aria-label="Save mail to connected storage" title="Save mail / retained originals" disabled={!client||locked} onClick={()=>{setMatterFiling(false);setFilingOpen(true);}}><FolderPlus size={15}/></button><MailBackgroundStatus/><MailKeyboardHelp/>
          <div className="mail-toolbar-actions">
            <button className="mail-icon-button" {...mailShortcutProps('compose','Compose')} aria-label="Compose" disabled={locked||!accounts.some(value=>value.provider!=='archive')||!!compose} onClick={()=>{const selectedAccount=accounts.find(value=>value.id===account&&value.provider!=='archive')??accounts.find(value=>value.provider!=='archive');if(!selectedAccount)return;openCompose({account:selectedAccount.id,id:crypto.randomUUID(),version:null,content:emptyCompose(selectedAccount.identity?.address??addresses(selectedAccount.displayName)[0]??'')});}}><SquarePen size={16}/></button>
            <button className="mail-icon-button" title="Outbox" aria-label="Open outbox" disabled={locked||!!compose} onClick={()=>{setDraftsOpen(false);setOutboxOpen(true);}}><SendHorizontal size={16}/></button>
            <button className="mail-icon-button" title="Drafts" aria-label="Open drafts" disabled={locked||!!compose} onClick={()=>{setOutboxOpen(false);setDraftsOpen(true);}}><FileText size={16}/></button>
            <label className="mail-toolbar-search"><Search size={15}/><input {...mailShortcutProps('search','Search mail')} aria-label="Search mail" placeholder={savedSearchName ? `Saved: ${savedSearchName}` : 'Search'} disabled={locked} value={searchQuery} onChange={event => { setSearchQuery(event.target.value); setSavedSearchName(''); }}/>{searching && <button aria-label="Clear search" onClick={() => setSearching(false)}><X size={13}/></button>}</label>
            <button className="mail-icon-button" title="Refresh mail" aria-label="Refresh mail" onClick={refresh}><RefreshCw size={16}/></button>
            <button className="mail-icon-button" title="Mail accounts" aria-label="Mail accounts" onClick={openSettings}><Settings2 size={17}/></button>
          </div>
        </header>

        {error && <div role="alert" className="mail-notice"><CircleAlert size={15}/><span>{error}</span><button aria-label="Dismiss message" onClick={() => setError('')}><X size={14}/></button></div>}
        {!locked&&client&&!actionTargets.some(item=>item.locator.provider==='archive')&&<MailActionBar reading={!searching&&checked.size===0&&!!selected} blocked={searching&&searchPending} client={client} accounts={accounts} accountId={account} selected={actionTargets} folder={folders.find(item=>item.id===folder)} folders={folders} onEntries={setActionEntries} onRefresh={()=>setActionPulse(value=>value+1)}/>}
        {locked ? <div className="mail-empty"><div className="mail-empty-icon"><Mail size={24}/></div><h2 role="status">{error ? 'Mail is unavailable' : 'Opening your mail…'}</h2>{error && <Button variant="outline" size="sm" onClick={refresh}>Try again</Button>}</div>
          : <div className={`mail-grid ${selected||compose||draftsOpen||outboxOpen ? 'has-selection' : ''} ${foldersOpen ? 'folders-open' : ''}`}>
            <nav tabIndex={-1} aria-label="Mail accounts and folders" className="mail-folders">
              <div className="mail-nav-caption">Mailboxes</div>
              <button className={`mail-nav-row ${!account && inbox ? 'is-active' : ''}`} onClick={() => { setSearching(false); setThread(undefined); setFolder(''); setInbox(true); setAccount(''); setFoldersOpen(false); }}><Inbox size={16}/><span>Inbox</span></button>
              <button className={`mail-nav-row ${!account && !inbox ? 'is-active' : ''}`} onClick={() => { setSearching(false); setThread(undefined); setFolder(''); setInbox(false); setAccount(''); setFoldersOpen(false); }}><Archive size={16}/><span>All mail</span></button>
              <div className="mail-nav-caption mail-account-caption">Accounts</div>
              {accounts.map(value => <div key={value.id}><button className={`mail-nav-row mail-account-row ${account === value.id ? 'is-active' : ''}`} onClick={() => { setSearching(false); setThread(undefined); setAccount(value.id); if(value.provider==='archive')setInbox(false); }}><span className="mail-account-dot">{value.displayName.slice(0, 1).toUpperCase()}</span><span><span className="mail-account-name">{senderName(value.displayName)}</span><small title={value.displayName}>{accountLabel(value.provider)}</small></span></button>{account === value.id && <div className="mail-account-folders">{folders.map(folderEntry => <button key={folderEntry.id} className={`mail-nav-row ${folder === folderEntry.id ? 'is-active' : ''}`} title={folderEntry.name} onClick={() => { setSearching(false); setThread(undefined); setFolder(folderEntry.id); setFoldersOpen(false); }}>{folderEntry.role === 'inbox' ? <Inbox size={15}/> : <Folder size={15}/>}<span>{folderEntry.name}</span></button>)}</div>}</div>)}
              {!accounts.length && <button className="mail-nav-row" onClick={openSettings}><Mail size={15}/><span>Add an account</span></button>}
              {account && <>
                
                <button className={`mail-nav-row ${!folder ? 'is-active' : ''}`} onClick={() => { setInbox(false); setFolder(''); setThread(undefined); }}><Archive size={15}/><span>All mail</span></button>

                <details className="mail-sync-details"><summary><span className={`mail-sync-dot ${sync?.failed ? 'needs-attention' : ''}`}/>{sync?.state === 'syncing' ? 'Downloading mail' : sync?.failed ? 'Needs attention' : 'Sync details'}</summary>
                  <p>{sync?.projected ?? 0} available offline · {sync?.pending ?? 0} pending</p>
                  {sync?.error && <p>{sync.error.replaceAll('_', ' ')}</p>}{sync?.unsupportedScopes?.map(value => <p key={value}>Not included: {value.replaceAll('-', ' ')}</p>)}
                  {Boolean(sync?.inaccessible) && <p>{sync?.inaccessible} items unavailable</p>}
                  <div><button onClick={() => control('start')}><Play size={12}/>Resume</button><button onClick={() => control('pause')}><Pause size={12}/>Pause</button></div>
                </details>
              </>}
            </nav>
            <section tabIndex={-1} aria-label="Messages" className="mail-message-list" style={{width:listWidth}}><div className="mail-pane-resize" role="separator" aria-label="Message list width" aria-orientation="vertical" aria-valuemin={240} aria-valuemax={480} aria-valuenow={listWidth} tabIndex={0} onDoubleClick={()=>resizeList(330)} onKeyDown={event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();event.stopPropagation();resizeList(listWidth+(event.key==='ArrowRight'?20:-20));}}} onPointerDown={event=>{event.currentTarget.setPointerCapture(event.pointerId);event.currentTarget.dataset.origin=String(event.clientX-listWidth);}} onPointerMove={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))resizeList(event.clientX-Number(event.currentTarget.dataset.origin));}} onPointerUp={event=>{if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}/>
              {searching && client ? <MailSearch client={client} accounts={accounts} toolbarQuery={searchQuery.trim()} onSavedQuery={(text, name) => { setSearchQuery(text); setSavedSearchName(name); }} onOpen={setSelected} onTargets={updateSearchTargets}/> : <>
              <div className="mail-list-heading"><button className="mail-icon-button" aria-label="Select messages" aria-pressed={selecting} title="Select messages · use Ctrl or Command click for multiple messages" onClick={()=>{setSelecting(value=>!value);setChecked(new Set());}}><Check size={15}/></button><input type="checkbox" aria-label="Select all messages on this page" checked={items.length>0&&items.every(item=>checked.has(mailItemId(item)))} onChange={event=>setChecked(event.target.checked?new Set(items.map(mailItemId)):new Set())}/><div><h2>{title}</h2><p>{account ? accounts.find(value => value.id === account)?.displayName : 'All accounts'}</p></div><button className="mail-icon-button" title="Newest messages" aria-label="Newest messages" onClick={() => setRevision(value => value + 1)}><RefreshCw size={14}/></button></div>
              {accounts.filter(value => !account || value.id === account).map(value => {
                const progress = accountSync[value.id];
                if(value.provider==='archive')return <div key={value.id} role="status" className="mail-sync-progress"><span>Local archive · {progress?.projected??0} messages readable offline</span>{progress&&progress.state!=='complete'&&<button onClick={openSettings}>View import progress</button>}</div>;
                if (!progress || progress.state === 'complete') return null;
                const attention = progress.state === 'attention' || Boolean(progress.error);
                return <div key={value.id} role="status" className="mail-sync-progress">
                  <span>{value.displayName}: {progress.state === 'syncing' ? 'Downloading mail' : progress.state === 'waiting' ? progress.error === 'rate_limited' ? 'Waiting for provider rate limit' : 'Waiting to retry — connection unavailable' : progress.state === 'paused' ? 'Sync paused' : attention ? 'Sync needs attention' : 'Preparing sync'} · {progress.projected} messages available</span>
                  {progress.error && <span>{progress.error.replaceAll('_', ' ')}</span>}
                  {(attention || progress.state === 'waiting' || progress.state === 'paused' || progress.state === 'idle') && <button onClick={() => control('start', value.id)}>{progress.state === 'paused' ? 'Resume' : 'Retry sync'}</button>}
                  {(progress.error?.includes('auth') || progress.error?.includes('reconsent') || progress.error?.includes('credential') || progress.error === 'account_unavailable') && <button onClick={openSettings}>Reconnect account</button>}
                </div>;
              })}
              {thread && <button className="mail-back" onClick={() => setThread(undefined)}><ChevronLeft size={14}/>Back to inbox</button>}
              <div ref={listScroll} className="mail-message-scroll" aria-label="Message navigation: Up and Down browse, Enter opens">
                {items.map(observed => {const value=optimisticMail(observed,actionEntries);return <MailRowMenu key={mailItemId(value)} prepare={()=>{const targets=checked.has(mailItemId(value))?items.filter(item=>checked.has(mailItemId(item))):[value];if(!checked.has(mailItemId(value)))setChecked(new Set([mailItemId(value)]));if(targets.length===1)setSelected(value);return{signature:mailSelectionSignature(targets),count:targets.length,archive:targets.some(item=>item.locator.provider==='archive'),mixed:targets.some(item=>item.accountId!==targets[0].accountId)};}} onOpen={()=>{setSelected(value);setCompose(undefined);setFilingOpen(false);setDraftsOpen(false);setOutboxOpen(false);}}><div className="mail-message-select-row"><input type="checkbox" aria-label={`Select ${value.subject||'message'}`} checked={checked.has(mailItemId(value))} onChange={event=>{const enabled=event.target.checked;setChecked(current=>{const next=new Set(current);if(enabled)next.add(mailItemId(value));else next.delete(mailItemId(value));return next;});}}/><button className={`mail-message-row ${selected?.accountId === value.accountId && selected.key === value.key ? 'is-selected' : ''} ${value.isRead === false ? 'is-unread' : ''}`} tabIndex={items.some(item=>item.accountId===selected?.accountId&&item.key===selected?.key)?selected?.accountId===value.accountId&&selected.key===value.key?0:-1:items[0]?.accountId===value.accountId&&items[0]?.key===value.key?0:-1} onClick={event => {const id=mailItemId(value),anchor=selectionAnchor.current;if(event.metaKey||event.ctrlKey||event.shiftKey){setChecked(current=>{const next=new Set(current);if(event.shiftKey&&anchor){const from=items.findIndex(item=>mailItemId(item)===anchor),to=items.findIndex(item=>mailItemId(item)===id);if(from>=0)items.slice(Math.min(from,to),Math.max(from,to)+1).forEach(item=>next.add(mailItemId(item)));else next.add(id);}else if(next.has(id))next.delete(id);else next.add(id);return next;});}else setSelected(value);selectionAnchor.current=id;}} aria-pressed={selected?.accountId === value.accountId && selected.key === value.key}>
                  <span className="mail-row-top"><span className="mail-sender">{senderName(value.metadata?.from)}</span><span className="mail-row-context">{!account&&<span className="mail-row-account" title={accounts.find(entry=>entry.id===value.accountId)?.displayName}>{senderName(accounts.find(entry=>entry.id===value.accountId)?.displayName)}</span>}<time>{shortDate(value.receivedAt)}</time></span></span>
                  <span className="mail-row-subject">{value.isRead === false && <span className="mail-unread-dot" aria-label="Unread"/>}{value.isFlagged&&<Flag size={11} aria-label="Flagged"/>}{value.subject || '(No subject)'}</span>
                  <span className="mail-row-bottom">{value.contentState !== 'complete' && <span title={value.contentState === 'downloading' ? 'Content is downloading' : 'Content is unavailable'}><CircleAlert size={12}/></span>}</span>
                </button></div></MailRowMenu>})}
                {!busy && !items.length && <div className="mail-list-empty"><Inbox size={25} strokeWidth={1.2}/><p>{accounts.length ? 'No messages here yet' : 'Your inbox starts here'}</p><small>{accounts.length ? 'Messages will appear here as they download.' : 'Add an account to bring your mail together.'}</small>{!accounts.length && <Button size="sm" variant="outline" onClick={openSettings}>Add account</Button>}</div>}
                {busy && <p role="status" className="mail-loading">Loading messages…</p>}
              </div>
              <div className="mail-pagination"><button disabled={busy||!listWindow.current.canBack} onClick={()=>{listWindow.current.scroll=listScroll.current?.scrollTop??0;showWindow(listWindow.current.back());}}><ChevronLeft size={14}/>Back</button><span role="status">{items.length} shown{newerAvailable?' · New mail available':''}</span><button disabled={busy||(!more&&!listWindow.current.canForward)} onClick={loadMore}>{listWindow.current.canForward||items.length>=250?'Older messages':'Load more'}<ChevronRight size={14}/></button></div>
              </>}
            </section>
            <section tabIndex={-1} aria-label="Message reader" className="mail-reader-pane">{selected && <button className="mail-back" onClick={() => setSelected(undefined)}><ChevronLeft size={15}/>Inbox</button>}{reader}</section>
          </div>}
      </main>
    );
}

function MailReader({ chatBridge, client, item, account, onThread, onUnavailable, onCompose }: {
    chatBridge?:MailChatBridge;
    client: MailClient;
    item: MailMessageView;
    account: string;
    onThread: () => void;
    onUnavailable: () => void;
    onCompose:(value:ComposeSelection)=>void;
}) {
    const [parts, setParts] = useState<MailPartView[]>([]), [bodies, setBodies] = useState<{
        contentType: string;
        text: string;
        presentation?: boolean;
    }[]>([]), [inline, setInline] = useState<ReadonlyMap<string, string>>(new Map()), [error, setError] = useState(''), [busy, setBusy] = useState(true), [plain, setPlain] = useState(false);
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
            const type = boundedMailRaster(bytes);
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
        onUnavailable();
    } }), 5000); return () => { abort.abort(); clearInterval(poll); void window.__LEGALWORK_ELECTRON__?.mailArtifactCancel?.(); }; }, [client, item.accountId, item.key]);
    async function content(part: MailPartView, save: boolean) { const signal = controller.current.signal; setBusy(true); setError(''); try {
        const name = part.kind === 'raw' ? 'original.eml' : safeFilename(part.filename);
        const previewType = mailPreviewType(name);
        if (!save && previewType) {
            let bytes = await client.bytes(item, part, signal);
            if (previewType === 'word') bytes = await mailDocxText(bytes, signal);
            const validate = async () => {
                const current = await client.check(item, signal);
                if (current.rawReferenceId !== item.rawReferenceId || current.contentState !== item.contentState) throw Error('Mail changed. Reload the message.');
                let after: string | undefined;
                for (let page = 0; page < 20; page++) {
                    const result = await client.parts(item, signal, after);
                    if (result.items.some(value => value.kind === part.kind && value.partId === part.partId && value.referenceId === part.referenceId && value.sha256 === part.sha256 && value.bytesAvailable)) return;
                    if (!result.nextCursor) break;
                    after = result.nextCursor;
                }
                throw Error('Attachment changed. Reload the message.');
            };
            await validate();
            if (signal.aborted) return;
            const imageType = rasterType(bytes);
            if (previewType === 'image' && !imageType) throw Error('This image cannot be previewed safely. Use Save instead.');
            if (previewType === 'pdf' && new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') throw Error('This file is not a PDF. Use Save instead.');
            openMailPreview({ name, bytes, type: previewType, mime: previewType === 'pdf' ? 'application/pdf' : imageType ?? 'text/plain' }, signal, validate);
            return;
        }
        if (!save) throw Error('Internal preview is unavailable for this attachment. Use Save to open a copy in another application.');
        const native = window.__LEGALWORK_ELECTRON__?.mailArtifact;
        if (native && part.referenceId) {
            await native({ accountId: item.accountId, locator: item.locator, kind: part.kind === 'raw' ? 'raw' : 'attachment', partId: part.partId, referenceId: part.referenceId, operation: 'save' });
            return;
        }
        const bytes = await client.bytes(item, part, signal);
        if (!signal.aborted) saveBytes(bytes, name, part.contentType ?? 'application/octet-stream');
    }
    catch (error) {
        if (!signal.aborted)
            setError(textError(error));
    }
    finally {
        if (!signal.aborted)
            setBusy(false);
    } }
    const raw = parts.find(part => part.kind === 'raw'), html = bodies.filter(body => body.contentType === 'text/html' && body.presentation !== false), texts = bodies.filter(body => body.contentType === 'text/plain' && body.presentation !== false);
    async function composeMessage(mode:ComposeMode){setBusy(true);try{
      const text=(texts.length?texts.map(body=>body.text):html.map(body=>new DOMParser().parseFromString(mailHtml(body.text),'text/html').body.textContent??'')).join('\n\n');
      let references:string[]=[];let original:Uint8Array<ArrayBuffer>|undefined;
      if(raw?.bytesAvailable&&mode!=='forward'){original=await client.bytes(item,raw,controller.current.signal,(mode==='forward-attachment'?10:64)*1024*1024);const headers=new TextDecoder().decode(original).split(/\r?\n\r?\n/,1)[0].replace(/\r?\n[ \t]+/g,' ');references=headers.match(/^References:[ \t]*(.*)$/im)?.[1].match(/<[^<>\s@]+@[^<>\s@]+>/g)??[];}
      const content=replyCompose(item,text,mode,addresses(account)[0]??'',references);
      if(mode==='forward-attachment'){if(!original)throw Error('Download the original message before forwarding it as an attachment.');content.attachments=[await uploadComposeFile(client,item.accountId,new File([original],(item.subject||'message').slice(0,100)+'.eml',{type:'message/rfc822'}))];}
      else if(mode==='forward'){if(parts.some(part=>part.kind==='attachment'&&!part.bytesAvailable))throw Error('Download the attachments before forwarding this message.');content.attachments=parts.filter(part=>part.kind==='attachment'&&part.bytesAvailable&&part.referenceId).map(part=>({locator:item.locator,partId:part.partId,referenceId:part.referenceId!,bytes:part.bytes??undefined,filename:part.filename||'attachment',contentType:part.contentType||'application/octet-stream',contentId:null,disposition:'attachment'}));}
      onCompose({account:item.accountId,id:crypto.randomUUID(),version:null,content});
    }catch(error){setError(textError(error));}finally{setBusy(false);}}
    return (
      <article id="mail-print-root" className="mail-message" tabIndex={-1}>
        <style>{`@media print{body *{visibility:hidden}#mail-print-root,#mail-print-root *{visibility:visible}#mail-print-root{position:absolute;inset:0;overflow:visible}#mail-print-root button,#mail-print-root iframe,#mail-print-root .mail-message-actions,#mail-print-root .mail-attachments,#mail-print-root>section,#mail-print-content>:not(.mail-print-copy){display:none}#mail-print-root .mail-print-copy{display:block!important;white-space:pre-wrap}}`}</style>
        <div className="mail-message-actions">
          <button {...mailShortcutProps('reply','Reply')} aria-label="Reply" disabled={busy||!bodies.length||item.locator.provider==='archive'} onClick={()=>void composeMessage('reply')}><Reply size={15}/></button>
          <button {...mailShortcutProps('replyAll','Reply all')} aria-label="Reply all" disabled={busy||!bodies.length||item.locator.provider==='archive'} onClick={()=>void composeMessage('reply-all')}><ReplyAll size={15}/></button>
          <button {...mailShortcutProps('forward','Forward')} aria-label="Forward" disabled={busy||!bodies.length||item.locator.provider==='archive'} onClick={()=>void composeMessage('forward')}><Forward size={15}/></button>
          <button title="Forward as attached message" aria-label="Forward as attached message" disabled={busy||!raw?.bytesAvailable||item.locator.provider==='archive'} onClick={()=>void composeMessage('forward-attachment')}><Paperclip size={15}/></button>
          {item.threadId && <button title="View conversation" onClick={onThread}><MessagesSquare size={15}/><span>Conversation</span></button>}
          <div/>
          <button title="View original source" aria-label="View source" disabled={!raw?.bytesAvailable || busy} onClick={() => raw && content(raw, false)}><FileText size={15}/></button>
          <button title="Export original message" aria-label="Export original" disabled={!raw?.bytesAvailable || busy} onClick={() => raw && content(raw, true)}><Download size={15}/></button>
          <button title="Print message" aria-label="Print" disabled={!bodies.length} onClick={() => window.print()}><Printer size={15}/></button>
        </div>
        <header className="mail-message-header" title={`Account: ${account}`}>
          <h2>{item.subject || '(No subject)'}</h2>
          <div className="mail-correspondent"><span className="mail-avatar">{senderName(item.metadata?.from).slice(0, 1).toUpperCase()}</span><div><p>{item.metadata?.from ?? 'Sender not downloaded'}</p><small>To: {item.metadata?.to ?? 'Not downloaded'}</small></div><time>{shortDate(item.receivedAt)}</time></div>
          {item.contentState !== 'complete' && <p className="mail-content-warning"><CircleAlert size={13}/>This message is not fully downloaded yet.</p>}
        </header>
        {error && <p role="alert" className="mail-notice">{error}</p>}{busy && <p role="status" className="mail-loading">Opening message…</p>}
        <div id="mail-print-content" className="mail-message-body">
          <pre className="mail-print-copy" style={{display:'none'}}>{(texts.length ? texts.map(body => body.text) : html.map(body => new DOMParser().parseFromString(mailHtml(body.text), 'text/html').body.textContent)).join('\n\n')}</pre>
          {html.length > 0 && <div className="mail-body-options"><button onClick={() => setPlain(value => !value)}>{plain ? 'Formatted view' : 'Plain text'}</button></div>}
          {html.length && !plain ? <MailHtmlParts bodies={html} inline={inline} item={item} bodyPart={parts.find(part=>part.kind==='body'&&part.bytesAvailable)} signal={controller.current.signal}/>
            : texts.length ? texts.map((body, index) => <pre key={index} className="mail-plain-body">{body.text}</pre>)
            : html.length ? <pre className="mail-plain-body">{new DOMParser().parseFromString(mailHtml(html[0].text), 'text/html').body.textContent}</pre>
            : !busy ? <p className="mail-loading">No message body is available yet.</p> : null}
        </div>
        {parts.some(part => part.kind === 'attachment') && <div className="mail-attachments"><h3><Paperclip size={14}/>Attachments</h3><ul>{parts.filter(part => part.kind === 'attachment').map(part => <li key={part.key}><span className="mail-file-icon"><FileText size={19}/></span><div><strong>{part.filename || 'Unnamed attachment'}</strong><small>{part.bytesAvailable ? `${((part.bytes ?? 0) / 1024).toFixed(1)} KB` : part.state === 'pending' ? 'Downloading…' : 'Unavailable'}</small></div><button disabled={!part.bytesAvailable || busy} onClick={() => content(part, false)}>Open</button><button aria-label={`Save ${part.filename || 'attachment'}`} title="Save attachment" disabled={!part.bytesAvailable || busy} onClick={() => content(part, true)}><Download size={15}/></button>{chatBridge&&<MailAttachmentChat bridge={chatBridge} client={client} item={item} part={part} account={account}/>}</li>)}</ul></div>}
      </article>
    );
}
