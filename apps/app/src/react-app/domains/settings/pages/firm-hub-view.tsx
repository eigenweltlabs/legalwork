/** @jsxImportSource react */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Blocks,
  Check,
  CheckCircle2,
  CreditCard,
  Download,
  ExternalLink,
  Loader2,
  Lock,
  Pin,
  Plug,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { Badge, Button, Card, Divider, Row, Spinner } from "@legalwork/ui/react";

import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { openDesktopUrl } from "@/app/lib/desktop";
import type {
  EigenweltHubInstall,
  EigenweltHubItem,
  LegalworkServerClient,
} from "@/app/lib/legalwork-server";
import {
  eigenweltBillingUrl,
  hasEigenweltFeature,
  useEigenweltEntitlements,
} from "@/react-app/domains/connections/eigenwelt-entitlements";
import { SharePresetControl } from "./share-preset-section";

export type FirmHubViewProps = {
  legalworkClient: LegalworkServerClient | null;
  workspaceId: string | null;
  /** Called after a hub item is installed / a preset applied so the host can reload the engine. */
  onConfigApplied?: () => void;
};

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Pinned items first (the platform sorts too — this is defensive + stable). */
function sortHubItems(items: EigenweltHubItem[]): EigenweltHubItem[] {
  return [...items].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}

