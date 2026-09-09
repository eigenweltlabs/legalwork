/** @jsxImportSource react */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { MailClient, type MailAccountView, type MailFolderView, type MailMessageView } from './mail-client';
import { runMailSearch, savedMailSearch, readExtraction, SearchRequests, type MailSearchInput, type MailSearchResult, type SavedSearch } from './mail-search-client';
import type { MailExtractionText } from '../../../../../server/src/mail/extraction-view';
type Hit = MailSearchResult['items'][number];
const primaryFields: Array<'literal' | 'phrase'> = ['literal', 'phrase'];
const addressFields: Array<'sender' | 'recipient' | 'filename' | 'matterIdentifier'> = ['sender', 'recipient', 'filename', 'matterIdentifier'];
const dateFields: Array<'afterDate' | 'beforeDate'> = ['afterDate', 'beforeDate'];
const flagFields: Array<'unread' | 'hasAttachment'> = ['unread', 'hasAttachment'];
const errorText = (value: unknown) => value instanceof Error ? value.message : 'Search is unavailable.';
export function MailSearch({ client, accounts, onOpen }: {
    client: MailClient;
    accounts: MailAccountView[];
    onOpen: (item: MailMessageView | undefined) => void;
}) {
    const [query, setQuery] = useState<MailSearchInput>({}), [result, setResult] = useState<MailSearchResult>(), [submitted, setSubmitted] = useState<MailSearchInput>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [note, setNote] = useState(''), [offsets, setOffsets] = useState<number[]>([0]), [folders, setFolders] = useState<MailFolderView[]>([]), [saved, setSaved] = useState<SavedSearch[]>([]), [savedCursor, setSavedCursor] = useState<string | null>(null), [name, setName] = useState(''), [excerpt, setExcerpt] = useState<MailExtractionText>(), [source, setSource] = useState<{
        hit: Hit;
        partId: string;
        referenceId: string;
    }>();
    const [keywordText, setKeywordText] = useState('');
    const savedRequests = useRef(new SearchRequests());
    const requests = useRef(new SearchRequests()), auxiliary = useRef(new AbortController());
    const [selected, setSelected] = useState(0);
    const buttons = useRef<Array<HTMLButtonElement | null>>([]);
    useEffect(() => { const controller = new AbortController(); auxiliary.current = controller; return () => { requests.current.cancel(); savedRequests.current.cancel(); controller.abort(); }; }, []);
    useEffect(() => {
        const abort = new AbortController();
        setFolders([]);
        if (query.accountIds?.length === 1) {
            void (async () => {
                try {
                    const values: MailFolderView[] = [];
                    let after: string | undefined;
                    do {
                        const page = await client.folders(query.accountIds![0], abort.signal, after);
                        values.push(...page.items);
                        after = page.nextCursor ?? undefined;
                        if (values.length > 2000)
                            throw Error('Too many folders; use an exact folder ID.');
                    } while (after && !abort.signal.aborted);
                    if (!abort.signal.aborted)
                        setFolders(values);
                }
                catch (error) {
                    if (!abort.signal.aborted)
                        setError(errorText(error));
                }
            })();
        }
        return () => abort.abort();
    }, [client, query.accountIds?.join('|')]);
    async function listSaved(after?: string) {
        const signal = savedRequests.current.start();
        try {
            const response = await savedMailSearch(client, { action: 'list', ...(after ? { after } : {}) }, signal);
            if (!signal.aborted && response.action === 'list') {
                setSaved(value => after ? [...value, ...response.items] : response.items);
                setSavedCursor(response.nextCursor);
            }
        }
        catch (error) {
            if (!signal.aborted)
                setError(errorText(error));
        }
    }
    useEffect(() => { void listSaved(); }, [client]);
    const cancel = () => { requests.current.cancel(); setBusy(false); setNote('Search cancelled.'); };
    function edit(next: MailSearchInput) { setKeywordText(next.keywords?.join(' ') ?? ''); onOpen(undefined); requests.current.cancel(); setBusy(false); setQuery(next); setResult(undefined); setSubmitted(undefined); setExcerpt(undefined); setSource(undefined); setNote(''); setError(''); setOffsets([0]); }
    function field(key: 'literal' | 'phrase' | 'sender' | 'recipient' | 'filename' | 'matterIdentifier' | 'folderId', value: string) {
        const next = { ...query };
        if (value)
            next[key] = value;
        else
            delete next[key];
        edit(next);
    }
    async function search(input = query, offset = 0, history = [0]) {
        const signal = requests.current.start();
        setBusy(true);
        setError('');
        setNote('');
        setExcerpt(undefined);
        setSource(undefined);
        try {
            const response = await runMailSearch(client, { ...input, limit: 20, offset }, signal);
            if (signal.aborted)
                return;
            setResult(response);
            setSubmitted(input);
            setOffsets(history);
            setSelected(0);
        }
        catch (error) {
            if (!signal.aborted) {
                setResult(undefined);
                setError(errorText(error));
            }
        }
        finally {
            if (!signal.aborted)
                setBusy(false);
        }
    }
    async function open(hit: Hit) {
        const signal = requests.current.start();
        setBusy(true);
        setError('');
        try {
            const item = await client.readLocator(hit.accountId, hit.locator, signal);
            if (!signal.aborted)
                onOpen(item);
        }
        catch (error) {
            if (!signal.aborted)
                setError(errorText(error));
        }
        finally {
            if (!signal.aborted)
                setBusy(false);
        }
    }
    async function section(value: {
        hit: Hit;
        partId: string;
        referenceId: string;
    }, index = 0, offset = 0) {
        const signal = requests.current.start();
        setBusy(true);
        setError('');
        try {
            const data = await readExtraction(client, value.hit.accountId, { locator: value.hit.locator, partId: value.partId, referenceId: value.referenceId, section: index, offset, limit: 4096 }, signal);
            if (!signal.aborted) {
                setSource(value);
                setExcerpt(data);
            }
        }
        catch (error) {
            if (!signal.aborted) {
                setExcerpt(undefined);
                setError(errorText(error));
            }
        }
        finally {
            if (!signal.aborted)
                setBusy(false);
        }
    }
    async function save() {
        setError('');
        try {
            await savedMailSearch(client, { action: 'save', id: crypto.randomUUID(), expectedRevision: null, name, query }, auxiliary.current.signal);
            if (!auxiliary.current.signal.aborted) {
                setName('');
                setNote('Search saved in encrypted mail storage.');
                await listSaved();
            }
        }
        catch (error) {
            if (!auxiliary.current.signal.aborted)
                setError(errorText(error));
        }
    }
    async function remove(item: SavedSearch) {
        try {
            await savedMailSearch(client, { action: 'delete', id: item.id, expectedRevision: item.revision }, auxiliary.current.signal);
            if (!auxiliary.current.signal.aborted)
                await listSaved();
        }
        catch (error) {
            if (!auxiliary.current.signal.aborted)
                setError(errorText(error));
        }
    }
    useEffect(() => {
        if (!submitted || !result || busy)
            return;
        const controller = new AbortController();
        const generation = requests.current.generation;
        let active = false;
        const timer = setInterval(() => {
            if (active)
                return;
            active = true;
            void runMailSearch(client, { ...submitted, limit: 20, offset: offsets.at(-1) ?? 0 }, controller.signal).then(response => { if (!controller.signal.aborted && requests.current.generation === generation) {
                setResult(response);
                if (source && !response.items.some(hit => hit.accountId === source.hit.accountId && JSON.stringify(hit.locator) === JSON.stringify(source.hit.locator) && hit.attachmentSources?.some(part => part.partId === source.partId && part.referenceId === source.referenceId))) {
                    setSource(undefined);
                    setExcerpt(undefined);
                    onOpen(undefined);
                }
            } }).catch(error => {
                if (!controller.signal.aborted && requests.current.generation === generation) {
                    setResult(undefined);
                    setExcerpt(undefined);
                    setSource(undefined);
                    onOpen(undefined);
                    setError(errorText(error));
                }
            }).finally(() => { active = false; });
        }, 5000);
        return () => { clearInterval(timer); controller.abort(); };
    }, [client, submitted, result, busy, offsets, source]);
    const label = (id: string) => accounts.find(account => account.id === id)?.displayName ?? 'Unavailable account';
    return <section aria-label="Local mail search" className="min-h-0 flex-1 overflow-auto p-4 space-y-4">
  <h2 className="text-lg font-semibold">Search local mail</h2><p className="text-sm">Searches stored messages and extracted attachments. No provider request. Choose accounts explicitly or search all accessible local accounts.</p>
  <form className="space-y-3" onSubmit={event => { event.preventDefault(); void search(); }}>
   <div className="grid gap-3 sm:grid-cols-3">{primaryFields.map(key => <label key={key}>{key === 'literal' ? 'Literal text' : 'Exact phrase'}<input className="block w-full rounded border bg-background p-2" aria-label={key === 'literal' ? 'Literal text' : 'Exact phrase'} maxLength={512} value={query[key] ?? ''} onChange={event => field(key, event.target.value)}/></label>)}<label>Keywords<input className="block w-full rounded border bg-background p-2" aria-label="Keywords" maxLength={512} value={keywordText} onChange={event => {
            const next = { ...query };
            if (event.target.value)
                next.keywords = event.target.value.split(/\s+/).filter(Boolean);
            else
                delete next.keywords;
            edit(next);
            setKeywordText(event.target.value);
        }}/></label></div>
   <p className="text-xs">All supplied conditions are combined. Literal text preserves punctuation (AZ-12/34.5); phrases match consecutive words. German umlauts remain distinct. Sender, recipient and filename filters match exact values; case-insensitive.</p>
   <details><summary className="cursor-pointer font-medium">Structured filters</summary><div className="grid gap-3 p-2 sm:grid-cols-3">
    <label>Accounts<select multiple aria-label="Search accounts" className="block w-full border bg-background p-2" value={query.accountIds ?? []} onChange={event => {
            const ids = Array.from(event.target.selectedOptions, option => option.value);
            const next = { ...query };
            delete next.folderId;
            if (ids.length)
                next.accountIds = ids;
            else
                delete next.accountIds;
            edit(next);
        }}>{accounts.map(account => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select><button type="button" className="text-xs underline" onClick={() => { const next = { ...query }; delete next.accountIds; delete next.folderId; edit(next); }}>All accessible accounts</button></label>
    {addressFields.map(key => <label key={key}>{({ sender: 'Sender address', recipient: 'Recipient address', filename: 'Exact attachment filename', matterIdentifier: 'Case identifier in text' })[key]}<input aria-label={key} className="block w-full border bg-background p-2" maxLength={512} value={query[key] ?? ''} onChange={event => field(key, event.target.value)}/></label>)}
    <label>Folder / label<select aria-label="Folder or label" className="block w-full border bg-background p-2" disabled={query.accountIds?.length !== 1} value={query.folderId ?? ''} onChange={event => field('folderId', event.target.value)}><option value="">All folders / labels</option>{folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
    {dateFields.map(key => <label key={key}>{key === 'afterDate' ? 'On or after (UTC)' : 'Before (UTC)'}<input aria-label={key} type="date" className="block w-full border bg-background p-2" value={query[key]?.slice(0, 10) ?? ''} onChange={event => {
                const next = { ...query };
                if (event.target.value)
                    next[key] = event.target.value + 'T00:00:00.000Z';
                else
                    delete next[key];
                edit(next);
            }}/></label>)}
    {flagFields.map(key => <label key={key}>{key === 'unread' ? 'Read state' : 'Attachments'}<select aria-label={key} className="block w-full border bg-background p-2" value={query[key] === undefined ? 'any' : String(query[key])} onChange={event => {
                const next = { ...query };
                if (event.target.value === 'any')
                    delete next[key];
                else
                    next[key] = event.target.value === 'true';
                edit(next);
            }}><option value="any">Any</option><option value="true">{key === 'unread' ? 'Unread' : 'Has attachments'}</option><option value="false">{key === 'unread' ? 'Read' : 'No attachments'}</option></select></label>)}
   </div></details>
   <p className="text-sm font-medium">Scope: {query.accountIds?.map(label).join(', ') ?? 'All accessible local accounts'}{query.folderId ? ' · ' + (folders.find(value => value.id === query.folderId)?.name ?? query.folderId) : ' · All stored folders'}</p>
   <div className="flex gap-2"><Button type="submit">Search</Button>{busy && <Button type="button" variant="outline" onClick={cancel}>Cancel</Button>}<Button type="button" variant="outline" onClick={() => edit({})}>Clear</Button></div>
  </form>
  <details><summary className="cursor-pointer">Saved searches (encrypted)</summary><div className="flex gap-2 py-2"><input aria-label="Saved search name" className="border bg-background p-2" maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="Name this search"/><Button disabled={!name.trim()} onClick={save}>Save current search</Button></div>{saved.map(item => <div key={item.id} className="flex gap-3"><button className="underline" onClick={() => { edit(item.query); void search(item.query); }}>{item.name}</button><button aria-label={'Delete saved search ' + item.name} onClick={() => remove(item)}>Delete</button></div>)}{savedCursor && <button className="underline" onClick={() => listSaved(savedCursor)}>More saved searches</button>}</details>
  {error && <p role="alert">{error}</p>}{note && <p role="status">{note}</p>}{busy && <p role="status">Searching local storage…</p>}
  {result && <><p role="status">{result.total} matches · {result.pending} messages awaiting index · {result.incomplete} incomplete projections. {result.pending || result.incomplete ? 'Results may grow during synchronization or extraction. Refresh to include new content.' : 'Local index is current for stored content.'}</p><Button variant="outline" onClick={() => search(submitted)}>Refresh results</Button>{!result.items.length && <p>No local matches. Broaden the filters or wait for content to finish downloading and indexing.</p>}
   <div aria-label="Search results" onKeyDown={event => {
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key))
                    return;
                event.preventDefault();
                const index = event.key === 'Home' ? 0 : event.key === 'End' ? result.items.length - 1 : Math.max(0, Math.min(result.items.length - 1, selected + (event.key === 'ArrowDown' ? 1 : -1)));
                setSelected(index);
                buttons.current[index]?.focus();
            }}>{result.items.map((hit, index) => <article className="border-b py-3" key={hit.accountId + JSON.stringify(hit.locator)}><button ref={element => { buttons.current[index] = element; }} className="text-left font-medium underline" onFocus={() => setSelected(index)} onClick={() => open(hit)}>{hit.subject || '(No subject)'}</button><p className="text-xs">{label(hit.accountId)} · {hit.date ? new Date(hit.date).toLocaleDateString() : 'Date unavailable'}</p><p className="whitespace-pre-wrap break-words">{hit.snippet}</p>{hit.attachmentMatches?.map(part => <button key={part.partId + 'match'} className="mr-3 text-sm underline" onClick={() => section({ hit, ...part }, part.section, part.offset)}>Matching attachment: {part.source}</button>)}{hit.attachmentSources?.map(part => <button key={part.partId} className="mr-3 text-sm underline" onClick={() => section({ hit, ...part })}>Read extracted attachment</button>)}</article>)}</div>
   <div className="flex gap-2"><Button variant="outline" disabled={busy || offsets.length < 2} onClick={() => { const history = offsets.slice(0, -1); void search(submitted, history.at(-1) ?? 0, history); }}>Previous page</Button><Button variant="outline" disabled={busy || result.nextOffset === null} onClick={() => {
                if (result.nextOffset !== null)
                    void search(submitted, result.nextOffset, [...offsets, result.nextOffset]);
            }}>Next page</Button></div>
  </>}
  {excerpt && source && <aside aria-label="Extracted attachment text" className="rounded border p-4"><h3 className="font-semibold">{excerpt.source} · {excerpt.method === 'ocr' ? 'OCR text' : 'Extracted text'}</h3><p className="text-xs break-all">Message: {source.hit.subject} · Part: {source.partId}</p><pre className="whitespace-pre-wrap break-words">{excerpt.text}</pre><div className="flex gap-2"><Button onClick={() => open(source.hit)}>Open source message</Button><Button variant="outline" disabled={busy || excerpt.nextOffset === null && excerpt.nextSection === null} onClick={() => section(source, excerpt.nextOffset !== null ? excerpt.section : excerpt.nextSection ?? excerpt.section, excerpt.nextOffset ?? 0)}>Continue extracted text</Button><Button variant="outline" onClick={() => { setExcerpt(undefined); setSource(undefined); }}>Close excerpt</Button></div></aside>}
 </section>;
}
