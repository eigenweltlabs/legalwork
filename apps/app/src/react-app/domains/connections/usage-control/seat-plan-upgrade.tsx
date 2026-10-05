import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import type { MemberPlanQuote, UsageControlView } from "@legalwork/types/usage-control";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { responseUrl, type UsageTransport, type Text } from "./transport";

type AiPlan = "plus" | "pro";
type PendingUpgrade = { quoteId: string; plan: AiPlan; url?: string };
export function pendingSeatUpgrade(view: UsageControlView) {
  for (const op of view.pendingMemberChanges ?? []) {
    if (op.hostedPayment && op.target.kind === "plan" && op.target.userId === view.me.userId &&
        (op.target.plan === "plus" || op.target.plan === "pro")) return { quoteId: op.quoteId, plan: op.target.plan };
  }
}
const money = (cents: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" }).format(cents / 100);

/** Upgrade the signed-in member's seat; team management stays on the platform. */
export function SeatPlanUpgrade({ transport, refresh, t, userId, initialPlan, allowedPlans, pendingChange, onComplete, onBusyChange }: {
  transport: UsageTransport;
  refresh: () => Promise<void>;
  t: Text;
  userId: string;
  initialPlan: AiPlan;
  allowedPlans: readonly AiPlan[];
  pendingChange?: PendingUpgrade;
  onComplete: (plan: AiPlan) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [plan, setPlan] = useState(pendingChange?.plan ?? initialPlan);
  const [quote, setQuote] = useState<MemberPlanQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<PendingUpgrade | null>(pendingChange ?? null);
  const complete = useRef(false);
  const canceledQuote = useRef<string | null>(null);
  const reset = () => { setQuote(null); setError(""); };
  async function paymentResult(result: unknown, selectedPlan: AiPlan, open = false) {
    if (complete.current) return;
    if (typeof result !== "object" || result === null) throw new Error("response");
    if ("ok" in result && result.ok === true) {
      if (complete.current) return;
      complete.current = true;
      onComplete(selectedPlan);
      await refresh().catch(() => {});
    } else if ("status" in result && "quoteId" in result && typeof result.quoteId === "string") {
      if (canceledQuote.current === result.quoteId) return;
      if (result.status === "requires_payment") {
        const url = responseUrl(result);
        setPending({ quoteId: result.quoteId, plan: selectedPlan, url });
        if (open) await transport.open(url);
      } else if (result.status === "processing") setPending({ quoteId: result.quoteId, plan: selectedPlan });
      else if (result.status === "canceled") {
        canceledQuote.current = result.quoteId;
        setPending(null); setQuote(null);
        setError(t("limits.member_payment_canceled_hint"));
      } else throw new Error("response");
    } else throw new Error("response");
  }
  const callbacks = useRef({ paymentResult, t });
  useEffect(() => { callbacks.current = { paymentResult, t }; });
  useEffect(() => {
    if (!pending) return;
    let active = true, running = false;
    const poll = () => {
      if (!active || running || document.visibilityState !== "visible") return;
      running = true;
      void transport.write({ action: "resumeMemberChange", quoteId: pending.quoteId }).then(async result => {
        if (active) { setError(""); await callbacks.current.paymentResult(result, pending.plan); }
      }).catch(() => { if (active) setError(callbacks.current.t("limits.member_payment_check_error")); })
        .finally(() => { running = false; });
    };
    const first = setTimeout(poll, 1000), timer = setInterval(poll, 5000);
    window.addEventListener("focus", poll);
    return () => { active = false; clearTimeout(first); clearInterval(timer); window.removeEventListener("focus", poll); };
  }, [transport, pending?.quoteId]);

  if (pending) return <div className="space-y-4">
    <p role="status" className="flex items-start gap-2 rounded-xl border bg-muted/30 p-4 text-sm">
      <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />{t("limits.member_payment_hint")}
    </p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <div className="flex flex-wrap gap-2">
      {pending.url && <Button disabled={busy} onClick={() => void Promise.resolve(transport.open(pending.url ?? ""))
        .catch(() => setError(t("limits.action_error")))}>{t("limits.continue_checkout")}</Button>}
      <Button variant="outline" disabled={busy} onClick={() => {
        setBusy(true); onBusyChange(true);
        void transport.write({ action: "resumeMemberChange", quoteId: pending.quoteId })
          .then(result => paymentResult(result, pending.plan))
          .catch(() => setError(t("limits.member_payment_check_error")))
          .finally(() => { setBusy(false); onBusyChange(false); });
      }}>{t("limits.check_payment")}</Button>
      <Button variant="ghost" disabled={busy} onClick={() => {
        setBusy(true); onBusyChange(true);
        void transport.write({ action: "cancelMemberChange", quoteId: pending.quoteId })
          .then(result => paymentResult(result, pending.plan))
          .catch(() => setError(t("limits.member_payment_check_error")))
          .finally(() => { setBusy(false); onBusyChange(false); });
      }}>{t("limits.cancel_member_payment")}</Button>
    </div>
  </div>;

  return <form className="space-y-3" onSubmit={event => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    onBusyChange(true);
    setError("");
    void transport.write({ action: "memberChange", target: { kind: "plan", userId, plan }, preview: quote === null,
      ...(quote ? { quoteId: quote.quoteId, expectedAmountCents: quote.amountCents, hostedPayment: true } : {}) }).then(async result => {
      if (quote) {
        // Confirmation replaces this form before refreshing; failed reads
        // cannot turn a successful purchase into a payment retry.
        await paymentResult(result, plan, true);
        return;
      }
      if (typeof result !== "object" || result === null || !("quoteId" in result) || typeof result.quoteId !== "string" || !("amountCents" in result) || typeof result.amountCents !== "number" || !("recurringAmountCents" in result) || typeof result.recurringAmountCents !== "number" || !("billingInterval" in result) || (result.billingInterval !== "month" && result.billingInterval !== "year")) throw new Error("quote");
      canceledQuote.current = null;
      setQuote({ quoteId: result.quoteId, amountCents: result.amountCents, recurringAmountCents: result.recurringAmountCents, billingInterval: result.billingInterval, paymentMethodRequired: "paymentMethodRequired" in result && result.paymentMethodRequired === true });
    }).catch(err => {
      if (err instanceof Error && err.message.includes("payment_method_required")) {
        setQuote(current => current ? { ...current, paymentMethodRequired: true } : null);
        return;
      }
      if (err instanceof Error && /preview_again|quote_expired/.test(err.message)) setQuote(null);
      setError(t("limits.member_change_error"));
    }).finally(() => { setBusy(false); onBusyChange(false); });
  }}>
    <fieldset disabled={busy} className="flex flex-wrap items-end gap-3">
      <label className="grid gap-1 text-sm">{t("limits.seat")}
        <Select value={plan} disabled={busy} items={allowedPlans.map(value => ({ value, label: value === "plus" ? "Plus" : "Pro" }))} onValueChange={value => {
          if (value !== "plus" && value !== "pro") return;
          setPlan(value); reset();
        }}>
          <SelectTrigger className="min-w-32"><SelectValue /></SelectTrigger>
          <SelectContent>{allowedPlans.map(value => <SelectItem key={value} value={value}>{value === "plus" ? "Plus" : "Pro"}</SelectItem>)}</SelectContent>
        </Select>
      </label>
      <Button type="submit" disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />}{t(quote?.paymentMethodRequired ? "limits.continue_checkout" : quote ? "limits.confirm_change" : "limits.preview_purchase")}</Button>
    </fieldset>
    {quote && <div className="space-y-1 rounded-lg border p-3 text-sm"><p>{t("limits.due_today")}: {money(quote.amountCents)}</p><p>{t("limits.organization_total")}: {money(quote.recurringAmountCents)} {t(quote.billingInterval === "year" ? "limits.per_year" : "limits.per_month")}</p><p className="text-xs text-muted-foreground">{t(quote.paymentMethodRequired ? "limits.member_card_required" : "limits.quote_hint")}</p></div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </form>;
}
