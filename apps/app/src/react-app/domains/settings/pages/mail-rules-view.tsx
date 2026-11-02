/** @jsxImportSource react */
import { useEffect, useId, useRef, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { t } from '@/i18n';
import { MailClient, type MailAccountView } from '../../mail/mail-client';
import { requestMailRules } from '../../mail/mail-rules-client';
import { mailRuleDefinitionSchema, type MailRule, type MailRuleDefinition, type MailRules } from '../../../../../../server/src/mail/rules-view';
import { MailSettingsSelect, MailSettingsSection } from './mail-settings-controls';

const statuses = { ready: 'mail.rules_ready', disabled: 'mail.rules_disabled', waiting_sync: 'mail.rules_waiting_sync', paused: 'mail.rules_paused', unavailable: 'mail.rules_unavailable', connection_changed: 'mail.rules_connection_changed', write_permission: 'mail.rules_write_permission' } satisfies Record<MailRule['status'], Parameters<typeof t>[0]>;
const actions = { read: 'mail.rules_read', flag: 'mail.rules_flag', archive: 'mail.rules_archive', snooze: 'mail.rules_snooze' } satisfies Record<MailRuleDefinition['action']['kind'], Parameters<typeof t>[0]>;
const outcomes = { queued: 'mail.rules_queued', running: 'mail.rules_running', dispatching: 'mail.rules_running', retry: 'mail.rules_retry', succeeded: 'mail.rules_succeeded', failed: 'mail.rules_failed_action', conflict: 'mail.rules_conflict', uncertain: 'mail.rules_uncertain', cancelled: 'mail.rules_cancelled', snoozed: 'mail.rules_snoozed', unavailable: 'mail.rules_failed_action' } satisfies Record<MailRules['activity'][number]['outcome'], Parameters<typeof t>[0]>;

export function MailRulesView({ client, accounts }: { client: MailClient; accounts: MailAccountView[] }) {
  const eligible = accounts.filter(account => account.provider !== 'archive' && !account.integrationArchive);
  const [selected, setSelected] = useState('');
  const account = eligible.find(account => account.id === selected) ?? eligible[0];
  return <MailSettingsSection title={t('mail.rules_title')}>
    {account ? <><MailSettingsSelect aria-label={t('mail.rules_account')} value={account.id} onChange={setSelected}>{eligible.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</MailSettingsSelect><AccountRules key={account.id} client={client} accountId={account.id} /></> : <p role="status">{t('mail.rules_no_account')}</p>}
  </MailSettingsSection>;
}

function AccountRules({ client, accountId }: { client: MailClient; accountId: string }) {
  const [state, setState] = useState<MailRules>(), [editor, setEditor] = useState<{ rule?: MailRule; id: string }>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null), lock = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); request.current = controller;
    void requestMailRules(client, accountId, controller.signal).then(value => { if (!controller.signal.aborted) setState(value); }).catch(() => { if (!controller.signal.aborted) setError(t('mail.rules_failed')); });
    return () => { controller.abort(); request.current?.abort(); };
  }, [client, accountId]);
  async function apply(change?: Parameters<typeof requestMailRules>[3]) {
    if (lock.current) throw Error('Rule request in progress.');
    lock.current = true; setBusy(true); setError('');
    const controller = new AbortController(); request.current?.abort(); request.current = controller;
    try { const value = await requestMailRules(client, accountId, controller.signal, change); if (!controller.signal.aborted) setState(value); }
    finally { lock.current = false; if (!controller.signal.aborted) setBusy(false); }
  }
  function perform(change?: Parameters<typeof requestMailRules>[3]) { void apply(change).catch(() => setError(t('mail.rules_failed'))); }
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || !state || state.items.length >= 20} onClick={() => setEditor({ id: crypto.randomUUID() })}>{t('mail.rules_add')}</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => perform()}>{t('mail.rules_refresh')}</Button></div>
    {state && !state.items.length && <p className="text-sm text-muted-foreground">{t('mail.rules_empty')}</p>}
    <div className="divide-y divide-border">{state?.items.map(rule => <div key={rule.id} className="flex flex-wrap items-center gap-3 py-3">
      <span className="text-sm text-muted-foreground">{rule.definition.order}</span><div className="min-w-0 flex-1"><p className="break-words text-sm font-medium">{rule.definition.name}</p><p className="text-xs text-muted-foreground">{t(actions[rule.definition.action.kind])} · {t(statuses[rule.status])}</p></div>
      <Switch size="sm" checked={rule.definition.enabled} disabled={busy} aria-label={t('mail.rules_enable_named', { name: rule.definition.name })} onCheckedChange={enabled => perform({ kind: 'save', input: { id: rule.id, expected: rule.version, definition: { ...rule.definition, enabled } } })} />
      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditor({ rule, id: rule.id })}>{t('common.edit')}</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => perform({ kind: 'delete', input: { id: rule.id, expected: rule.version } })}>{t('mail.rules_delete')}</Button>
    </div>)}</div>
    {!!state?.activity.length && <div className="space-y-2"><h4 className="text-sm font-medium">{t('mail.rules_activity')}</h4>{state.activity.map(item => <div key={item.id} className="flex flex-wrap justify-between gap-x-3 text-xs"><span>{item.ruleName} · {t(actions[item.action])}</span><span>{t(outcomes[item.outcome])} · {new Date(item.at).toLocaleString()}</span></div>)}</div>}
    {error && <Alert variant="destructive" role="alert">{error}</Alert>}
    {editor && <RuleEditor key={editor.id} rule={editor.rule} order={Math.min(20, (state?.items.length ?? 0) + 1)} onClose={() => setEditor(undefined)} onSave={definition => apply({ kind: 'save', input: { id: editor.id, expected: editor.rule?.version ?? null, definition } })} />}
  </div>;
}

