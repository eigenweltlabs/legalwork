/** @jsxImportSource react */
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { t } from '@/i18n';
import { MailClassifierError, mailClassifierDefinitionSchema, mailClassifierEditableRuleSchema, type MailClassifierDisplay, type MailClassifierSave } from '../../../../../../server/src/mail/classifier-view';
import type { MailProjectDestination } from '../../../../../../server/src/mail/project-association-view';
import { MailClient, type MailAccountView } from '../../mail/mail-client';
import { requestMailClassifier } from '../../mail/mail-classifier-client';
import { mailProjectCatalog } from '../../mail/mail-project-client';
import { MailSettingsSelect, MailSettingsSection } from './mail-settings-controls';

type EditableRule = MailClassifierSave['definition']['rules'][number];
function editable(value: MailClassifierDisplay): MailClassifierSave['definition'] {
  return { ...value.definition, rules: value.definition.rules.map(({ unavailable: _unavailable, ...rule }) => ({ ...rule, project: rule.project ? { id: rule.project.id, binding: rule.project.binding } : null })) };
}
export function classifierError(error: unknown) { return t(error instanceof MailClassifierError && error.code === 'conflict' ? 'mail.classifier_conflict' : 'mail.classifier_failed'); }

export function MailClassifierView({ client, accounts,initialAccount }: { client: MailClient; accounts: MailAccountView[];initialAccount?:string }) {
  const [selected, setSelected] = useState(initialAccount??''), account = selected?accounts.find(value => value.id === selected):accounts[0];
  return <MailSettingsSection title={t('mail.classifier_title')}>
    {accounts.length>0&&<MailSettingsSelect aria-label={t('mail.rules_account')} value={account?.id??''} onChange={value=>{if(value)setSelected(value);}}><option value="">{t('mail.classifier_choose_account')}</option>{accounts.map(value => <option key={value.id} value={value.id}>{value.displayName}</option>)}</MailSettingsSelect>}{account?<AccountClassifier key={account.id} client={client} accountId={account.id}/>:<span role="status">{t(accounts.length?'mail.classifier_choose_account':'mail.classifier_no_account')}</span>}
  </MailSettingsSection>;
}

function AccountClassifier({ client, accountId }: { client: MailClient; accountId: string }) {
  const [state, setState] = useState<MailClassifierDisplay | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [editor, setEditor] = useState<{ rule: EditableRule; unavailable: boolean } | null>(null), [exclusions, setExclusions] = useState(false);
  const controller = useRef(new AbortController()), lock = useRef(false);
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort;
    void requestMailClassifier(client, accountId, abort.signal).then(value => { if (!abort.signal.aborted) setState(value); }).catch(error => { if (!abort.signal.aborted) setError(classifierError(error)); });
    return () => abort.abort();
  }, [client, accountId]);
  async function apply(definition?: MailClassifierSave['definition']) {
    if (lock.current) throw new MailClassifierError('conflict');
    lock.current = true; setBusy(true); setError('');
    try {
      const value = await requestMailClassifier(client, accountId, controller.current.signal, definition ? { expected: state?.version ?? null, definition } : undefined);
      if (!controller.current.signal.aborted) setState(value);
    } finally { lock.current = false; if (!controller.current.signal.aborted) setBusy(false); }
  }
  const perform = (definition?: MailClassifierSave['definition']) => void apply(definition).catch(error => { if (!controller.current.signal.aborted) setError(classifierError(error)); });
  return <div className="space-y-4" aria-busy={busy}>
    <div className="grid gap-2"><div className="flex items-center gap-2"><Label>{t('mail.classifier_mode')}</Label>{busy&&<Loader2 size={14} className="animate-spin text-muted-foreground" aria-hidden="true"/>}</div><MailSettingsSelect aria-label={t('mail.classifier_mode')} disabled={!state} value={state?.definition.mode ?? 'off'} onChange={mode => { if (!lock.current && state && (mode === 'off' || mode === 'suggestions')) perform({ ...editable(state), mode, ...(mode==='off'?{rules:editable(state).rules.map(rule=>({...rule,project:null}))}:{}) }); }}><option value="off">{t('mail.classifier_off')}</option><option value="suggestions">{t('mail.classifier_suggestions')}</option></MailSettingsSelect></div>
    <div className="flex flex-wrap gap-2"><Button size="sm" disabled={!state || busy || state.definition.rules.length >= 20} onClick={() => setEditor({ rule: { id: crypto.randomUUID(), name: '', order: Math.min(20, (state?.definition.rules.length ?? 0) + 1), enabled: false, project: null, criteria: { sender: '', domain: '', reference: '', subject: '' } }, unavailable: false })}>{t('mail.classifier_add')}</Button><Button size="sm" variant="outline" disabled={!state || busy} onClick={() => setExclusions(true)}>{t('mail.classifier_exclusions')}</Button><Button size="sm" variant="ghost" aria-disabled={busy} onClick={() => { if (!lock.current) perform(); }}>{t('mail.rules_refresh')}</Button></div>
    {state && !state.definition.rules.length && <span className="text-sm text-muted-foreground">{t('mail.classifier_empty')}</span>}
    <div className="divide-y divide-border">{state&&[...state.definition.rules].sort((a,b)=>a.order-b.order||a.id.localeCompare(b.id)).map(rule => <div key={rule.id} className="flex flex-wrap items-center gap-3 py-3"><span className="text-sm text-muted-foreground">{rule.order}</span><div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{rule.name}</p><span className="break-words text-xs text-muted-foreground">{rule.project?.name ?? t('mail.project_unavailable')}</span></div><Switch size="sm" checked={rule.enabled} aria-disabled={busy} aria-label={t('mail.rules_enable_named', { name: rule.name })} onCheckedChange={enabled => {if(!lock.current)perform({ ...editable(state), rules: editable(state).rules.map(value => value.id === rule.id ? { ...value, enabled } : value) });}}/><Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditor({ rule: { ...rule, project: rule.project ? { id: rule.project.id, binding: rule.project.binding } : null }, unavailable: rule.unavailable })}>{t('common.edit')}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => perform({ ...editable(state), rules: editable(state).rules.filter(value => value.id !== rule.id) })}>{t('mail.rules_delete')}</Button></div>)}</div>
    {error && <Alert variant="destructive" role="alert">{error}</Alert>}
    {editor && state && <ClassifierRuleEditor key={editor.rule.id} client={client} initial={editor.rule} currentProject={state.definition.rules.find(rule => rule.id === editor.rule.id)?.project ?? null} unavailable={editor.unavailable} onClose={() => setEditor(null)} onSave={rule => apply({ ...editable(state), rules: state.definition.rules.some(value => value.id === rule.id) ? editable(state).rules.map(value => value.id === rule.id ? rule : value) : [...editable(state).rules, rule] })}/>}
    {exclusions && state && <ExclusionEditor initial={state.definition.exclusions} onClose={() => setExclusions(false)} onSave={value => apply({ ...editable(state), exclusions: value })}/>}
  </div>;
}

