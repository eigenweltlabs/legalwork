/** @jsxImportSource react */
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Building2,
  Check,
  CheckCircle2,
  CreditCard,
  ExternalLink,
  Loader2,
  LogOut,
  RefreshCw,
  Sparkles,
  Users,
} from "lucide-react";
import { Badge, Button, Card, Divider, Row } from "@legalwork/ui/react";

import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { openDesktopUrl } from "@/app/lib/desktop";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { ProviderIcon } from "@/react-app/design-system/provider-icon";
import {
  eigenweltBillingUrl,
  eigenweltEntitlementsQueryKey,
  hasEigenweltFeature,
  useEigenweltEntitlements,
} from "@/react-app/domains/connections/eigenwelt-entitlements";

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

  // ---- Connected: account summary ----------------------------------------
  const planLabel = entitlements?.plan ? entitlements.plan.toUpperCase() : null;

  return (
    <section className="w-full max-w-3xl space-y-6">
      <Card padding="lg" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
              <ProviderIcon providerId="eigenwelt" size={22} />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-md font-semibold text-ink">{t("account.connected_title")}</span>
                <Badge tone="success" size="sm">
                  <Check className="size-3" /> {t("status.connected")}
                </Badge>
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-subtext">
                {planLabel ? <Badge tone="accent">{planLabel}</Badge> : <Badge tone="neutral">{t("firm_hub.free_plan")}</Badge>}
                {entitlements ? <span>{t("firm_hub.seats", { seats: entitlements.seats })}</span> : null}
                <span>·</span>
                <span>{t("account.models_count", { count: String(modelCount) })}</span>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {refreshButton}
            <Button variant="secondary" size="sm" disabled={disconnecting} onClick={() => void disconnect()}>
              {disconnecting ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />}
              {t("account.sign_out")}
            </Button>
          </div>
        </div>

        {account ? (
          <>
            <Divider />
            <div className="flex min-w-0 items-center gap-3 rounded-lg bg-sunken px-3 py-2.5">
              <Building2 className="size-4 shrink-0 text-subtext" />
              <div className="min-w-0">
                <div className="text-xs font-medium uppercase tracking-wide text-subtext">
                  {t("account.organization")}
                </div>
                <div className="truncate text-sm font-medium text-ink">{account.orgName}</div>
              </div>
            </div>
          </>
        ) : null}

        {entitlements ? (
          <>
            <Divider />
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-subtext">
              <span>{t("firm_hub.usage_label")}</span>
              <span>
                {t("firm_hub.usage_today", {
                  percent: String(entitlements.usage.dailyUsedPercent),
                })}
              </span>
            </div>
          </>
        ) : null}
      </Card>

      {!hasModels ? (
        <Card padding="lg" className="space-y-3">
          <div className="flex items-start gap-2">
            <Sparkles className="mt-0.5 size-4 shrink-0 text-brand" />
            <p className="text-sm text-subtext">{t("account.no_models")}</p>
          </div>
          {refreshButton}
        </Card>
      ) : null}

      {/* Firm administration */}
      <Card>
        <Row
          leading={<Users className="size-4" />}
          title={t("firm_hub.org_title")}
          description={t("firm_hub.org_body")}
          trailing={
            <div className="flex items-center gap-2">
              {orgManagement ? (
                <Button variant="secondary" size="sm" onClick={() => void openDesktopUrl(membersUrl)}>
                  {t("firm_hub.members")} <ExternalLink className="size-3.5" />
                </Button>
              ) : null}
              <Button variant="secondary" size="sm" onClick={() => void openDesktopUrl(billingUrl)}>
                <CreditCard className="size-4" /> {t("firm_hub.billing")} <ExternalLink className="size-3.5" />
              </Button>
            </div>
          }
        />
      </Card>

      {/* Upgrade hint when connected on a plan without the firm-hub features */}
      {!hasEigenweltFeature(entitlements, "admin_hub") ? (
        <Card variant="elevated" padding="lg" className="space-y-3">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-brand">
            <Building2 className="size-3.5" /> {t("firm_hub.locked_eyebrow")}
          </div>
          <p className="text-sm text-subtext">{t("firm_hub.locked_body")}</p>
          <div>
            <Button variant="primary" size="sm" onClick={() => void openDesktopUrl(billingUrl)}>
              <CreditCard className="size-4" /> {t("firm_hub.upgrade")}
            </Button>
          </div>
        </Card>
      ) : null}
    </section>
  );
}
