/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { EIGENWELT_PLANS, formatEuroCents } from "@/app/lib/eigenwelt-plans";
import { openDesktopUrl } from "@/app/lib/desktop";
import { hasEndedEigenweltSubscription } from "@/app/lib/eigenwelt-subscription";
import { isEigenweltEntitledStatus } from "@/app/lib/eigenwelt-trial";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { eigenweltBillingUrl, useEigenweltEntitlements } from "../eigenwelt-entitlements";

/** Expiry uses the same neutral card and primary actions as usage limits.
 * The account carries the role because usage controls require a live plan. */
export function SubscriptionEndedMessage({ client, workspaceId, onChoosePlan, resolved = false }: {
  client: LegalworkServerClient;
  workspaceId: string;
  onChoosePlan?: (plan: "plus" | "pro") => Promise<void>;
  resolved?: boolean;
}) {
  const locale = useLocale();
  const account = useEigenweltEntitlements({ client, workspaceId });
  const [confirmedEnded, setConfirmedEnded] = useState(() => hasEndedEigenweltSubscription(account.data));
  useEffect(() => {
    if (hasEndedEigenweltSubscription(account.data)) setConfirmedEnded(true);
  }, [account.data]);
  const restored = resolved || confirmedEnded && Boolean(account.data?.connected &&
    isEigenweltEntitledStatus(account.data.entitlements?.subscriptionStatus));
  const role = account.data?.account?.orgRole;
  const admin = role === "org:admin";
  const member = Boolean(role) && !admin;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const firm = account.data?.account?.orgName ?? t("ai_plans.your_firm");
  const request = t("subscription_ended.request_text", { firm });
  return <div role="status" className="not-prose my-2 space-y-4 rounded-xl border border-border bg-card p-4 text-sm text-foreground">
    <div className="flex items-start gap-3">
      {restored ? <Check className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
      <div className="space-y-1">
        <p className="font-medium">{t(restored ? "subscription_ended.restored" : "ai_plans.title_ended")}</p>
        {!restored && <p className="text-muted-foreground">{t(admin ? "subscription_ended.admin_body" : "subscription_ended.member_body", { firm })}</p>}
      </div>
    </div>
    {!restored && <Button size="sm" disabled={account.isPending || busy} onClick={() => {
      setError("");
      if (role) setOpen(true);
      else void openDesktopUrl(eigenweltBillingUrl(account.data?.platformURL));
    }}>{t(admin ? "subscription_ended.restart" : member ? "provider_limit.request" : "subscription_ended.view_plans")}</Button>}
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t(member ? "provider_limit.request" : "provider_limit.plans_title")}</DialogTitle>
          <DialogDescription>{t(member ? "subscription_ended.member_help" : "subscription_ended.admin_body", { firm })}</DialogDescription>
        </DialogHeader>
        {member ? <div className="space-y-4">
          <p className="rounded-xl border bg-muted/30 p-4 text-sm">{request}</p>
          <Button onClick={() => {
            void navigator.clipboard.writeText(request).then(() => { setCopied(true); setError(""); })
              .catch(() => setError(t("subscription_ended.copy_error")));
          }}>{copied ? <Check className="size-4" /> : null}{t(copied ? "subscription_ended.copied" : "subscription_ended.copy_request")}</Button>
        </div> : <div className="space-y-3">
          {EIGENWELT_PLANS.filter(item => item.id !== "sync").map(item => <div key={item.id} className="flex items-center justify-between gap-4 rounded-xl border p-4">
            <div>
              <p className="font-medium">{item.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("provider_limit.plan_price", {
                amount: formatEuroCents(item.monthlyCents, locale),
                usage: formatEuroCents(item.includedMonthlyUsageCents, locale),
              })}</p>
            </div>
            <Button disabled={busy || !onChoosePlan} onClick={() => {
              if (item.id === "sync") return;
              setBusy(true); setError("");
              void onChoosePlan?.(item.id).then(() => setOpen(false))
                .catch(() => setError(t("provider_limit.error"))).finally(() => setBusy(false));
            }}>{busy ? <Loader2 className="size-4 animate-spin" /> : null}{t("ai_plans.restart", { plan: item.name })}</Button>
          </div>)}
          {busy && <p className="text-sm text-muted-foreground">{t("provider_limit.waiting")}</p>}
        </div>}
        {error && <p role="alert" className="text-sm text-muted-foreground">{error}</p>}
      </DialogContent>
    </Dialog>
  </div>;
}
