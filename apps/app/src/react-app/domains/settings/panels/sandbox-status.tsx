import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";

export function SandboxStatus({ client }: { client: LegalworkServerClient }) {
  const [status, setStatus] = useState<Awaited<ReturnType<LegalworkServerClient["sandboxStatus"]>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void client.sandboxStatus().then((value) => { if (!cancelled) setStatus(value); })
      .catch(() => { if (!cancelled) setError(t("sandbox.status_unavailable")); });
    return () => { cancelled = true; };
  }, [client]);
  if (status && !status.enabled) return null;
  return <div className="rounded-2xl border border-subtle bg-surface p-4" aria-live="polite">
    <div className="font-medium text-ink">{t("sandbox.title")}</div>
    <p className="mt-1 text-sm text-subtext">{t("sandbox.description")}</p>
    <p className="mt-2 text-sm text-subtext">{busy ? t("sandbox.preparing") : ready ? t("sandbox.ready") : status?.available ? t("sandbox.available") : t("sandbox.setup")}</p>
    {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
    <div className="mt-3 flex items-center gap-3">
      <Button variant="outline" size="sm" disabled={busy} onClick={() => {
        setBusy(true); setError(null);
        void client.prepareSandbox().then(() => { setReady(true); })
          .catch((error: unknown) => setError(error instanceof Error ? error.message : t("sandbox.status_unavailable")))
          .finally(() => setBusy(false));
      }}>{t("sandbox.prepare")}</Button>
    </div>
  </div>;
}
