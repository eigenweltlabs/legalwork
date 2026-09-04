/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Loader2,
  LogOut,
  RefreshCw,
  Sparkles,
  Users,
} from "lucide-react";
import { Button, Card } from "@legalwork/ui/react";

import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { openDesktopUrl } from "@/app/lib/desktop";
import {
  eigenweltPlanWithoutModels,
  eigenweltTrialState,
  isEigenweltEntitledStatus,
} from "@/app/lib/eigenwelt-trial";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { ProviderIcon } from "@/react-app/design-system/provider-icon";
import {
  eigenweltBillingUrl,
  eigenweltEntitlementsQueryKey,
  hasEigenweltFeature,
  useEigenweltEntitlements,
} from "@/react-app/domains/connections/eigenwelt-entitlements";

import {
  LayoutSection,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutStack,
} from "../settings-layout";

/**
 * The single source of truth for the Eigenweltlabs connection in the desktop
 * app. This is an account/identity surface — NOT a model provider. Signing in
 * here provisions the firm's models under the hood, but the connection is
 * owned, viewed and managed from this one tab (plan, usage, billing, members,
 * sign in / sign out), never from the "Connect a model provider" flow.
 */
export type EigenweltAccountViewProps = {
  legalworkClient: LegalworkServerClient | null;
  workspaceId: string | null;
  /** True when the `eigenwelt` provider is connected in this workspace. */
  connected: boolean;
  /** True when the LegalWork server is up (sign-in runs through it). */
  serverConnected: boolean;
  onStartSignIn: () => Promise<{ authorizeUrl: string; sessionId: string }>;
  onWaitSignIn: (
    sessionId: string,
    opts?: { cancelled?: () => boolean },
  ) => Promise<{ connected: boolean; cancelled?: boolean; message?: string }>;
  onDisconnect: () => Promise<void>;
  /** Re-pull the gateway model list into the provider (no re-auth). */
  onRefreshModels?: () => Promise<{ modelCount: number; changed: boolean }>;
  disconnecting: boolean;
  /** False when the connected account serves no models yet (login still valid). */
  hasModels?: boolean;
  /** Current number of models the eigenwelt provider serves. */
  modelCount?: number;
  /** Called after connect/disconnect so the host can reload the engine. */
  onConfigApplied?: () => void;
};

