import { useCallback, useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import type { UsageControlView } from "@legalwork/types/usage-control";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { openDesktopUrl } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { eigenweltBillingUrl } from "../eigenwelt-entitlements";
import { useDesktopUsageTransport } from "./desktop-transport";
import { MemberPlanChange } from "./member-actions";
import { usageBlockMessageKey } from "./copy";
import { planChangeRecovery } from "./usage-recovery";

/** Uses the same server-authorized quote and confirmation as inline upgrades. */
export function AiPlanUpgradeDialog({ client, workspaceId, platformURL, onClose }: {
  client: LegalworkServerClient;
  workspaceId: string;
  platformURL?: string | null;
  onClose: () => void;
}) {
  useLocale();
  const transport = useDesktopUsageTransport(client, workspaceId);
  const [view, setView] = useState<UsageControlView | null>(null);
  const [confirmedPlan, setConfirmedPlan] = useState<"plus" | "pro" | null>(null);
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try { setView(await transport.read()); setError(""); }
    catch (err) { setError(t("limits.load_error")); throw err; }
  }, [transport]);
  useEffect(() => {
    let active = true;
    void transport.read().then(value => { if (active) setView(value); })
      .catch(() => { if (active) setError(t("limits.load_error")); });
    return () => { active = false; };
  }, [transport]);
  const recovery = confirmedPlan ? planChangeRecovery(view, confirmedPlan) : null;
  const pendingRequest = view?.requests.some(request => request.userId === view.me.userId && request.status === "pending");
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>{t(confirmedPlan ? "provider_limit.plan_updated" : "provider_limit.plans_title")}</DialogTitle>
        <DialogDescription>{confirmedPlan
          ? t("provider_limit.plan_now", { plan: confirmedPlan === "plus" ? "Plus" : "Pro" })
          : t("provider_limit.plans_body")}</DialogDescription>
      </DialogHeader>
      {confirmedPlan ? <div className="space-y-4">
        <p role="status" className="flex items-start gap-2 rounded-xl border bg-muted/30 p-4 text-sm">
          {recovery === "checking" && !error ? <Loader2 className="size-4 shrink-0 animate-spin" /> : <Check className="size-4 shrink-0" />}
          {t(error ? "provider_limit.upgrade_refresh_error" : recovery === "ready" ? "ai_plans.upgrade_ready"
            : recovery === "blocked" && view ? usageBlockMessageKey(view.me.blockedReason, view.isAdmin) : "provider_limit.refreshing_usage")}
        </p>
        {recovery === "checking" && <Button variant="outline" disabled={busy} onClick={() => {
          setBusy(true);
          void refresh().catch(() => {}).finally(() => setBusy(false));
        }}>{t("limits.refresh")}</Button>}
        <Button className="w-full" disabled={busy} onClick={onClose}>{t("common.close")}</Button>
      </div> : <>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {!view ? error ? <Button variant="outline" onClick={() => void refresh().catch(() => {})}>{t("limits.refresh")}</Button>
          : <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t("limits.loading")}</p>
        : !view.enabled ? <Button onClick={() => void openDesktopUrl(eigenweltBillingUrl(platformURL))}>{t("firm_hub.billing")}</Button>
        : view.isAdmin ? <MemberPlanChange transport={transport} refresh={refresh} t={t}
          target={{ kind: "plan", userId: view.me.userId, plan: "plus" }} allowedPlans={["plus", "pro"]}
          onBusyChange={setBusy} onComplete={target => {
            if (target.kind !== "plan" || (target.plan !== "plus" && target.plan !== "pro")) return;
            setView(null);
            setConfirmedPlan(target.plan);
          }} />
        : <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("provider_limit.admin_hint")}</p>
          {requested || pendingRequest ? <p role="status" className="text-sm">{t("limits.pending")}</p>
            : <Button disabled={busy} onClick={() => {
              setBusy(true); setError("");
              void transport.write({ action: "request", kind: "upgrade", amountCents: 0, reason: "" })
                .then(() => setRequested(true)).catch(() => setError(t("limits.action_error")))
                .finally(() => setBusy(false));
            }}>{busy && <Loader2 className="size-4 animate-spin" />}{t("limits.send")}</Button>}
        </div>}
      </>}
    </DialogContent>
  </Dialog>;
}
