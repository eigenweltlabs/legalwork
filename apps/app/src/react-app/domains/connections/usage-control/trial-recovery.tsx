/** @jsxImportSource react */
"use client";
import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import type { TrialSubscriptionResult, UsageControlView } from "@legalwork/types/usage-control";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { formatEuroCents } from "@/app/lib/eigenwelt-plans";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { CardTopUp } from "./payment-components";
import { UsageRequestForm } from "./request-form";
import { responseUrl, type UsageTransport, type Run } from "./transport";
import { parseTrialSubscriptionResult } from "./trial-recovery-state";
import type { UsageLimitDetails } from "@legalwork/types/provider-usage-limit";

export function TrialRecovery({ view, transport, onRefresh, limit }: {
  view: UsageControlView; transport: UsageTransport; onRefresh: () => Promise<void>; limit?: UsageLimitDetails | null;
}) {
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [requested, setRequested] = useState(false);
  const run: Run = async action => {
    setBusy(true); setError(false);
    try {
      const result = await transport.write(action);
      if (action.action === "checkout" || action.action === "paymentSetup") await transport.open(responseUrl(result));
      if (action.action === "request") setRequested(true);
      return result;
    } catch (err) { setError(true); throw err; }
    finally { setBusy(false); }
  };
  return <div role="status" className="not-prose my-2 space-y-4 rounded-xl border bg-card p-5 text-sm">
    <div className="space-y-1.5">
      <p className="font-medium">{t("limits.trial_used_title")}</p>
      <p className="leading-relaxed text-muted-foreground">{t("limits.trial_used_body", { amount: formatEuroCents(view.me.allowanceCents, locale), plan: view.me.plan === "max" ? "Max" : view.me.plan === "pro" ? "Pro" : "Plus" })}</p>
    </div>
    {view.isAdmin ? <>
      <div className="flex flex-wrap gap-2">
        <StartSubscription transport={transport} onRefresh={onRefresh} />
        <CardTopUp transport={transport} run={run} busy={busy} t={t} triggerSize="sm" triggerVariant="outline" trialUsage
          returnLabel="limits.back_to_chat" limit={limit} onRecoveryChange={next => { if (next.status === "ready") void onRefresh().catch(() => {}); }} />
      </div>
    </> : <div className="space-y-3">
      <p className="text-muted-foreground">{t("limits.trial_admin_hint")}</p>
      <Dialog><DialogTrigger render={<Button size="sm" />}>{t("limits.request")}</DialogTrigger>
        <DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>{t("limits.request")}</DialogTitle><DialogDescription>{t("limits.trial_admin_hint")}</DialogDescription></DialogHeader>
          {requested ? <p>{t("limits.pending")}</p> : <UsageRequestForm run={run} busy={busy} t={t} initialKind="temporary" />}
        </DialogContent>
      </Dialog>
    </div>}
    {error && <p role="alert" className="text-destructive">{t("limits.action_error")}</p>}
  </div>;
}
function StartSubscription({ transport, onRefresh }: { transport: UsageTransport; onRefresh: () => Promise<void> }) {
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<TrialSubscriptionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function execute(action: Parameters<Run>[0]) {
    setBusy(true); setError("");
    try { setResult(parseTrialSubscriptionResult(await transport.write(action))); }
    catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message.includes("quote_changed")) setResult(null);
      else if ("quoteId" in action && action.quoteId) setResult({ status: "processing", quoteId: action.quoteId });
      setError(t(message.includes("payment_method_required") ? "limits.trial_card_required" : "limits.trial_start_error"));
    }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={value => {
    if (busy) return;
    setOpen(value);
    if (value) { setResult(null); void execute({ action: "trialSubscription", preview: true }); }
    else void onRefresh().catch(() => {});
  }}>
    <DialogTrigger render={<Button size="sm" />}>{t("limits.trial_start")}</DialogTrigger>
    <DialogContent className="max-h-[85vh] overflow-y-auto">
      <DialogHeader><DialogTitle>{t(result && "status" in result && result.status === "paid" ? "limits.trial_started" : "limits.trial_start_title")}</DialogTitle>
        <DialogDescription>{t(result && "status" in result && result.status === "paid" ? "limits.trial_started_hint" : "limits.trial_start_hint")}</DialogDescription>
      </DialogHeader>
      {busy && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("limits.payment_loading")}</p>}
      {result && "amountCents" in result && <div className="space-y-4">
        <div className="space-y-3 rounded-xl border bg-muted/30 p-4">
          <div className="flex items-center justify-between gap-4"><span className="text-sm text-muted-foreground">{t("limits.trial_due_today")}</span><span className="text-xl font-semibold">{formatEuroCents(result.amountCents, locale)}</span></div>
          <p className="text-xs text-muted-foreground">{t(result.billingInterval === "year" ? "limits.trial_price_year" : "limits.trial_price_month", { amount: formatEuroCents(result.recurringAmountCents, locale), seats: result.seatCount })}</p>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">{t("limits.trial_confirmation")}</p>
        <Button className="h-auto min-h-9 w-full whitespace-normal py-2" disabled={busy} onClick={() => void execute({ action: "trialSubscription", preview: false, quoteId: result.quoteId, expectedAmountCents: result.amountCents })}>
          {t("limits.trial_pay_start")}
        </Button>
      </div>}
      {result && "status" in result && <div className="space-y-3">
        {result.status === "paid" ? <>
          <p className="flex items-center gap-2 text-sm"><Check className="size-4" />{t("limits.trial_allowance_ready")}</p>
          <Button className="w-full" onClick={() => { setOpen(false); void onRefresh().catch(() => {}); }}>{t("limits.back_to_chat")}</Button>
        </> : result.status === "canceled" ? <p className="text-sm">{t("limits.trial_payment_canceled")}</p> : <>
          <p className="text-sm text-muted-foreground">{t("limits.trial_payment_pending")}</p>
          {result.status === "requires_payment" && <Button className="w-full" onClick={() => void transport.open(responseUrl(result))}>{t("limits.complete_payment")}</Button>}
          <Button className="w-full" variant="outline" disabled={busy} onClick={() => void execute({ action: "resumeTrialSubscription", quoteId: result.quoteId })}>{t("limits.check_payment")}</Button>
          <Button className="w-full" variant="ghost" disabled={busy} onClick={() => void execute({ action: "cancelTrialSubscription", quoteId: result.quoteId })}>{t("limits.trial_cancel_payment")}</Button>
        </>}
      </div>}
      {error && <div className="space-y-3"><p role="alert" className="text-sm text-destructive">{error}</p>
        <Button variant="outline" disabled={busy} onClick={() => void execute(result && "status" in result ? { action: "resumeTrialSubscription", quoteId: result.quoteId } : { action: "trialSubscription", preview: true })}>{t("limits.refresh")}</Button>
        <Button variant="ghost" onClick={() => void transport.write({ action: "paymentSetup" }).then(result => transport.open(responseUrl(result))).catch(() => setError(t("limits.action_error")))}>{t("limits.change_card")}</Button>
      </div>}
    </DialogContent>
  </Dialog>;
}
