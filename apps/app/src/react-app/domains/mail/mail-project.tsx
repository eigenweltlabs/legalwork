/** @jsxImportSource react */
import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { Folder } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { t } from '@/i18n';
import { MailSettingsSelect } from '../settings/pages/mail-settings-controls';
import { MailProjectError, type MailProjectDisplay, type MailProjectDestination } from '../../../../../server/src/mail/project-association-view';
import { MailClient, type MailMessageView } from './mail-client';
import { mailProjectCatalog, mailProjectHistory, readMailProject, setMailProject } from './mail-project-client';
import { previewMailClassification } from './mail-classifier-client';
import { MailClassifierError,type MailClassifierDisplayPreview,type MailClassifierReason } from '../../../../../server/src/mail/classifier-view';

function projectError(error: unknown) {
  return t(error instanceof MailProjectError && error.code === 'conflict' ? 'mail.project_conflict' : 'mail.project_failed');
}
function choiceKey(project: { id: string; binding: string } | null) { return project ? JSON.stringify([project.id, project.binding]) : ''; }
function snapshot(value: MailProjectDisplay) { return JSON.stringify([value.version, value.project, value.unavailable]); }

export function MailProjectControl({ client, item,classification=false }: { client: MailClient; item: MailMessageView;classification?:boolean }) {
  const navigate=useNavigate();
  const [current, setCurrent] = useState<MailProjectDisplay | null>(null), [open, setOpen] = useState(false), [error, setError] = useState('');
  const trigger = useRef<HTMLButtonElement>(null), pinned = useRef<string | null>(null), saving = useRef(false), generation=useRef(0);
  useEffect(() => {
    const controller = new AbortController(); let pending = false;
    setCurrent(null); setOpen(false); setError(''); pinned.current = null;
    async function refresh() {
      if (pending || saving.current) return; pending = true; const epoch=generation.current;
      try {
        const value = await readMailProject(client, item, controller.signal);
        if (controller.signal.aborted || saving.current || epoch!==generation.current) return;
        if (pinned.current && pinned.current !== snapshot(value)) { pinned.current = null; setOpen(false); setError(t('mail.project_conflict')); }
        setCurrent(value);
      } catch (error) { if (!controller.signal.aborted && !saving.current && epoch===generation.current) { setCurrent(null); setOpen(false); pinned.current = null; setError(projectError(error)); } }
      finally { pending = false; }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 5000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [client, item.accountId, item.key]);
  const close = () => { pinned.current = null; setOpen(false); };
  return <div className="my-2 flex flex-wrap items-center gap-2">
    <Button ref={trigger} variant="ghost" size="sm" aria-label={t('mail.project_title')+(current?.project?': '+current.project.name:current?.unavailable?': '+t('mail.project_unavailable'):'')} onClick={() => { if (current) pinned.current = snapshot(current); setError(''); setOpen(true); }}><Folder size={14}/>{current?.project?.name ?? t(current?.unavailable ? 'mail.project_unavailable' : 'mail.project_label')}</Button>
    {error && <Alert variant="destructive" role="alert">{error}</Alert>}
    {open && <MailProjectDialog client={client} item={item} classification={classification} onSettings={()=>{close();navigate('/settings/mail-accounts',{state:{from:'/mail',mailSection:'projects',mailAccount:item.accountId}});}} finalFocus={trigger} onClose={close} onLoaded={value => { generation.current++; pinned.current = snapshot(value); setCurrent(value); }} onSaving={value => { if(value)generation.current++; saving.current = value; }} onSaved={value => { setCurrent(value); close(); }}/>}
  </div>;
}

function MailProjectDialog({ client, item,classification,onSettings, finalFocus, onClose, onLoaded, onSaving, onSaved }: { client: MailClient; item: MailMessageView;classification:boolean;onSettings:()=>void; finalFocus: RefObject<HTMLElement | null>; onClose: () => void; onLoaded: (value: MailProjectDisplay) => void; onSaving: (value: boolean) => void; onSaved: (value: MailProjectDisplay) => void }) {
  const [current, setCurrent] = useState<MailProjectDisplay | null>(null), [projects, setProjects] = useState<MailProjectDestination[]>([]), [cursor, setCursor] = useState<string | null>(null), [choice, setChoice] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [history, setHistory] = useState<Awaited<ReturnType<typeof mailProjectHistory>> | null>(null);
  const [preview,setPreview]=useState<MailClassifierDisplayPreview|null>(null);
  const controller = useRef(new AbortController()), lock = useRef(false), cancel = useRef<HTMLButtonElement>(null), id = useId();
  const loaded = useRef(onLoaded); loaded.current = onLoaded;
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    void Promise.all([readMailProject(client, item, abort.signal), mailProjectCatalog(client, abort.signal)]).then(([value, page]) => {
      if (abort.signal.aborted) return;
      setCurrent(value); setChoice(choiceKey(value.project)); setProjects(page.items); setCursor(page.nextCursor); loaded.current(value);
    }).catch(error => { if (!abort.signal.aborted) setError(projectError(error)); });
    return () => abort.abort();
  }, [client, item.accountId, item.key]);
  const options = new Map(projects.map(project => [choiceKey(project), project]));
  if (current?.project && !options.has(choiceKey(current.project))) options.set(choiceKey(current.project), current.project);
  for(const candidate of preview?.candidates??[])options.set(choiceKey(candidate.project),candidate.project);
  async function run(operation: () => Promise<void>, write = false) {
    if (lock.current) return; lock.current = true; setBusy(true); setError(''); if (write) onSaving(true);
    try { await operation(); }
    catch (error) { if (!controller.current.signal.aborted) setError(error instanceof MailClassifierError?t(error.code==='conflict'?'mail.classifier_conflict':'mail.classifier_failed'):projectError(error)); }
    finally { lock.current = false; if (write) onSaving(false); if (!controller.current.signal.aborted) setBusy(false); }
  }
  async function save() {
    if (!current || choice && !options.has(choice)) return;
    const project = options.get(choice), next = await setMailProject(client, item, current, project ? { id: project.id, binding: project.binding } : null, controller.current.signal);
    if (!controller.current.signal.aborted) onSaved(next);
  }
  return <Dialog open onOpenChange={value => { if (!value && !lock.current) onClose(); }}><DialogContent initialFocus={cancel} finalFocus={finalFocus} className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
    <DialogHeader><DialogTitle>{t('mail.project_title')}</DialogTitle></DialogHeader>
    <div className="grid gap-2"><Label htmlFor={id}>{t('mail.project_label')}</Label><MailSettingsSelect id={id} value={choice} disabled={!current || busy} onChange={setChoice}><option value="">{t('mail.project_none')}</option>{[...options].map(([key, project]) => <option key={key} value={key}>{project.name}</option>)}</MailSettingsSelect></div>
    {current?.unavailable && <span role="status" className="text-sm text-muted-foreground">{t('mail.project_unavailable')}</span>}
    <div className="flex flex-wrap items-center gap-2">{cursor && <Button variant="ghost" size="sm" aria-disabled={busy} onClick={() => void run(async () => { const page = await mailProjectCatalog(client, controller.current.signal, cursor); if (!controller.current.signal.aborted) { setProjects(values => [...values, ...page.items]); setCursor(page.nextCursor); } })}>{t('mail.project_more')}</Button>}
    <Button variant="ghost" size="sm" disabled={!current} aria-disabled={busy} onClick={() => void run(async () => { const page = await mailProjectHistory(client, item, controller.current.signal); if (!controller.current.signal.aborted) setHistory(page); })}>{t('mail.project_history')}</Button>{classification&&<><Button variant="ghost" size="sm" disabled={!current} aria-disabled={busy} onClick={()=>void run(async()=>{setPreview(null);const value=await previewMailClassification(client,item,controller.current.signal);if(!controller.current.signal.aborted)setPreview(value);})}>{t('mail.classifier_check')}</Button><Button variant="ghost" size="sm" disabled={busy} onClick={onSettings}>{t('mail.classifier_rules')}</Button></>}</div>
    {preview&&<div className="grid gap-2"><span role="status" className="text-sm text-muted-foreground">{t(preview.status==='off'?'mail.classifier_is_off':preview.status==='manual'?'mail.classifier_manual':preview.status==='unavailable'?'mail.project_unavailable':preview.status==='excluded'?'mail.classifier_excluded':preview.status==='unmatched'?'mail.classifier_unmatched':preview.status==='ambiguous'?'mail.classifier_ambiguous':'mail.classifier_suggested')}</span>{preview.candidates.map(candidate=><Button key={choiceKey(candidate.project)} variant="outline" className="h-auto justify-between gap-3 whitespace-normal py-2 text-left" aria-pressed={choice===choiceKey(candidate.project)} disabled={busy} onClick={()=>setChoice(choiceKey(candidate.project))}><span className="min-w-0 break-words">{candidate.project.name}</span><span className="text-xs text-muted-foreground">{[...new Set(candidate.rules.flatMap(rule=>rule.reasons))].map(reason=>t(({sender:'mail.classifier_reason_sender',domain:'mail.classifier_reason_domain',reference:'mail.classifier_reference',subject:'mail.classifier_reason_subject'} satisfies Record<MailClassifierReason,Parameters<typeof t>[0]>)[reason])).join(' · ')}</span></Button>)}</div>}
    {history && <div className="grid gap-2 text-sm">{history.items.length ? history.items.map(entry => <div key={`${entry.version.generation}:${entry.version.revision}`} className="flex justify-between gap-3"><span className="min-w-0 break-words">{entry.project?.name ?? t(entry.unavailable ? 'mail.project_unavailable' : 'mail.project_none')}</span><time className="shrink-0 text-muted-foreground">{new Date(entry.at).toLocaleString()}</time></div>) : <span className="text-muted-foreground">{t('mail.project_history_empty')}</span>}{history.nextRevision !== null && <Button variant="ghost" size="sm" aria-disabled={busy} onClick={() => void run(async () => { const page = await mailProjectHistory(client, item, controller.current.signal, history.nextRevision ?? undefined); if (!controller.current.signal.aborted) setHistory({ ...page, items: [...history.items, ...page.items] }); })}>{t('mail.project_history_more')}</Button>}</div>}
    {error && <Alert variant="destructive" role="alert">{error}</Alert>}
    <DialogFooter><Button ref={cancel} variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button><Button disabled={busy || !current || !current.unavailable && choice === choiceKey(current.project)} onClick={() => void run(save, true)}>{t('common.save')}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
