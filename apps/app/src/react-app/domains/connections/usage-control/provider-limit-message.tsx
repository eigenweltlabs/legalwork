/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, Plus } from "lucide-react";
import type { UsageControlView } from "@legalwork/types/usage-control";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import type { EigenweltBudgetPlan } from "@/app/lib/eigenwelt-budget";
import { usageLimitOptions } from "@/app/lib/provider-usage-limit";
import { EIGENWELT_PLANS, formatEuroCents } from "@/app/lib/eigenwelt-plans";
import { openDesktopUrl } from "@/app/lib/desktop";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import {
  eigenweltBillingUrl,
  useEigenweltEntitlements,
} from "../eigenwelt-entitlements";
import { responseUrl } from "./transport";
import { UsageRequestForm } from "./request-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useDesktopUsageTransport } from "./desktop-transport";
import { CardTopUp } from "./payment-components";
import { SeatPlanUpgrade, pendingSeatUpgrade } from "./seat-plan-upgrade";
import { AdminUsageIntent } from "./admin-usage-intent";
import { usageIntentForReason, type UsageIntent } from "./usage-intent";
import { usageBlockMessageKey, usageBlockNeedsSettings } from "./usage-block";
import { isCardTopUpAction, planChangeRecovery, usageIsAvailable, type TopUpRecovery } from "./usage-recovery";

const PROVIDER_NAMES: Record<string, string> = {
  openai: "ChatGPT / OpenAI",
  anthropic: "Claude / Anthropic",
  google: "Gemini / Google",
  openrouter: "OpenRouter",
};

