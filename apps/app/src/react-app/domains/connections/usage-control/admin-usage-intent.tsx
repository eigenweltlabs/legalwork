import { useState, type FormEvent } from "react";
import { Check, ExternalLink, Loader2 } from "lucide-react";
import type { UsageControlView } from "@legalwork/types/usage-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseUsageAmount, type Text, type UsageTransport } from "./transport";
import { usageIntentAction, type UsageIntent } from "./usage-intent";
import { usageIsAvailable } from "./usage-recovery";
import { usageBlockMessageKey } from "./usage-block";

export function AdminUsageIntent({ intent, view, transport, t, onSaved, onUpdated, onRefreshError, onBusyChange, onClose, openManagement }: {
  intent: UsageIntent; view: UsageControlView; transport: UsageTransport; t: Text;
  onSaved: () => void; onUpdated: (view: UsageControlView) => void;
  onRefreshError: () => void;
  onBusyChange: (busy: boolean) => void; onClose: () => void; openManagement: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false), [saved, setSaved] = useState(false), [error, setError] = useState("");
  const [updated, setUpdated] = useState<UsageControlView | null>(null);
  const current = intent === "personal" ? view.me.baseExtraLimitCents : view.orgExtraLimitCents;
  const used = intent === "personal" ? view.me.extraUsedCents : view.orgExtraUsedCents ?? 0;
  const suggested = Math.min(5_000_000, Math.max(current ?? 0, used) + 3000) / 100;
  const setWorking = (value: boolean) => { setBusy(value); onBusyChange(value); };
  async function checkUsage() {
    try {
      const next = await transport.read();
      setUpdated(next); onUpdated(next); setError("");
    } catch { setError(t("limits.intent_refresh_error")); onRefreshError(); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || saved) return;
    setError("");
    let action: ReturnType<typeof usageIntentAction>;
    try { action = usageIntentAction(view, intent, intent === "enable" ? 0 : parseUsageAmount(new FormData(event.currentTarget).get("limit"))); }
    catch { setError(t("limits.intent_invalid_limit")); return; }
    setWorking(true);
    try {
      await transport.write(action);
      setSaved(true); onSaved();
      await checkUsage();
    } catch { setError(t("limits.action_error")); }
    finally { setWorking(false); }
  }
  return <div className="space-y-4">
    {saved ? <div className="space-y-4">
      <p role="status" className="flex items-center gap-2 font-medium"><Check className="size-4" />{t(intent === "enable" ? "limits.intent_enabled" : "limits.intent_increased")}</p>
      <p className="text-sm text-muted-foreground">{updated ? t(usageIsAvailable(updated) ? "limits.intent_ready" : usageBlockMessageKey(updated.me.blockedReason, updated.isAdmin)) : t(error ? "limits.intent_refresh_error" : "limits.intent_checking")}</p>
      {!updated && <Button variant="outline" disabled={busy} onClick={() => {
        setWorking(true); void checkUsage().finally(() => setWorking(false));
      }}>{busy && <Loader2 className="size-4 animate-spin" />}{t("limits.refresh")}</Button>}
      <Button disabled={busy} onClick={onClose}>{t("limits.back_to_chat")}</Button>
    </div> : <form className="space-y-4" onSubmit={event => void submit(event)} aria-busy={busy}>
      {intent !== "enable" && <>
        <p className="text-sm text-muted-foreground">{t("limits.intent_current")}: {current === null ? t("limits.intent_unlimited") : new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" }).format(current / 100)}</p>
        <label className="grid gap-2 text-sm">{t("limits.intent_new_limit")}<Input name="limit" inputMode="decimal" defaultValue={suggested} disabled={busy} /></label>
      </>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />}{t(intent === "enable" ? "limits.intent_enable" : "limits.intent_increase")}</Button>
    </form>}
    <Button variant="link" className="h-auto p-0 text-muted-foreground" disabled={busy} onClick={() => void openManagement()}><ExternalLink className="size-4" />{t("limits.manage_platform")}</Button>
  </div>;
}
