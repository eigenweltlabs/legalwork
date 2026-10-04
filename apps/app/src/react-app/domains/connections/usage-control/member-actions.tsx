/** @jsxImportSource react */
import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import type { MemberPlanTarget, MemberPlanQuote } from "@legalwork/types/usage-control";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { UsageTransport, UsageTextKey } from "./transport";

type Plan = "sync" | "plus" | "pro";
const money = (cents: number) => new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" }).format(cents / 100);

export function MemberPlanChange({ transport, refresh, t, target, invite = false, allowedPlans = ["sync", "plus", "pro"], onComplete, onBusyChange }: {
  transport: UsageTransport;
  refresh: () => Promise<void>;
  t: (key: UsageTextKey) => string;
  target?: MemberPlanTarget;
  invite?: boolean;
  allowedPlans?: Plan[];
  onComplete?: (target: MemberPlanTarget) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [plan, setPlan] = useState<Plan>(target?.kind === "plan" && target.plan !== "none" && allowedPlans.includes(target.plan) ? target.plan : allowedPlans[0] ?? "plus");
  const [quote, setQuote] = useState<(MemberPlanQuote & { target: MemberPlanTarget }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [error, setError] = useState("");
  const reset = () => { setQuote(null); setError(""); setCompleted(false); };

  return <form className="space-y-3" onChange={reset} onSubmit={event => {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const actionTarget: MemberPlanTarget = quote?.target ?? (invite
      ? { kind: "invite", email: String(form.get("email") ?? "").trim().toLowerCase(), plan, role: "org:member" }
      : target?.kind === "plan" ? { ...target, plan: target.requestId ? target.plan : plan }
      : target ?? { kind: "invite", email: "", plan, role: "org:member" });
    setBusy(true);
    onBusyChange?.(true);
    setError("");
    void transport.write({ action: "memberChange", target: actionTarget, preview: quote === null, ...(quote ? { quoteId: quote.quoteId, expectedAmountCents: quote.amountCents } : {}) }).then(async result => {
      if (quote) {
        setQuote(null);
        setCompleted(true);
        // The server has confirmed the change. A failed usage refresh must never
        // turn a successful purchase back into a payment retry.
        onComplete?.(actionTarget);
        try { await refresh(); }
        catch { setError(t("limits.change_refresh_error")); }
        return;
      }
      if (typeof result !== "object" || result === null || !("quoteId" in result) || typeof result.quoteId !== "string" || !("amountCents" in result) || typeof result.amountCents !== "number" || !("recurringAmountCents" in result) || typeof result.recurringAmountCents !== "number" || !("billingInterval" in result) || (result.billingInterval !== "month" && result.billingInterval !== "year")) throw new Error("quote");
      setQuote({ quoteId: result.quoteId, amountCents: result.amountCents, recurringAmountCents: result.recurringAmountCents, billingInterval: result.billingInterval, target: actionTarget });
    }).catch(err => {
      if (err instanceof Error && /preview_again|quote_expired/.test(err.message)) setQuote(null);
      setError(t("limits.member_change_error"));
    }).finally(() => { setBusy(false); onBusyChange?.(false); });
  }}>
    {completed && <p role="status" className="flex items-center gap-2 text-sm"><Check className="size-4" />{t(invite ? "limits.invitation_sent" : "limits.plan_updated")}</p>}
    <fieldset disabled={busy} className="flex flex-wrap items-end gap-3">
      {invite && <label className="grid gap-1 text-sm">{t("limits.email")}<Input name="email" type="email" required /></label>}
      {(!target || target.kind === "plan" && !target.requestId) && <label className="grid gap-1 text-sm">{t("limits.seat")}
        <Select value={plan} disabled={busy} items={allowedPlans.map(value => ({ value, label: value === "sync" ? "Sync" : value === "plus" ? "Plus" : "Pro" }))} onValueChange={value => {
          if (value !== "sync" && value !== "plus" && value !== "pro") return;
          setPlan(value); reset();
        }}>
          <SelectTrigger className="min-w-32"><SelectValue /></SelectTrigger>
          <SelectContent>{allowedPlans.map(value => <SelectItem key={value} value={value}>{value === "sync" ? "Sync" : value === "plus" ? "Plus" : "Pro"}</SelectItem>)}</SelectContent>
        </Select>
      </label>}
      <Button type="submit" disabled={busy}>{busy && <Loader2 className="size-4 animate-spin" />}{quote ? (invite ? t("limits.confirm_invite") : t("limits.confirm_change")) : t("limits.preview_purchase")}</Button>
    </fieldset>
    {quote && <div className="space-y-1 rounded-lg border p-3 text-sm"><p>{t("limits.due_today")}: {money(quote.amountCents)}</p><p>{t("limits.organization_total")}: {money(quote.recurringAmountCents)} {t(quote.billingInterval === "year" ? "limits.per_year" : "limits.per_month")}</p><p className="text-xs text-muted-foreground">{t("limits.quote_hint")}</p></div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </form>;
}
