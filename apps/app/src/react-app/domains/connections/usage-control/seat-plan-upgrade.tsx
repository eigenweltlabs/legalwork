import { useState } from "react";
import { Loader2 } from "lucide-react";
import type { MemberPlanQuote } from "@legalwork/types/usage-control";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { UsageTransport, Text } from "./transport";

type AiPlan = "plus" | "pro";
const money = (cents: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" }).format(cents / 100);

/** Upgrade the signed-in member's seat; team management stays on the platform. */
export function SeatPlanUpgrade({ transport, refresh, t, userId, initialPlan, allowedPlans, onComplete, onBusyChange }: {
  transport: UsageTransport;
  refresh: () => Promise<void>;
  t: Text;
  userId: string;
  initialPlan: AiPlan;
  allowedPlans: readonly AiPlan[];
  onComplete: (plan: AiPlan) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [plan, setPlan] = useState(initialPlan);
  const [quote, setQuote] = useState<MemberPlanQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const reset = () => { setQuote(null); setError(""); };

  return <form className="space-y-3" onSubmit={event => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    onBusyChange(true);
    setError("");
    void transport.write({ action: "memberChange", target: { kind: "plan", userId, plan }, preview: quote === null,
      ...(quote ? { quoteId: quote.quoteId, expectedAmountCents: quote.amountCents } : {}) }).then(async result => {
      if (quote) {
        // Confirmation replaces this form before refreshing; failed reads
        // cannot turn a successful purchase into a payment retry.
        onComplete(plan);
        await refresh().catch(() => {});
        return;
      }
      if (typeof result !== "object" || result === null || !("quoteId" in result) || typeof result.quoteId !== "string" || !("amountCents" in result) || typeof result.amountCents !== "number" || !("recurringAmountCents" in result) || typeof result.recurringAmountCents !== "number" || !("billingInterval" in result) || (result.billingInterval !== "month" && result.billingInterval !== "year")) throw new Error("quote");
      setQuote({ quoteId: result.quoteId, amountCents: result.amountCents, recurringAmountCents: result.recurringAmountCents, billingInterval: result.billingInterval });
    }).catch(err => {
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
      <Button type="submit" disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />}{t(quote ? "limits.confirm_change" : "limits.preview_purchase")}</Button>
    </fieldset>
    {quote && <div className="space-y-1 rounded-lg border p-3 text-sm"><p>{t("limits.due_today")}: {money(quote.amountCents)}</p><p>{t("limits.organization_total")}: {money(quote.recurringAmountCents)} {t(quote.billingInterval === "year" ? "limits.per_year" : "limits.per_month")}</p><p className="text-xs text-muted-foreground">{t("limits.quote_hint")}</p></div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </form>;
}
