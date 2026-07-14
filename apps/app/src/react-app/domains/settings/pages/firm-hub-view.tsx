/** @jsxImportSource react */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Blocks,
  CreditCard,
  Download,
  ExternalLink,
  Loader2,
  Lock,
  Plug,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { Alert, Badge, Button, Card, Divider, Input, Row, Spinner } from "@legalwork/ui/react";

import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { openDesktopUrl } from "@/app/lib/desktop";
import type { EigenweltHubItem, LegalworkServerClient } from "@/app/lib/legalwork-server";
import {
  eigenweltBillingUrl,
  hasEigenweltFeature,
  useEigenweltEntitlements,
} from "@/react-app/domains/connections/eigenwelt-entitlements";

export type FirmHubViewProps = {
  legalworkClient: LegalworkServerClient | null;
  workspaceId: string | null;
  /** Called after a hub item is installed / a preset applied so the host can reload the engine. */
  onConfigApplied?: () => void;
};

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Keeps only the safe, shareable slice of a workspace's opencode config. */
function buildPresetFragment(opencode: Record<string, unknown>): Record<string, unknown> {
  const fragment: Record<string, unknown> = {};
  for (const key of ["provider", "model", "small_model"] as const) {
    if (opencode[key] !== undefined) fragment[key] = opencode[key];
  }
  return fragment;
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

  const [busyId, setBusyId] = useState<string | null>(null);
  const [presetName, setPresetName] = useState("");
  const [sharingPreset, setSharingPreset] = useState(false);

  const workflows = (hubQuery.data ?? []).filter((item) => item.kind === "workflow");
  const integrations = (hubQuery.data ?? []).filter((item) => item.kind === "integration");
  const presets = presetQuery.data ?? [];

  const runInstall = async (item: EigenweltHubItem) => {
    if (!legalworkClient || !workspaceId) return;
    setBusyId(item.id);
    try {
      const result = await legalworkClient.hubInstall(workspaceId, item.id);
      toast.success(t("firm_hub.installed", { name: result.name }));
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
      await Promise.all([hubQuery.refetch(), presetQuery.refetch()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("firm_hub.delete_failed"));
    } finally {
      setBusyId(null);
    }
  };

  const applyPreset = async (item: EigenweltHubItem) => {
    if (!legalworkClient || !workspaceId) return;
    setBusyId(item.id);
    try {
      const detail = await legalworkClient.hubGet(workspaceId, item.id);
      if (!detail.payload || typeof detail.payload !== "object") {
        throw new Error(t("firm_hub.preset_invalid"));
      }
      await legalworkClient.patchConfig(workspaceId, { opencode: detail.payload as Record<string, unknown> });
      toast.success(t("firm_hub.preset_applied", { name: item.name }));
      onConfigApplied?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("firm_hub.preset_apply_failed"));
    } finally {
      setBusyId(null);
    }
  };

  const shareCurrentAsPreset = async () => {
    if (!legalworkClient || !workspaceId) return;
    const name = presetName.trim();
    if (!name) return;
    setSharingPreset(true);
    try {
      const config = await legalworkClient.getConfig(workspaceId);
      const fragment = buildPresetFragment(config.opencode ?? {});
      if (Object.keys(fragment).length === 0) {
        throw new Error(t("firm_hub.share_preset_empty"));
      }
      await legalworkClient.hubSharePreset(workspaceId, { name, payload: fragment });
      toast.success(t("firm_hub.shared", { name }));
      setPresetName("");
      await presetQuery.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("firm_hub.share_failed"));
    } finally {
      setSharingPreset(false);
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
              {planLabel ? <Badge tone="accent">{planLabel}</Badge> : <Badge tone="neutral">{t("firm_hub.free_plan")}</Badge>}
              <span className="text-base text-subtext">
                {t("firm_hub.seats", { seats: entitlements.seats })}
              </span>
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
        <Alert
          tone="warning"
          icon={<Lock className="size-4" />}
          title={t("firm_hub.locked_title")}
          action={
            <Button variant="primary" size="sm" onClick={() => void openDesktopUrl(billingUrl)}>
              <CreditCard className="size-4" /> {t("firm_hub.upgrade")}
            </Button>
          }
        >
          {t("firm_hub.locked_body")}
        </Alert>
      ) : (
        <>
          {/* Workflows */}
          <HubSection
            icon={<Blocks className="size-4" />}
            title={t("firm_hub.workflows")}
            loading={hubQuery.isLoading}
            empty={workflows.length === 0}
            emptyLabel={t("firm_hub.empty_workflows")}
          >
            {workflows.map((item) => (
              <HubItemRow
                key={item.id}
                item={item}
                busy={busyId === item.id}
                actionIcon={<Download className="size-4" />}
                actionLabel={t("firm_hub.install")}
                onAction={() => void runInstall(item)}
                onDelete={() => void runDelete(item)}
              />
            ))}
          </HubSection>

          {/* Integrations */}
          <HubSection
            icon={<Plug className="size-4" />}
            title={t("firm_hub.integrations")}
            loading={hubQuery.isLoading}
            empty={integrations.length === 0}
            emptyLabel={t("firm_hub.empty_integrations")}
          >
            {integrations.map((item) => (
              <HubItemRow
                key={item.id}
                item={item}
                busy={busyId === item.id}
                actionIcon={<Download className="size-4" />}
                actionLabel={t("firm_hub.install")}
                onAction={() => void runInstall(item)}
                onDelete={() => void runDelete(item)}
              />
            ))}
          </HubSection>
        </>
      )}

      {/* Settings presets */}
      {settingsPresets ? (
        <HubSection
          icon={<Upload className="size-4" />}
          title={t("firm_hub.presets")}
          loading={presetQuery.isLoading}
          empty={presets.length === 0}
          emptyLabel={t("firm_hub.empty_presets")}
          footer={
            <div className="flex items-center gap-2 px-4 py-3">
              <Input
                value={presetName}
                onChange={(event) => setPresetName(event.currentTarget.value)}
                placeholder={t("firm_hub.share_preset_name_placeholder")}
                className="flex-1"
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={sharingPreset || !presetName.trim()}
                onClick={() => void shareCurrentAsPreset()}
              >
                {sharingPreset ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                {t("firm_hub.share")}
              </Button>
            </div>
          }
        >
          {presets.map((item) => (
            <HubItemRow
              key={item.id}
              item={item}
              busy={busyId === item.id}
              actionIcon={<Download className="size-4" />}
              actionLabel={t("firm_hub.apply")}
              onAction={() => void applyPreset(item)}
              onDelete={() => void runDelete(item)}
            />
          ))}
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
                <Button variant="secondary" size="sm" onClick={() => void openDesktopUrl(`${(platformURL ?? "https://platform.eigenweltlabs.com").replace(/\/+$/, "")}/members`)}>
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

function HubSection(props: {
  icon: React.ReactNode;
  title: string;
  loading: boolean;
  empty: boolean;
  emptyLabel: string;
  footer?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-subtext">
        {props.icon}
        <h3 className="text-md font-semibold text-ink">{props.title}</h3>
      </div>
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
  actionIcon: React.ReactNode;
  actionLabel: string;
  onAction: () => void;
  onDelete: () => void;
}) {
  return (
    <Row
      title={props.item.name}
      description={props.item.description || undefined}
      trailing={
        <div className="flex items-center gap-1.5">
          <Button variant="secondary" size="sm" disabled={props.busy} onClick={props.onAction}>
            {props.busy ? <Loader2 className="size-4 animate-spin" /> : props.actionIcon}
            {props.actionLabel}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={props.busy}
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