export function EigenweltAccountView({
  legalworkClient,
  workspaceId,
  connected,
  serverConnected,
  onStartSignIn,
  onWaitSignIn,
  onDisconnect,
  onRefreshModels,
  disconnecting,
  hasModels = true,
  modelCount = 0,
  onConfigApplied,
}: EigenweltAccountViewProps) {
  const queryClient = useQueryClient();
  const entitlementsQuery = useEigenweltEntitlements({
    client: legalworkClient,
    workspaceId,
    enabled: connected,
  });
  const account = entitlementsQuery.data?.account ?? null;
  const entitlements = entitlementsQuery.data?.entitlements ?? null;
  const platformURL = entitlementsQuery.data?.platformURL ?? null;
  const billingUrl = eigenweltBillingUrl(platformURL);
  const membersUrl = `${(platformURL ?? "https://platform.eigenweltlabs.com").replace(/\/+$/, "")}/members`;
  const learnMoreUrl = `${(platformURL ?? "https://platform.eigenweltlabs.com").replace(/\/+$/, "")}/pricing`;

  const orgManagement = hasEigenweltFeature(entitlements, "org_management");

  const [connecting, setConnecting] = useState(false);
  // Bumping this token cancels an in-flight sign-in wait (e.g. on unmount).
  const waitTokenRef = useRef(0);
  useEffect(() => () => void ++waitTokenRef.current, []);

  const signIn = async () => {
    if (!serverConnected) {
      toast.error(t("providers.not_connected"));
      return;
    }
    setConnecting(true);
    const token = ++waitTokenRef.current;
    try {
      const { authorizeUrl, sessionId } = await onStartSignIn();
      await openDesktopUrl(authorizeUrl);
      const result = await onWaitSignIn(sessionId, {
        cancelled: () => waitTokenRef.current !== token,
      });
      if (result.connected) {
        toast.success(result.message ?? `${t("status.connected")} Eigenwelt`);
        await entitlementsQuery.refetch();
        onConfigApplied?.();
      }
    } catch (error) {
      if (waitTokenRef.current === token) {
        toast.error(error instanceof Error ? error.message : t("providers.oauth_failed"));
      }
    } finally {
      if (waitTokenRef.current === token) setConnecting(false);
    }
  };

  const disconnect = async () => {
    try {
      await onDisconnect();
      toast.success(t("account.disconnected"));
      await entitlementsQuery.refetch();
      onConfigApplied?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("account.disconnect_failed"));
    }
  };

  const [refreshing, setRefreshing] = useState(false);
  const refreshAccount = async () => {
    if (!onRefreshModels || !legalworkClient || !workspaceId) return;
    setRefreshing(true);
    try {
      const [entitlementsResult, modelsResult] = await Promise.allSettled([
        legalworkClient.eigenweltEntitlements(workspaceId, { refresh: true }),
        onRefreshModels(),
      ]);

      if (entitlementsResult.status === "fulfilled") {
        queryClient.setQueryData(
          eigenweltEntitlementsQueryKey(workspaceId),
          entitlementsResult.value,
        );
      }
      if (entitlementsResult.status === "rejected") throw entitlementsResult.reason;
      if (modelsResult.status === "rejected") throw modelsResult.reason;

      const { modelCount: count, changed } = modelsResult.value;
      if (count === 0) toast(t("account.refresh_none"));
      else if (changed) toast.success(t("account.refresh_loaded", { count: String(count) }));
      else toast.success(t("account.refresh_uptodate", { count: String(count) }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("account.refresh_failed"));
    } finally {
      setRefreshing(false);
    }
  };
  const refreshButton = onRefreshModels ? (
    <Button variant="secondary" size="sm" disabled={refreshing} onClick={() => void refreshAccount()}>
      {refreshing ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
      {t("account.refresh")}
    </Button>
  ) : null;

  // ---- Disconnected: sign-in surface -------------------------------------
  if (!connected) {
    return (
      <section className="w-full max-w-3xl space-y-6">
        <Card variant="elevated" padding="lg" className="space-y-5">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
              <ProviderIcon providerId="eigenwelt" size={22} />
            </span>
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-brand">
                <Sparkles className="size-3.5" /> {t("account.eyebrow")}
              </div>
              <h3 className="text-md font-semibold text-ink">{t("account.connect_title")}</h3>
              <p className="text-sm text-subtext">{t("account.connect_body")}</p>
            </div>
          </div>

          <ul className="space-y-2">
            {[
              t("account.benefit_models"),
              t("firm_hub.locked_feature_workflows"),
              t("firm_hub.locked_feature_integrations"),
            ].map((feature) => (
              <li key={feature} className="flex items-start gap-2 text-sm text-subtext">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
                <span>{feature}</span>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" disabled={connecting || !serverConnected} onClick={() => void signIn()}>
              {connecting ? <Loader2 className="size-4 animate-spin" /> : <ProviderIcon providerId="eigenwelt" size={16} />}
              {connecting ? t("account.connecting") : t("account.sign_in")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void openDesktopUrl(learnMoreUrl)}>
              {t("firm_hub.learn_more")} <ExternalLink className="size-3.5" />
            </Button>
          </div>

          {!serverConnected ? (
            <p className="text-xs text-subtext">{t("account.server_required")}</p>
          ) : null}
        </Card>
      </section>
    );
  }

  // ---- Connected: grouped settings rows -----------------------------------
  // The platform keeps `plan` after cancellation (status gates access), so
  // only show the plan name while the subscription actually grants it.
  const planActive = Boolean(
    entitlements?.plan && isEigenweltEntitledStatus(entitlements.subscriptionStatus),
  );
  const planValue =
    planActive && entitlements?.plan
      ? entitlements.plan === "hub"
        ? t("account.plan_hub")
        : entitlements.plan.charAt(0).toUpperCase() + entitlements.plan.slice(1)
      : t("account.plan_inactive");
  // The Knowledge Hub plan has no Eigenwelt models: no usage to show, and the
  // models row explains the upgrade instead of "no models yet".
  const modelsIncluded = hasEigenweltFeature(entitlements, "premium_models");
  const planWithoutModels = eigenweltPlanWithoutModels(entitlements);
  const trial = eigenweltTrialState(entitlements);
  const trialText =
    trial.kind === "active"
      ? trial.daysLeft === 0
        ? t("account.trial_ends_today")
        : trial.daysLeft === 1
          ? t("account.trial_ends_in_one")
          : t("account.trial_ends_in", { days: String(trial.daysLeft) })
      : null;

  return (
    <LayoutStack>
      <LayoutSection>
        {/* Who is signed in. */}
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                <ProviderIcon providerId="eigenwelt" size={15} />
              </span>
              <span className="truncate">
                {account?.userName ?? account?.userEmail ?? t("account.connected_title")}
              </span>
            </LayoutSectionItemTitle>
            {account?.userName && account.userEmail ? (
              <LayoutSectionItemDescription>{account.userEmail}</LayoutSectionItemDescription>
            ) : null}
            <LayoutSectionItemHeaderActions>
              <Button variant="secondary" size="sm" disabled={disconnecting} onClick={() => void disconnect()}>
                {disconnecting ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />}
                {t("account.sign_out")}
              </Button>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>

        {/* The firm this sign-in belongs to. */}
        {account ? (
          <LayoutSectionItem>
            <LayoutSectionItemHeader>
              <LayoutSectionItemTitle>
                <span className="truncate">{account.orgName}</span>
              </LayoutSectionItemTitle>
              <LayoutSectionItemDescription>
                {t("account.organization")}
                {entitlements ? ` · ${t("firm_hub.seats", { seats: String(entitlements.seats) })}` : ""}
              </LayoutSectionItemDescription>
              {orgManagement ? (
                <LayoutSectionItemHeaderActions>
                  <Button variant="secondary" size="sm" onClick={() => void openDesktopUrl(membersUrl)}>
                    <Users className="size-4" /> {t("firm_hub.members")} <ExternalLink className="size-3.5" />
                  </Button>
                </LayoutSectionItemHeaderActions>
              ) : null}
            </LayoutSectionItemHeader>
          </LayoutSectionItem>
        ) : null}

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("account.plan_label")}</LayoutSectionItemTitle>
            {trialText ? (
              <LayoutSectionItemDescription>{trialText}</LayoutSectionItemDescription>
            ) : null}
            <LayoutSectionItemHeaderActions>
              <span className={planActive ? "text-sm text-foreground" : "text-sm text-muted-foreground"}>
                {planValue}
              </span>
              <Button variant="secondary" size="sm" onClick={() => void openDesktopUrl(billingUrl)}>
                <CreditCard className="size-4" /> {t("firm_hub.billing")} <ExternalLink className="size-3.5" />
              </Button>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>

        {entitlements && modelsIncluded ? (
          <LayoutSectionItem>
            <LayoutSectionItemHeader>
              <LayoutSectionItemTitle>{t("firm_hub.usage_label")}</LayoutSectionItemTitle>
              <LayoutSectionItemHeaderActions>
                <span className="text-sm text-muted-foreground">
                  {t("firm_hub.usage_today", {
                    percent: String(entitlements.usage.dailyUsedPercent),
                  })}
                </span>
              </LayoutSectionItemHeaderActions>
            </LayoutSectionItemHeader>
          </LayoutSectionItem>
        ) : null}

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("account.models_label")}</LayoutSectionItemTitle>
            {planWithoutModels ? (
              <LayoutSectionItemDescription>{t("account.models_not_in_plan")}</LayoutSectionItemDescription>
            ) : !hasModels ? (
              <LayoutSectionItemDescription>{t("account.no_models")}</LayoutSectionItemDescription>
            ) : null}
            <LayoutSectionItemHeaderActions>
              <span className="text-sm text-muted-foreground">
                {modelCount === 1
                  ? t("account.models_count_one", { count: String(modelCount) })
                  : t("account.models_count_other", { count: String(modelCount) })}
              </span>
              {refreshButton}
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      </LayoutSection>

      {/* Trial lapsed: the paid models are gone until they subscribe. */}
      {trial.kind === "ended" ? (
        <Card variant="elevated" padding="lg" className="space-y-3">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-warning">
            <CreditCard className="size-3.5" /> {t("account.trial_ended_eyebrow")}
          </div>
          <p className="text-sm text-subtext">{t("account.trial_ended_body")}</p>
          <div>
            <Button variant="primary" size="sm" onClick={() => void openDesktopUrl(billingUrl)}>
              <CreditCard className="size-4" /> {t("account.trial_ended_cta")}
            </Button>
          </div>
        </Card>
      ) : null}
    </LayoutStack>
  );
}