export function FirmHubView({ legalworkClient, workspaceId, onConfigApplied }: FirmHubViewProps) {
  const entitlementsQuery = useEigenweltEntitlements({ client: legalworkClient, workspaceId });
  const entitlements = entitlementsQuery.data?.entitlements ?? null;
  const platformURL = entitlementsQuery.data?.platformURL ?? null;
  const billingUrl = eigenweltBillingUrl(platformURL);

  const adminHub = hasEigenweltFeature(entitlements, "admin_hub");
  const orgManagement = hasEigenweltFeature(entitlements, "org_management");
  const settingsPresets = hasEigenweltFeature(entitlements, "settings_presets");

  const hubQuery = useQuery({
    queryKey: ["eigenwelt-hub", workspaceId],
    enabled: Boolean(legalworkClient && workspaceId && adminHub),
    queryFn: async () => (await legalworkClient!.hubList(workspaceId!)).items,
  });
  const presetQuery = useQuery({
    queryKey: ["eigenwelt-hub-presets", workspaceId],
    enabled: Boolean(legalworkClient && workspaceId && settingsPresets),
    queryFn: async () => (await legalworkClient!.hubList(workspaceId!, "preset")).items,
  });
  const installsQuery = useQuery({
    queryKey: ["eigenwelt-hub-installs", workspaceId],
    enabled: Boolean(legalworkClient && workspaceId && (adminHub || settingsPresets)),
    queryFn: async () => (await legalworkClient!.hubInstalls(workspaceId!)).installs,
  });
  const installs = installsQuery.data ?? {};

  const [busyId, setBusyId] = useState<string | null>(null);

  const workflows = sortHubItems((hubQuery.data ?? []).filter((item) => item.kind === "workflow"));
  const integrations = sortHubItems((hubQuery.data ?? []).filter((item) => item.kind === "integration"));
  const presets = sortHubItems(presetQuery.data ?? []);

  const installStateFor = (item: EigenweltHubItem): { record?: EigenweltHubInstall; updateAvailable: boolean } => {
    const record = installs[item.id];
    return { record, updateAvailable: Boolean(record && record.version < item.version) };
  };

  const runInstall = async (item: EigenweltHubItem, wasInstalled: boolean) => {
    if (!legalworkClient || !workspaceId) return;
    setBusyId(item.id);
    try {
      const result = await legalworkClient.hubInstall(workspaceId, item.id);
      toast.success(t(wasInstalled ? "firm_hub.updated" : "firm_hub.installed", { name: result.name }));
      await installsQuery.refetch();
      onConfigApplied?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("firm_hub.install_failed"));
    } finally {
      setBusyId(null);
    }
  };

  const runDelete = async (item: EigenweltHubItem) => {
    if (!legalworkClient || !workspaceId) return;
    setBusyId(item.id);
    try {
      await legalworkClient.hubDelete(workspaceId, item.id);
      toast.success(t("firm_hub.unshared", { name: item.name }));
      await Promise.all([hubQuery.refetch(), presetQuery.refetch(), installsQuery.refetch()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("firm_hub.delete_failed"));
    } finally {
      setBusyId(null);
    }
  };

  const applyPreset = async (item: EigenweltHubItem, wasInstalled: boolean) => {
    if (!legalworkClient || !workspaceId) return;
    setBusyId(item.id);
    try {
      const detail = await legalworkClient.hubGet(workspaceId, item.id);
      if (!detail.payload || typeof detail.payload !== "object") {
        throw new Error(t("firm_hub.preset_invalid"));
      }
      await legalworkClient.patchConfig(workspaceId, { opencode: detail.payload as Record<string, unknown> });
      // Presets apply from settings (not the install route), so record the pulled
      // version here to power "update available" on the next visit.
      await legalworkClient.hubRecordInstall(workspaceId, {
        id: item.id,
        version: detail.version,
        kind: "preset",
        name: item.name,
      });
      toast.success(t(wasInstalled ? "firm_hub.updated" : "firm_hub.preset_applied", { name: item.name }));
      await installsQuery.refetch();
      onConfigApplied?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("firm_hub.preset_apply_failed"));
    } finally {
      setBusyId(null);
    }
  };

  if (entitlementsQuery.isLoading) {
    return (
      <div className="flex w-full max-w-3xl items-center gap-2 py-10 text-subtext">
        <Spinner size="sm" /> {t("firm_hub.loading")}
      </div>
    );
  }

  const planLabel = entitlements?.plan ? entitlements.plan.toUpperCase() : null;

  return (
    <section className="w-full max-w-3xl space-y-6">
      {/* Subscription summary */}
      {entitlements ? (
        <Card padding="lg">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              {planLabel ? (
                <Badge tone="accent">{planLabel}</Badge>
              ) : (
                <Badge tone="neutral">{t("firm_hub.free_plan")}</Badge>
              )}
              <span className="text-base text-subtext">{t("firm_hub.seats", { seats: entitlements.seats })}</span>
            </div>
            <span className="text-base text-subtext">
              {t("firm_hub.usage_today", {
                remaining: formatCents(entitlements.usage.dailyRemainingCents),
                allowance: formatCents(entitlements.usage.dailyAllowanceCents),
              })}
            </span>
          </div>
        </Card>
      ) : null}

      {/* Feature gate: Firm Hub requires the admin_hub entitlement */}
      {!adminHub ? (
        <FirmHubLocked billingUrl={billingUrl} platformURL={platformURL} />
      ) : (
        <>
          {/* Workflows */}
          <HubSection
            icon={<Blocks className="size-4" />}
            title={t("firm_hub.workflows")}
            description={t("firm_hub.workflows_desc")}
            loading={hubQuery.isLoading}
            empty={workflows.length === 0}
            emptyLabel={t("firm_hub.empty_workflows")}
          >
            {workflows.map((item) => {
              const { record, updateAvailable } = installStateFor(item);
              return (
                <HubItemRow
                  key={item.id}
                  item={item}
                  busy={busyId === item.id}
                  installed={Boolean(record)}
                  updateAvailable={updateAvailable}
                  actionIcon={<Download className="size-4" />}
                  actionLabel={t("firm_hub.install")}
                  reactionLabel={t("firm_hub.reinstall")}
                  onAction={() => void runInstall(item, Boolean(record))}
                  onDelete={() => void runDelete(item)}
                />
              );
            })}
          </HubSection>

          {/* Integrations */}
          <HubSection
            icon={<Plug className="size-4" />}
            title={t("firm_hub.integrations")}
            description={t("firm_hub.integrations_desc")}
            loading={hubQuery.isLoading}
            empty={integrations.length === 0}
            emptyLabel={t("firm_hub.empty_integrations")}
          >
            {integrations.map((item) => {
              const { record, updateAvailable } = installStateFor(item);
              return (
                <HubItemRow
                  key={item.id}
                  item={item}
                  busy={busyId === item.id}
                  installed={Boolean(record)}
                  updateAvailable={updateAvailable}
                  actionIcon={<Download className="size-4" />}
                  actionLabel={t("firm_hub.install")}
                  reactionLabel={t("firm_hub.reinstall")}
                  onAction={() => void runInstall(item, Boolean(record))}
                  onDelete={() => void runDelete(item)}
                />
              );
            })}
          </HubSection>
        </>
      )}

      {/* Settings presets */}
      {settingsPresets ? (
        <HubSection
          icon={<Upload className="size-4" />}
          title={t("firm_hub.presets")}
          description={t("firm_hub.presets_desc")}
          loading={presetQuery.isLoading}
          empty={presets.length === 0}
          emptyLabel={t("firm_hub.empty_presets")}
          footer={
            legalworkClient && workspaceId ? (
              <div className="px-4 py-3">
                <SharePresetControl
                  client={legalworkClient}
                  workspaceId={workspaceId}
                  onShared={() => void presetQuery.refetch()}
                />
              </div>
            ) : undefined
          }
        >
          {presets.map((item) => {
            const { record, updateAvailable } = installStateFor(item);
            return (
              <HubItemRow
                key={item.id}
                item={item}
                busy={busyId === item.id}
                installed={Boolean(record)}
                updateAvailable={updateAvailable}
                installedLabel={t("firm_hub.applied_badge")}
                actionIcon={<Download className="size-4" />}
                actionLabel={t("firm_hub.apply")}
                reactionLabel={t("firm_hub.reapply")}
                onAction={() => void applyPreset(item, Boolean(record))}
                onDelete={() => void runDelete(item)}
              />
            );
          })}
        </HubSection>
      ) : null}

      {/* Org management links */}
      {orgManagement ? (
        <Card>
          <Row
            leading={<Users className="size-4" />}
            title={t("firm_hub.org_title")}
            description={t("firm_hub.org_body")}
            trailing={
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    void openDesktopUrl(
                      `${(platformURL ?? "https://platform.eigenweltlabs.com").replace(/\/+$/, "")}/members`,
                    )
                  }
                >
                  {t("firm_hub.members")} <ExternalLink className="size-3.5" />
                </Button>
                <Button variant="secondary" size="sm" onClick={() => void openDesktopUrl(billingUrl)}>
                  {t("firm_hub.billing")} <ExternalLink className="size-3.5" />
                </Button>
              </div>
            }
          />
        </Card>
      ) : null}
    </section>
  );
}