function ClassifierRuleEditor({ client, initial, currentProject, unavailable, onClose, onSave }: { client: MailClient; initial: EditableRule; currentProject: MailProjectDestination | null; unavailable: boolean; onClose: () => void; onSave: (rule: EditableRule) => Promise<void> }) {
  const [rule, setRule] = useState(initial), [projects, setProjects] = useState<MailProjectDestination[]>([]), [cursor, setCursor] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [catalogLoading,setCatalogLoading]=useState(false),catalogRequest=useRef(false);
  const controller = useRef(new AbortController()), lock = useRef(false), cancel = useRef<HTMLButtonElement>(null), id = useId();
  useEffect(() => { const abort = new AbortController(); controller.current = abort; void mailProjectCatalog(client, abort.signal).then(page => { if (!abort.signal.aborted) { setProjects(page.items); setCursor(page.nextCursor); } }).catch(error => { if (!abort.signal.aborted) setError(classifierError(error)); }); return () => abort.abort(); }, [client]);
  const options = new Map(projects.map(project => [JSON.stringify([project.id, project.binding]), project]));
  if (currentProject) options.set(JSON.stringify([currentProject.id, currentProject.binding]), currentProject);
  const selected = rule.project ? JSON.stringify([rule.project.id, rule.project.binding]) : '';
  async function run(operation: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await operation(); } catch (error) { if (!controller.current.signal.aborted) setError(classifierError(error)); }
    finally { lock.current = false; if (!controller.current.signal.aborted) setBusy(false); }
  }
  async function save() {
    const parsed = mailClassifierEditableRuleSchema.safeParse(rule);
    if (!parsed.success || !rule.project && !unavailable) { setError(t('mail.classifier_invalid')); return; }
    await onSave(parsed.data); if (!controller.current.signal.aborted) onClose();
  }
  async function moreProjects(){
    if(!cursor||lock.current||catalogRequest.current)return;
    catalogRequest.current=true;setCatalogLoading(true);setError('');
    try{const page=await mailProjectCatalog(client,controller.current.signal,cursor);if(!controller.current.signal.aborted){setProjects(values=>[...values,...page.items]);setCursor(page.nextCursor);if(!page.nextCursor)document.getElementById(`${id}-project`)?.focus();}}
    catch(error){if(!controller.current.signal.aborted)setError(classifierError(error));}
    finally{catalogRequest.current=false;if(!controller.current.signal.aborted)setCatalogLoading(false);}
  }
  return <Dialog open onOpenChange={open => { if (!open && !lock.current) onClose(); }}><DialogContent initialFocus={cancel} className="max-h-[calc(100dvh-2rem)] overflow-y-auto"><DialogHeader><DialogTitle>{t('mail.classifier_rule')}</DialogTitle></DialogHeader>
    <fieldset disabled={busy} className="grid gap-4">
      <div className="grid gap-1.5"><Label htmlFor={`${id}-name`}>{t('mail.rules_name')}</Label><Input id={`${id}-name`} value={rule.name} maxLength={80} onChange={event => setRule({ ...rule, name: event.target.value })}/></div>
      <div className="grid gap-1.5"><Label htmlFor={`${id}-project`}>{t('mail.project_label')}</Label><MailSettingsSelect id={`${id}-project`} value={selected} onChange={key => { const project = options.get(key); if (project) setRule({ ...rule, project: { id: project.id, binding: project.binding } }); }}><option value="">{t(unavailable ? 'mail.project_unavailable' : 'mail.classifier_choose_project')}</option>{[...options].map(([key, project]) => <option key={key} value={key}>{project.name}</option>)}</MailSettingsSelect>{cursor && <Button size="sm" variant="ghost" aria-disabled={catalogLoading||busy} onClick={() => void moreProjects()}>{t('mail.project_more')}</Button>}</div>
      <div className="grid gap-1.5"><Label htmlFor={`${id}-order`}>{t('mail.rules_order')}</Label><Input id={`${id}-order`} type="number" min={1} max={20} value={rule.order} onChange={event => setRule({ ...rule, order: Number(event.target.value) })}/></div>
      {(['sender', 'domain', 'reference', 'subject'] satisfies (keyof EditableRule['criteria'])[]).map(field => <div key={field} className="grid gap-1.5"><Label htmlFor={`${id}-${field}`}>{t(field === 'sender' ? 'mail.rules_sender' : field === 'domain' ? 'mail.classifier_domain' : field === 'reference' ? 'mail.classifier_reference' : 'mail.rules_subject')}</Label><Input id={`${id}-${field}`} value={rule.criteria[field]} maxLength={field === 'sender' ? 254 : field === 'domain' ? 253 : field === 'reference' ? 80 : 200} onChange={event => setRule({ ...rule, criteria: { ...rule.criteria, [field]: event.target.value } })}/></div>)}
      <div className="flex items-center justify-between"><Label htmlFor={`${id}-enabled`}>{t('mail.rules_enabled')}</Label><Switch id={`${id}-enabled`} checked={rule.enabled} onCheckedChange={enabled => setRule({ ...rule, enabled })}/></div>
    </fieldset>
    {error && <Alert variant="destructive" role="alert">{error}</Alert>}
    <DialogFooter><Button ref={cancel} variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button><Button disabled={busy||catalogLoading} onClick={() => void run(save)}>{t('common.save')}</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function ExclusionEditor({ initial, onClose, onSave }: { initial: MailClassifierSave['definition']['exclusions']; onClose: () => void; onSave: (value: MailClassifierSave['definition']['exclusions']) => Promise<void> }) {
  const [values, setValues] = useState({ senders: initial.senders.join('\n'), domains: initial.domains.join('\n'), subjects: initial.subjects.join('\n') }), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false), cancel = useRef<HTMLButtonElement>(null), id = useId();
  const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean);
  async function save() {
    if (lock.current) return;
    const parsed = mailClassifierDefinitionSchema.shape.exclusions.safeParse({ senders: lines(values.senders), domains: lines(values.domains), subjects: lines(values.subjects) });
    if (!parsed.success) { setError(t('mail.classifier_invalid')); return; }
    lock.current = true; setBusy(true); setError('');
    try { await onSave(parsed.data); onClose(); } catch (error) { setError(classifierError(error)); } finally { lock.current = false; setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !lock.current) onClose(); }}><DialogContent initialFocus={cancel}><DialogHeader><DialogTitle>{t('mail.classifier_exclusions')}</DialogTitle></DialogHeader><fieldset disabled={busy} className="grid gap-4">{(['senders', 'domains', 'subjects'] satisfies (keyof typeof values)[]).map(field => <div className="grid gap-1.5" key={field}><Label htmlFor={`${id}-${field}`}>{t(field === 'senders' ? 'mail.classifier_exclude_senders' : field === 'domains' ? 'mail.classifier_exclude_domains' : 'mail.classifier_exclude_subjects')}</Label><Textarea id={`${id}-${field}`} rows={3} maxLength={5200} value={values[field]} onChange={event => setValues({ ...values, [field]: event.target.value })}/></div>)}</fieldset>{error && <Alert variant="destructive" role="alert">{error}</Alert>}<DialogFooter><Button ref={cancel} variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button><Button disabled={busy} onClick={() => void save()}>{t('common.save')}</Button></DialogFooter></DialogContent></Dialog>;
}