function RuleEditor({ rule, order, onClose, onSave }: { rule?: MailRule; order: number; onClose: () => void; onSave: (definition: MailRuleDefinition) => Promise<void> }) {
  const [name, setName] = useState(rule?.definition.name ?? ''), [sender, setSender] = useState(rule?.definition.sender ?? ''), [subject, setSubject] = useState(rule?.definition.subject ?? '');
  const [enabled, setEnabled] = useState(rule?.definition.enabled ?? false), [position, setPosition] = useState(String(rule?.definition.order ?? order));
  const [action, setAction] = useState<MailRuleDefinition['action']['kind']>(rule?.definition.action.kind ?? 'read');
  const [minutes, setMinutes] = useState(rule?.definition.action.kind === 'snooze' ? String(rule.definition.action.minutes) : '60');
  const [zone, setZone] = useState(rule?.definition.action.kind === 'snooze' ? rule.definition.action.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''); const lock = useRef(false), cancel = useRef<HTMLButtonElement>(null), id = useId();
  async function save() {
    if (lock.current) return;
    const definition = mailRuleDefinitionSchema.safeParse({ name, sender, subject, enabled, order: Number(position), action: action === 'snooze' ? { kind: action, minutes: Number(minutes), timeZone: zone } : { kind: action } });
    if (!definition.success) { setError(t('mail.rules_invalid')); return; }
    lock.current = true; setBusy(true); setError('');
    try { await onSave(definition.data); onClose(); } catch { setError(t('mail.rules_failed')); } finally { lock.current = false; setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !lock.current) onClose(); }}><DialogContent initialFocus={cancel} className="max-h-[calc(100dvh-2rem)] overflow-y-auto"><DialogHeader><DialogTitle>{t(rule ? 'mail.rules_edit' : 'mail.rules_add')}</DialogTitle></DialogHeader>
    <fieldset disabled={busy} className="grid gap-4">
      <div className="grid gap-1.5"><Label htmlFor={`${id}-name`}>{t('mail.rules_name')}</Label><Input id={`${id}-name`} value={name} maxLength={80} onChange={event => setName(event.target.value)} /></div>
      <div className="grid gap-1.5"><Label htmlFor={`${id}-order`}>{t('mail.rules_order')}</Label><Input id={`${id}-order`} type="number" min={1} max={20} value={position} onChange={event => setPosition(event.target.value)} /></div>
      <div className="grid gap-1.5"><Label htmlFor={`${id}-sender`}>{t('mail.rules_sender')}</Label><Input id={`${id}-sender`} type="email" value={sender} maxLength={254} onChange={event => setSender(event.target.value)} /></div>
      <div className="grid gap-1.5"><Label htmlFor={`${id}-subject`}>{t('mail.rules_subject')}</Label><Input id={`${id}-subject`} value={subject} maxLength={200} onChange={event => setSubject(event.target.value)} /></div>
      <div className="grid gap-1.5"><Label htmlFor={`${id}-action`}>{t('mail.rules_action')}</Label><MailSettingsSelect id={`${id}-action`} value={action} onChange={value => { if (value === 'read' || value === 'flag' || value === 'archive' || value === 'snooze') setAction(value); }}>{Object.entries(actions).map(([value, key]) => <option key={value} value={value}>{t(key)}</option>)}</MailSettingsSelect></div>
      {action === 'snooze' && <><div className="grid gap-1.5"><Label htmlFor={`${id}-minutes`}>{t('mail.rules_minutes')}</Label><Input id={`${id}-minutes`} type="number" min={1} max={525600} value={minutes} onChange={event => setMinutes(event.target.value)} /></div><div className="grid gap-1.5"><Label htmlFor={`${id}-zone`}>{t('mail.schedule_zone')}</Label><Input id={`${id}-zone`} value={zone} onChange={event => setZone(event.target.value)} /></div></>}
      <div className="flex items-center justify-between"><Label htmlFor={`${id}-enabled`}>{t('mail.rules_enabled')}</Label><Switch id={`${id}-enabled`} checked={enabled} onCheckedChange={setEnabled} /></div>
    </fieldset>
    {error && <Alert variant="destructive" role="alert">{error}</Alert>}
    <DialogFooter><Button ref={cancel} variant="ghost" disabled={busy} onClick={onClose}>{t('common.cancel')}</Button><Button disabled={busy} onClick={() => void save()}>{t('common.save')}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
