/** @jsxImportSource react */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { t } from '@/i18n';
import type { MailClient } from '../../mail/mail-client';
import { changeMailClassification, mailClassificationActivity } from '../../mail/mail-classifier-client';
import type { mailClassifierOutcomeSchema } from '../../../../../../server/src/mail/classifier-incoming-view';
import { MailSettingsSelect } from './mail-settings-controls';
import { MailClassifierError } from '../../../../../../server/src/mail/classifier-view';
function classifierError(error:unknown){return t(error instanceof MailClassifierError&&error.code==='conflict'?'mail.classifier_conflict':'mail.classifier_failed');}

type Page = Awaited<ReturnType<typeof mailClassificationActivity>>;
type Filter = 'review' | 'assigned' | 'all';
const outcomeKeys = {
  pending: 'mail.classifier_pending', assigned: 'mail.classifier_assigned', ambiguous: 'mail.classifier_ambiguous',
  below_threshold: 'mail.classifier_below_threshold', unmatched: 'mail.classifier_unmatched', excluded: 'mail.classifier_excluded',
  manual: 'mail.classifier_manual', connection_changed: 'mail.classifier_connection_changed', config_changed: 'mail.classifier_config_changed',
  removed: 'mail.classifier_removed', unavailable: 'mail.project_unavailable', expired: 'mail.classifier_expired',
  not_inbox: 'mail.classifier_not_inbox', historical: 'mail.classifier_historical', corrected: 'mail.classifier_corrected',
  cleared: 'mail.classifier_cleared', dismissed: 'mail.classifier_dismissed', undone: 'mail.classifier_undone',
} satisfies Record<import('zod').infer<typeof mailClassifierOutcomeSchema>, Parameters<typeof t>[0]>;

export function MailClassifierActivityView({ client, accountId, revision }: { client: MailClient; accountId: string; revision: number }) {
  const [filter, setFilter] = useState<Filter>('review');
  return <div className="space-y-3 border-t border-border pt-4">
    <h3 className="text-sm font-medium">{t('mail.classifier_activity')}</h3>
    <MailSettingsSelect aria-label={t('mail.classifier_activity_filter')} value={filter} onChange={value => { if (value === 'review' || value === 'assigned' || value === 'all') setFilter(value); }}>
      <option value="review">{t('mail.classifier_review')}</option><option value="assigned">{t('mail.classifier_assignments')}</option><option value="all">{t('mail.classifier_all')}</option>
    </MailSettingsSelect>
    <ActivityPage key={`${accountId}:${filter}`} client={client} accountId={accountId} filter={filter} revision={revision}/>
  </div>;
}

function ActivityPage({ client, accountId, filter, revision }: { client: MailClient; accountId: string; filter: Filter; revision: number }) {
  const navigate = useNavigate(), [page, setPage] = useState<Page | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const controller = useRef(new AbortController()), epoch = useRef(0), lock = useRef(false), expanded = useRef(false), focusRefresh = useRef(false), refresh = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { if (focusRefresh.current) { focusRefresh.current = false; refresh.current?.focus(); } }, [page]);
  async function load(beforeId?: number, focus=false) {
    const signal=controller.current.signal;
    const value = await mailClassificationActivity(client, accountId, signal, { filter, ...(beforeId ? { beforeId } : {}) });
    if (!signal.aborted) { focusRefresh.current=focus||beforeId!==undefined&&value.nextCursor===null; expanded.current = beforeId !== undefined; setPage(previous => beforeId && previous ? { ...value, items: [...previous.items, ...value.items] } : value); }
  }
  async function run(operation: () => Promise<void>) {
    if (lock.current) return;
    const generation=epoch.current,signal=controller.current.signal;
    lock.current = true; setBusy(true); setError('');
    try { await operation(); } catch (error) { if (!signal.aborted&&generation===epoch.current) setError(classifierError(error)); }
    finally { if(generation===epoch.current){lock.current = false; if (!signal.aborted) setBusy(false);} }
  }
  useEffect(() => {
    const abort = new AbortController(); controller.current = abort; epoch.current++;lock.current=false;
    void run(() => load());
    const timer = setInterval(() => { if (!lock.current && !expanded.current) void run(() => load()); }, 5000);
    return () => { epoch.current++;abort.abort(); clearInterval(timer); };
  }, [client, accountId, filter]);
  useEffect(()=>{expanded.current=false;void run(()=>load());},[revision]);
  async function act(item: Page['items'][number], action: 'undo' | 'dismiss') {
    await changeMailClassification(client, accountId, controller.current.signal, action, { id: item.id, expected: item.version, assignmentVersion: item.assignmentVersion });
    await load(undefined,true);
  }
  return <div className="space-y-2" aria-busy={busy}>
    <Button ref={refresh} size="sm" variant="ghost" aria-disabled={busy} onClick={() => void run(() => load())}>{t('mail.rules_refresh')}</Button>
    {page && !page.items.length && <p role="status" className="text-sm text-muted-foreground">{t('mail.classifier_activity_empty')}</p>}
    <div className="divide-y divide-border">{page?.items.map(item => <div key={item.id} className="flex flex-wrap items-center gap-2 py-3">
      <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{item.subject || t('mail.classifier_no_subject')}</p><p className="break-words text-xs text-muted-foreground">{t(outcomeKeys[item.outcome])}{item.project ? ` · ${item.project.name}` : item.unavailable ? ` · ${t('mail.project_unavailable')}` : ''}</p><time className="text-xs text-muted-foreground">{new Date(item.at).toLocaleString()}</time></div>
      <Button size="sm" variant="ghost" onClick={() => navigate('/mail', { state: { mailNotificationTarget: { serverOrigin: client.serverOrigin, accountId, locator: item.locator } } })}>{t('mail.classifier_open')}</Button>
      {item.canUndo && <Button size="sm" variant="outline" aria-disabled={busy} onClick={() => void run(() => act(item, 'undo'))}>{t('mail.classifier_undo')}</Button>}
      {item.canDismiss && <Button size="sm" variant="ghost" aria-disabled={busy} onClick={() => void run(() => act(item, 'dismiss'))}>{t('mail.classifier_dismiss')}</Button>}
    </div>)}</div>
    {page?.nextCursor && <Button size="sm" variant="ghost" aria-disabled={busy} onClick={() => void run(() => load(page.nextCursor ?? undefined))}>{t('mail.classifier_earlier')}</Button>}
    {error && <Alert variant="destructive" role="alert">{error}</Alert>}
  </div>;
}
