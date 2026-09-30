/** @jsxImportSource react */
import { useEffect, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
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
import { responseUrl } from "./panel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { DesktopUsagePanel, useDesktopUsageTransport } from "./desktop-panel";
import { CardTopUp } from "./payment-components";
import { MemberPlanChange } from "./member-actions";

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
}: {
  client: LegalworkServerClient;
  workspaceId: string;
  plan: EigenweltBudgetPlan;
  providerId: string;
  onChoosePlan?: (plan: "plus" | "pro") => Promise<void>;
}) {
  const transport = useDesktopUsageTransport(client, workspaceId);
  const locale = useLocale();
  const account = useEigenweltEntitlements({ client, workspaceId });
  const [view, setView] = useState<UsageControlView | null>(null);
  const [open, setOpen] = useState<"plans" | "admin" | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const options = usageLimitOptions(plan);
  const refresh = async () => {
    setView(await transport.read());
  };
  useEffect(() => {
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
  }, [transport]);
  const managed = view?.enabled ? view : null;
  const provider = PROVIDER_NAMES[providerId] ?? providerId;
  async function run(action: Parameters<typeof transport.write>[0]) {
    setBusy(true);
    setError("");
    try {
      const result = await transport.write(action);
      if (action.action === "checkout")
        await transport.open(responseUrl(result));
      await refresh();
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
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="space-y-1">
          <p className="font-medium">{t("provider_limit.title")}</p>
          <p className="text-muted-foreground">
            {providerId === "eigenwelt"
              ? t(managed?.isAdmin ? "provider_limit.eigenwelt_admin_body" : "provider_limit.eigenwelt_body")
              : t("provider_limit.external_body", { provider })}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {options.plans.length > 0 && (
          <Button
            size="sm"
            onClick={() => setOpen("plans")}
          >
            {t(
              plan === "plus"
                ? "provider_limit.upgrade_pro"
                : "provider_limit.choose_ai",
            )}
          </Button>
        )}
        {options.topUp && managed?.isAdmin && (
          <CardTopUp transport={transport} run={run} busy={busy} t={t} triggerSize="sm" />
        )}
        {options.topUp && managed && !managed.isAdmin && (
          <Button size="sm" variant="outline" onClick={() => setOpen("admin")}>
            {t("provider_limit.request")}
          </Button>
        )}
        {options.topUp && !managed && (
          <Button
            size="sm"
            variant="outline"
            disabled={!view}
            onClick={() =>
              void openDesktopUrl(
                eigenweltBillingUrl(account.data?.platformURL),
              )
            }
          >
            {t("limits.topup")}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={open !== null}
        onOpenChange={(value) => {
          if (!busy && !value) setOpen(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {t(
                open === "plans"
                  ? "provider_limit.plans_title"
                  : "limits.title",
              )}
            </DialogTitle>
            <DialogDescription>
              {t(
                open === "plans"
                  ? "provider_limit.plans_body"
                  : "limits.request_hint",
              )}
            </DialogDescription>
          </DialogHeader>
          {open === "admin" ? (
            <DesktopUsagePanel client={client} workspaceId={workspaceId} showHeading={false} />
          ) : managed?.isAdmin ? (
            <MemberPlanChange
              transport={transport}
              refresh={refresh}
              t={t}
              target={{
                kind: "plan",
                userId: managed.me.userId,
                plan: options.plans[0] ?? "pro",
              }}
              allowedPlans={options.plans}
            />
          ) : managed ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {t("provider_limit.admin_hint")}
              </p>
              <DesktopUsagePanel client={client} workspaceId={workspaceId} showHeading={false} />
            </div>
          ) : (
            <div className="space-y-3">
              {EIGENWELT_PLANS.filter(
                (item) => item.id !== "sync" && options.plans.includes(item.id),
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