/**
 * Locked / upgrade state. Deliberately a full, on-brand card (surface + ink
 * tokens that are legible in both themes) rather than a bare warning banner —
 * the old warning-soft Alert rendered light-on-cream in dark mode and the CTA
 * blended in. The primary Button carries its own foreground token, so contrast
 * is guaranteed.
 */
function FirmHubLocked({ billingUrl, platformURL }: { billingUrl: string; platformURL: string | null }) {
  const learnMoreUrl = `${(platformURL ?? "https://platform.eigenweltlabs.com").replace(/\/+$/, "")}/pricing`;
  return (
    <Card variant="elevated" padding="lg" className="space-y-5">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
          <Lock className="size-5" />
        </span>
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-brand">
            <Sparkles className="size-3.5" /> {t("firm_hub.locked_eyebrow")}
          </div>
          <h3 className="text-md font-semibold text-ink">{t("firm_hub.locked_title")}</h3>
          <p className="text-sm text-subtext">{t("firm_hub.locked_body")}</p>
        </div>
      </div>

      <ul className="space-y-2">
        {[
          t("firm_hub.locked_feature_workflows"),
          t("firm_hub.locked_feature_integrations"),
          t("firm_hub.locked_feature_presets"),
        ].map((feature) => (
          <li key={feature} className="flex items-start gap-2 text-sm text-subtext">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => void openDesktopUrl(billingUrl)}>
          <CreditCard className="size-4" /> {t("firm_hub.upgrade")}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void openDesktopUrl(learnMoreUrl)}>
          {t("firm_hub.learn_more")} <ExternalLink className="size-3.5" />
        </Button>
      </div>
    </Card>
  );
}

function HubSection(props: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  loading: boolean;
  empty: boolean;
  emptyLabel: string;
  footer?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2 text-subtext">
        <span className="flex items-center gap-2 text-ink">
          {props.icon}
          <h3 className="text-md font-semibold">{props.title}</h3>
        </span>
      </div>
      {props.description ? <p className="text-sm text-subtext">{props.description}</p> : null}
      <Card padding="none">
        {props.loading ? (
          <div className="flex items-center gap-2 px-4 py-6 text-subtext">
            <Spinner size="sm" /> {t("firm_hub.loading")}
          </div>
        ) : props.empty ? (
          <div className="px-4 py-6 text-base text-subtext">{props.emptyLabel}</div>
        ) : (
          <div className="divide-y divide-subtle">{props.children}</div>
        )}
        {props.footer ? (
          <>
            <Divider />
            {props.footer}
          </>
        ) : null}
      </Card>
    </div>
  );
}