export function ProviderLimitMessage({
  client,
  workspaceId,
  plan,
  providerId,
  onChoosePlan,
  resolved = false,
}: {
  client: LegalworkServerClient;
  workspaceId: string;
  plan: EigenweltBudgetPlan;
  providerId: string;
  onChoosePlan?: (plan: "plus" | "pro") => Promise<void>;
  resolved?: boolean;
}) {
  const transport = useDesktopUsageTransport(client, workspaceId);
  const locale = useLocale();
  const account = useEigenweltEntitlements({ client, workspaceId });
  const [view, setView] = useState<UsageControlView | null>(null);
  const [open, setOpen] = useState<"plans" | "admin" | null>(null);
  // Keep the same dialog contents while its closing animation finishes.
  const [dialogKind, setDialogKind] = useState<"plans" | "admin">("plans");
  const [adminIntent, setAdminIntent] = useState<UsageIntent | null>(null);
  const [settingUpdated, setSettingUpdated] = useState(false);
  const [settingChecking, setSettingChecking] = useState(false);
  const [offeredPlans, setOfferedPlans] = useState<Array<"plus" | "pro">>([]);
  const [upgradedPlan, setUpgradedPlan] = useState<"plus" | "pro" | null>(null);
  const [requestSent, setRequestSent] = useState(false);
  const [topUpRecovery, setTopUpRecovery] = useState<TopUpRecovery | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshFailed(false);
    try {
      const next = await transport.read();
      setView(next);
      setSettingChecking(false);
      setTopUpRecovery(previous => previous && previous.status !== "checking"
        ? { status: usageIsAvailable(next) ? "ready" : "blocked", view: next, refreshFailed: false }
        : previous);
    }
    catch (err) { setRefreshFailed(true); throw err; }
    finally { setRefreshing(false); }
  }, [transport]);
  useEffect(() => {
    if (resolved) return;
    let active = true;
    void transport
      .read()
      .then((value) => {
        if (active) setView(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [transport, resolved]);
  const managed = view?.enabled ? view : null;
  const memberRequest = managed !== null && !managed.isAdmin;
  const pendingRequest = requestSent || managed?.requests.some(request => request.userId === managed.me.userId && request.status === "pending");
  const currentPlan = managed ? managed.me.plan === "none" ? null : managed.me.plan : plan;
  const options = usageLimitOptions(currentPlan);
  const recovery = topUpRecovery?.status ?? (upgradedPlan ? planChangeRecovery(view, upgradedPlan)
    : settingUpdated ? settingChecking || !view ? "checking" : usageIsAvailable(view) ? "ready" : "blocked" : null);
  const recovered = resolved || recovery === "ready";
  const topUpReadyHint = providerId === "eigenwelt" ? "limits.topup_ready_hint" : "limits.topup_external_hint";
  const recoveryBody = topUpRecovery ? recovery === "ready" ? t(topUpReadyHint)
    : recovery === "blocked" && topUpRecovery.view ? t(usageBlockMessageKey(topUpRecovery.view.me.blockedReason, topUpRecovery.view.isAdmin))
      : t(topUpRecovery.refreshFailed ? "limits.topup_refresh_error" : "limits.topup_paid_hint")
    : recovery === "ready" ? t(settingUpdated ? "limits.intent_ready" : "provider_limit.usage_available")
    : recovery === "blocked" && managed
      ? t(usageBlockMessageKey(managed.me.blockedReason, managed.isAdmin))
      : refreshFailed ? t(settingUpdated ? "limits.intent_refresh_error" : "provider_limit.upgrade_refresh_error") : t("provider_limit.refreshing_usage");
  const confirmation = upgradedPlan ? (
    <div className="space-y-4">
      <div className="flex items-start gap-3 rounded-xl border bg-muted/30 p-4">
        {refreshing ? <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin" /> : <Check className="mt-0.5 size-5 shrink-0" />}
        <div className="space-y-1">
          <p className="text-sm font-medium">{t(recovery === "ready" ? "provider_limit.usage_ready" : "provider_limit.plan_updated")}</p>
          <p className="text-sm text-muted-foreground">{recoveryBody}</p>
        </div>
      </div>
      {recovery === "checking" && <Button variant="outline" disabled={refreshing} onClick={() => void refresh().catch(() => {})}>
        {refreshing && <Loader2 className="size-4 animate-spin" />}{t("limits.refresh")}
      </Button>}
      <Button className="w-full" disabled={busy} onClick={() => setOpen(null)}>{t("provider_limit.back_to_chat")}</Button>
    </div>
  ) : null;
  const reason = providerId === "eigenwelt" ? managed?.me.blockedReason ?? null : null;
  const needsSettings = usageBlockNeedsSettings(reason);
  const provider = PROVIDER_NAMES[providerId] ?? providerId;
  const updateTopUpRecovery = useCallback((next: TopUpRecovery) => {
    setTopUpRecovery(next);
    if (next.view) setView(next.view);
  }, []);
  async function openManagement(intent = usageIntentForReason(reason)) {
    const url = new URL(eigenweltBillingUrl(account.data?.platformURL));
    url.searchParams.set("tab", intent === "personal" ? "seats" : "extra");
    await openDesktopUrl(url.toString());
  }
  function showDialog(kind: "plans" | "admin") {
    setDialogKind(kind);
    setOpen(kind);
  }
  async function run(action: Parameters<typeof transport.write>[0]) {
    setBusy(true);
    setError("");
    try {
      const result = await transport.write(action);
      if (action.action === "checkout")
        await transport.open(responseUrl(result));
      // Payment success must reach the confirmation even if reading usage fails.
      // CardTopUp checks the verified grant and then publishes the refreshed usage.
      if (action.action === "request") {
        setRequestSent(true);
        void refresh().catch(() => {});
      } else if (!isCardTopUpAction(action)) await refresh();
      return result;
    } catch (err) {
      setError(t("provider_limit.error"));
      throw err;
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      role="status"
      className="not-prose my-2 space-y-4 rounded-xl border border-border bg-card p-4 text-sm"
    >
      <div className="flex items-start gap-3">
        {topUpRecovery?.status === "checking" && !topUpRecovery.refreshFailed || settingChecking && !refreshFailed ? <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" /> : recovered || upgradedPlan || topUpRecovery || settingUpdated ? <Check className="mt-0.5 size-4 shrink-0" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
        <div className="space-y-1">
          <p className="font-medium">
            {resolved ? t("provider_limit.resumed") : topUpRecovery ? t(topUpRecovery.status === "checking" ? "limits.topup_paid" : "limits.credits_added") : settingUpdated ? t(recovered ? "provider_limit.usage_ready" : "limits.intent_saved") : upgradedPlan ? t("provider_limit.plan_now", { plan: upgradedPlan === "pro" ? "Pro" : "Plus" }) : t(
              reason === "member_limit" ? "provider_limit.member_title"
                : reason === "organization_limit" ? "provider_limit.organization_title"
                : reason === "wallet_empty" ? "provider_limit.wallet_title"
                : reason === "extra_disabled" ? "provider_limit.disabled_title"
                : "provider_limit.title",
            )}
          </p>
          {!resolved && <p className="text-muted-foreground">
            {upgradedPlan || topUpRecovery || settingUpdated ? recoveryBody : providerId === "eigenwelt"
              ? reason && managed
                ? t(usageBlockMessageKey(reason, managed.isAdmin))
                : t(managed?.isAdmin ? "provider_limit.eigenwelt_admin_body" : "provider_limit.eigenwelt_body")
              : t("provider_limit.external_body", { provider })}
          </p>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 empty:hidden">
        {!recovered && recovery !== "checking" && <>
        {options.plans.length > 0 && !needsSettings && (
          <Button
            size="sm"
            onClick={() => { setOfferedPlans(options.plans); showDialog("plans"); }}
          >
            {t(
              currentPlan === "plus"
                ? "provider_limit.upgrade_pro"
                : "provider_limit.choose_ai",
            )}
          </Button>
        )}
        {needsSettings && managed?.isAdmin && (
          <Button size="sm" onClick={() => {
            setAdminIntent(usageIntentForReason(reason));
            showDialog("admin");
          }}>
            {t(
              reason === "member_limit" ? "provider_limit.manage_member"
                : reason === "organization_limit" ? "provider_limit.manage_organization"
                : "provider_limit.enable_extra",
            )}
          </Button>
        )}
        {needsSettings && managed?.isAdmin && <Button size="sm" variant="outline" onClick={() => void openManagement()}>{t("limits.manage_platform")}</Button>}
        {options.topUp && managed && !managed.isAdmin && (
          <Button size="sm" onClick={() => showDialog("admin")}>
            <Plus />{t("limits.request")}
          </Button>
        )}
        {options.topUp && !managed && (
          <Button
            size="sm"
            className="self-start disabled:opacity-100"
            disabled={!view}
            onClick={() =>
              void openDesktopUrl(
                eigenweltBillingUrl(account.data?.platformURL),
              )
            }
          >
            <Plus />
            {t("limits.topup")}
          </Button>
        )}
        </>}
        {options.topUp && managed?.isAdmin && (
          <CardTopUp transport={transport} run={run} busy={busy} t={t} triggerSize="sm"
            hideTrigger={recovered || needsSettings || reason === "seat_required" || (!topUpRecovery && recovery === "checking")}
            returnLabel="limits.back_to_chat" readyHint={topUpReadyHint} onRecoveryChange={updateTopUpRecovery} />
        )}
      </div>
      {!resolved && !topUpRecovery && recovery === "checking" && refreshFailed && <Button size="sm" variant="outline" disabled={refreshing} onClick={() => void refresh().catch(() => {})}>{t("limits.refresh")}</Button>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={open !== null}
        onOpenChange={(value) => {
          if (!busy && !value) {
            setOpen(null);
            void refresh().catch(() => {});
          }
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {t(
                memberRequest ? "limits.request" : dialogKind === "plans" && upgradedPlan ? "provider_limit.plan_updated" : dialogKind === "plans"
                  ? "provider_limit.plans_title"
                  : adminIntent === "personal" ? "provider_limit.manage_member"
                    : adminIntent === "organization" ? "provider_limit.manage_organization" : "provider_limit.enable_extra",
              )}
            </DialogTitle>
            <DialogDescription>
              {memberRequest ? t("limits.request_hint") : dialogKind === "plans" && upgradedPlan ? t("provider_limit.plan_now", { plan: upgradedPlan === "pro" ? "Pro" : "Plus" }) : t(
                dialogKind === "plans"
                  ? "provider_limit.plans_body"
                  : managed?.isAdmin && adminIntent
                    ? adminIntent === "personal" ? "limits.intent_personal_hint" : adminIntent === "organization" ? "limits.intent_organization_hint" : "limits.intent_enable_hint"
                  : "limits.request_hint",
              )}
            </DialogDescription>
          </DialogHeader>
          {memberRequest ? pendingRequest ? (
            <div className="space-y-4">
              <p role="status" className="flex items-center gap-2 text-sm"><Check className="size-4" />{t("limits.pending")}</p>
              <Button onClick={() => setOpen(null)}>{t("provider_limit.back_to_chat")}</Button>
            </div>
          ) : (
            <UsageRequestForm key={dialogKind} run={run} busy={busy} t={t} initialKind={dialogKind === "plans" ? "upgrade" : "temporary"} />
          ) : dialogKind === "admin" && managed?.isAdmin && adminIntent ? (
            <AdminUsageIntent key={adminIntent} intent={adminIntent} view={managed} transport={transport} t={t}
              onSaved={() => { setSettingUpdated(true); setSettingChecking(true); }}
              onUpdated={next => { setView(next); setSettingChecking(false); setRefreshFailed(false); }}
              onRefreshError={() => setRefreshFailed(true)}
              onBusyChange={setBusy} onClose={() => setOpen(null)} openManagement={() => openManagement(adminIntent)} />
          ) : confirmation ? confirmation : managed?.isAdmin ? (
            <SeatPlanUpgrade
              transport={transport}
              refresh={refresh}
              t={t}
              userId={managed.me.userId}
              initialPlan={offeredPlans[0] ?? "pro"}
              allowedPlans={offeredPlans}
              pendingChange={pendingSeatUpgrade(managed)}
              onBusyChange={setBusy}
              onComplete={plan => {
                setView(null);
                setUpgradedPlan(plan);
              }}
            />
          ) : (
            <div className="space-y-3">
              {EIGENWELT_PLANS.filter(
                (item) => item.id !== "sync" && offeredPlans.includes(item.id),
              ).map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between gap-4 rounded-xl border p-4"
                >
                  <div>
                    <p className="font-medium">{item.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("provider_limit.plan_price", {
                        amount: formatEuroCents(item.monthlyCents, locale),
                        usage: formatEuroCents(
                          item.includedMonthlyUsageCents,
                          locale,
                        ),
                      })}
                    </p>
                  </div>
                  <Button
                    disabled={busy || !onChoosePlan}
                    onClick={() => {
                      if (item.id === "sync") return;
                      setBusy(true);
                      setError("");
                      void onChoosePlan?.(item.id)
                        .then(() => setOpen(null))
                        .catch(() => setError(t("provider_limit.error")))
                        .finally(() => setBusy(false));
                    }}
                  >
                    {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                    {t("ai_plans.get", { plan: item.name })}
                  </Button>
                </div>
              ))}
              {busy && (
                <p role="status" className="text-sm text-muted-foreground">
                  {t("provider_limit.waiting")}
                </p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
