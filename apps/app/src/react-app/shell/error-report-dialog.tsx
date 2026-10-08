import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ErrorDiagnostic } from "@legalwork/types/error-report";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/sonner";
import { useLocale } from "@/i18n/use-locale";
import { t } from "@/i18n";
import { makeManualErrorEvent, sendManualErrorEvent } from "@/app/lib/analytics";
import {
  clearLocalErrorReports, closeErrorReport, getErrorReports, getSelectedErrorId,
  openErrorReport, subscribeErrorReports,
} from "@/app/lib/error-reports";

function ErrorReportDialog({ diagnostic }: { diagnostic: ErrorDiagnostic }) {
  const [eventId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const downloadUrls = useRef<string[]>([]);
  useEffect(() => () => {
    for (const url of downloadUrls.current) URL.revokeObjectURL(url);
  }, []);
  const preview = JSON.stringify(makeManualErrorEvent(diagnostic, eventId), null, 2);
  async function send() {
    if (busy || sent) return;
    setBusy(true); setFailed(false);
    try { setSent(await sendManualErrorEvent(diagnostic, eventId)); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(preview); setCopied(true); }
    catch { setCopied(false); } // Save remains available if the clipboard is blocked.
  }
  async function save() {
    const nativeSave = window.__LEGALWORK_ELECTRON__?.saveErrorDetails;
    if (nativeSave) {
      try { await nativeSave(preview); }
      catch { toast.error(t("skill_resources.save_failed"), { reportable: false }); }
      return;
    }
    const url = URL.createObjectURL(new Blob([preview], { type: "application/json" }));
    // Keep browser downloads alive while the report dialog is mounted.
    downloadUrls.current.push(url);
    const link = document.createElement("a");
    link.href = url; link.download = `legalwork-error-${eventId}.json`; link.click();
  }
  return (
    <Dialog open onOpenChange={open => { if (!open && !busy) closeErrorReport(); }}>
      <DialogContent portalClassName="relative z-[1100]" className="flex max-h-[calc(100dvh-2rem)] max-w-lg flex-col gap-4 overflow-hidden sm:max-w-lg" showCloseButton={!busy}>
        <DialogHeader className="shrink-0">
          <DialogTitle>{sent ? t("error_report.sent_title") : t("error_report.title")}</DialogTitle>
          <DialogDescription>{t("error_report.privacy")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto pe-1">
        {sent ? (
          <div role="status" className="space-y-2 rounded-xl border border-emerald-7/30 bg-emerald-3/30 p-4">
            <p>{t("error_report.sent")}</p>
            <p className="break-all font-mono text-xs">{t("error_report.number", { id: sent })}</p>
          </div>
        ) : (
          <>
            <div className="rounded-xl border border-border bg-muted/30 p-4">
              <p className="text-sm font-medium">{t(`error_report.reason.${diagnostic.code}`)}</p>
              <p className="mt-2 text-xs text-muted-foreground">{t("error_report.context", { component: diagnostic.component, code: diagnostic.status_code === null ? diagnostic.code : String(diagnostic.status_code) })}</p>
            </div>
          </>
        )}
        <details className="rounded-xl border border-border p-3">
          <summary className="cursor-pointer text-sm font-medium">{t("error_report.preview")}</summary>
          <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap break-all text-xs text-muted-foreground">{preview}</pre>
        </details>
        {failed ? <p role="alert" className="text-sm text-red-11">{t("error_report.failed")}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => void copy()}>{t(copied ? "error_report.copied" : "error_report.copy")}</Button>
          <Button variant="outline" size="sm" onClick={() => void save()}>{t("error_report.save")}</Button>
        </div>
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="outline" onClick={closeErrorReport} disabled={busy}>{t(sent ? "common.close" : "common.cancel")}</Button>
          {!sent ? <Button onClick={() => void send()} disabled={busy}>{t(busy ? "error_report.sending" : failed ? "error_report.retry" : "error_report.send")}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Outside the application's error boundary so render crashes remain reportable. */
export function ErrorReportHost() {
  useLocale();
  const incidents = useSyncExternalStore(subscribeErrorReports, getErrorReports, getErrorReports);
  const selectedId = useSyncExternalStore(subscribeErrorReports, getSelectedErrorId, getSelectedErrorId);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    for (const incident of incidents) {
      if (seen.current.has(incident.incident_id)) continue;
      seen.current.add(incident.incident_id);
      if (incident.code === "cancelled" || incident.source === "handled" || incident.source === "server_request") continue;
      toast.error(t(`error_report.reason.${incident.code}`), {
        id: `diagnostic:${incident.fingerprint}`, reportable: false,
        action: { label: t("error_report.share"), onClick: () => openErrorReport(incident.incident_id) },
      });
    }
    // Keep the notification guard bounded along with the local registry.
    if (seen.current.size > 100) seen.current = new Set(incidents.map(item => item.incident_id));
  }, [incidents]);
  const selected = incidents.find(item => item.incident_id === selectedId);
  return selected ? <ErrorReportDialog key={selected.incident_id} diagnostic={selected} /> : null;
}

export function RecentErrorsButton() {
  const incidents = useSyncExternalStore(subscribeErrorReports, getErrorReports, getErrorReports);
  // Repeated failed requests must not crowd the original crash out of history.
  const recent = [...new Map(incidents.map(incident => [incident.fingerprint, incident])).values()]
    .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t("error_report.local_only")}</p>
      {recent.map(incident => (
        <Button key={incident.incident_id} variant="outline" size="sm" className="me-2" onClick={() => openErrorReport(incident.incident_id)}>
          {t(`error_report.reason.${incident.code}`)}
        </Button>
      ))}
      {incidents.length ? <Button variant="ghost" size="sm" onClick={clearLocalErrorReports}>{t("error_report.clear")}</Button> : null}
      {!incidents.length ? <p className="text-sm text-muted-foreground">{t("error_report.none")}</p> : null}
    </div>
  );
}