function HubItemRow(props: {
  item: EigenweltHubItem;
  busy: boolean;
  installed: boolean;
  updateAvailable: boolean;
  /** Badge shown when installed & current (default "Installed"). */
  installedLabel?: string;
  actionIcon: React.ReactNode;
  actionLabel: string;
  /** Low-emphasis label when already installed & current (Reinstall / Re-apply). */
  reactionLabel: string;
  onAction: () => void;
  onDelete: () => void;
}) {
  const { item, busy, installed, updateAvailable } = props;
  const spinner = <Loader2 className="size-4 animate-spin" />;

  let mainButton: React.ReactNode;
  if (updateAvailable) {
    mainButton = (
      <Button variant="primary" size="sm" disabled={busy} onClick={props.onAction}>
        {busy ? spinner : <RefreshCw className="size-4" />} {t("firm_hub.update")}
      </Button>
    );
  } else if (installed) {
    mainButton = (
      <Button variant="ghost" size="sm" disabled={busy} onClick={props.onAction}>
        {busy ? spinner : <RefreshCw className="size-4" />} {props.reactionLabel}
      </Button>
    );
  } else {
    mainButton = (
      <Button variant="secondary" size="sm" disabled={busy} onClick={props.onAction}>
        {busy ? spinner : props.actionIcon} {props.actionLabel}
      </Button>
    );
  }

  return (
    <Row
      title={
        <span className="flex items-center gap-2">
          {item.name}
          {item.pinned ? (
            <Badge tone="accent" size="sm">
              <Pin className="size-3" /> {t("firm_hub.pinned")}
            </Badge>
          ) : null}
        </span>
      }
      description={item.description || undefined}
      trailing={
        <div className="flex items-center gap-1.5">
          {updateAvailable ? (
            <Badge tone="warning" size="sm">
              {t("firm_hub.update_available")}
            </Badge>
          ) : installed ? (
            <Badge tone="success" size="sm">
              <Check className="size-3" /> {props.installedLabel ?? t("firm_hub.installed_badge")}
            </Badge>
          ) : null}
          {mainButton}
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={props.onDelete}
            aria-label={t("firm_hub.unshare")}
            title={t("firm_hub.unshare")}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      }
    />
  );
}
