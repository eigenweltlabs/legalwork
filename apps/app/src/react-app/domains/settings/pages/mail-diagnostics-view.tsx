/** @jsxImportSource react */
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import type { MailClient } from '../../mail/mail-client';
import { MailSettingsSection } from './mail-settings-controls';

export function MailDiagnosticsView({ client }: { client: MailClient }) {
  const active = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'saved' | 'failed' | null>(null);
  useEffect(() => () => { active.current?.abort(); active.current = null; }, [client]);
  async function download() {
    if (active.current) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setResult(null);
    try {
      const report = await client.diagnostics(controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' }));
      try {
        const link = document.createElement('a');
        link.href = url;
        link.download = `legalwork-mail-diagnostics-${report.generatedAt.slice(0, 10)}.json`;
        document.body.appendChild(link);
        try { link.click(); } finally { link.remove(); }
      } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
      setResult('saved');
    } catch { if (!controller.signal.aborted) setResult('failed'); }
    finally { if (active.current === controller) { active.current = null; setBusy(false); } }
  }
  return <MailSettingsSection title={t('mail.diagnostics_title')}>
    <Button variant="outline" disabled={busy} onClick={() => void download()}>{t(busy ? 'mail.diagnostics_exporting' : 'mail.diagnostics_export')}</Button>
    {result && <p className={result === 'failed' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'} role={result === 'failed' ? 'alert' : 'status'}>{t(result === 'failed' ? 'mail.diagnostics_failed' : 'mail.diagnostics_saved')}</p>}
  </MailSettingsSection>;
}
