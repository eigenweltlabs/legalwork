/** @jsxImportSource react */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Blocks,
  Check,
  Download,
  Loader2,
  Pin,
  Plug,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { Badge, Button, Card, Row, Spinner } from "@legalwork/ui/react";

import { toast } from "@/components/ui/sonner";
import { ConfirmModal } from "@/react-app/design-system/modals/confirm-modal";
import { t } from "@/i18n";
import type {
  EigenweltHubInstall,
  EigenweltHubItem,
  EigenweltHubKind,
  LegalworkServerClient,
} from "@/app/lib/legalwork-server";
import {
  hasEigenweltFeature,
  useEigenweltEntitlements,
} from "@/react-app/domains/connections/eigenwelt-entitlements";
import { usePremiumUpsell } from "@/react-app/domains/recorder/premium-upsell-context";

/**
 * Firm-hub "download" surface for a single kind. Lists the items your firm has
 * shared and lets you install / apply them into this workspace — the pull side
 * of Firm Hub sharing. Self-gating: renders nothing unless the workspace is
 * connected to an Eigenwelt firm that grants the relevant feature, so the host
 * screens (Workflows / Integrations / AI settings) can drop it in
 * unconditionally next to their existing "Share with firm" actions.
 */
export type HubDownloadSectionProps = {
  legalworkClient: LegalworkServerClient | null;
  workspaceId: string | null;
  kind: EigenweltHubKind;
  /** Called after an item is installed / a preset applied so the host can reload the engine. */
  onConfigApplied?: () => void;
};

/** Pinned items first (the platform sorts too — this is defensive + stable). */
function sortHubItems(items: EigenweltHubItem[]): EigenweltHubItem[] {
  return [...items].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
}

/** Human title from a hub slug: "nda-review" -> "Nda Review". */
function prettifyName(slug: string): string {
  const words = slug.replace(/[-_]+/g, " ").trim();
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Who shared it: name -> email -> a short id fallback. */
function sharedBy(item: EigenweltHubItem): string {
  return item.createdByName || item.createdByEmail || `${item.createdByUserId.slice(0, 10)}…`;
}

function kindMeta(kind: EigenweltHubKind): {
  feature: "admin_hub" | "settings_presets";
  icon: React.ReactNode;
  title: string;
  description: string;
  empty: string;
} {
  switch (kind) {
    case "mcp":
    case "plugin":
    case "integration":
      return {
        feature: "admin_hub",
        icon: <Plug className="size-4" />,
        title: t("firm_hub.integrations"),
        description: t("firm_hub.integrations_desc"),
        empty: t("firm_hub.empty_integrations"),
      };
    case "preset":
      return {
        feature: "settings_presets",
        icon: <Upload className="size-4" />,
        title: t("firm_hub.presets"),
        description: t("firm_hub.presets_desc"),
        empty: t("firm_hub.empty_presets"),
      };
    default:
      return {
        feature: "admin_hub",
        icon: <Blocks className="size-4" />,
        title: t("firm_hub.workflows"),
        description: t("firm_hub.workflows_desc"),
        empty: t("firm_hub.empty_workflows"),
      };
  }
}

export function HubDownloadSection({
  legalworkClient,
  workspaceId,
  kind,
  onConfigApplied,
}: HubDownloadSectionProps) {
  const meta = kindMeta(kind);
  const upsell = usePremiumUpsell();
  const entitlementsQuery = useEigenweltEntitlements({ client: legalworkClient, workspaceId });
  const entitled = hasEigenweltFeature(entitlementsQuery.data?.entitlements, meta.feature);
  // Connected = we have a workspace to install into. Entitled = the firm has an
  // active Plus subscription. When connected but NOT entitled we show an upsell
  // that opens the Plus modal, rather than an empty list.
  const connected = Boolean(legalworkClient && workspaceId);
  const active = connected && entitled;

  const listQuery = useQuery({
    queryKey: ["eigenwelt-hub", kind, workspaceId],
    enabled: active,
    queryFn: async () => (await legalworkClient!.hubList(workspaceId!, kind)).items,
  });
  const installsQuery = useQuery({
    queryKey: ["eigenwelt-hub-installs", workspaceId],
    enabled: active,
    queryFn: async () => (await legalworkClient!.hubInstalls(workspaceId!)).installs,
  });
  const installs = installsQuery.data ?? {};
  const rawItems = listQuery.data ?? [];
  // "Filter by team member" — distinct sharers present in the shared list.
  const [memberFilter, setMemberFilter] = useState<string | null>(null);
  const members = useMemo(() => {
    const map = new Map<string, string>();
    for (const it of rawItems) map.set(it.createdByUserId, sharedBy(it));
    return [...map.entries()].map(([id, label]) => ({ id, label }));
  }, [rawItems]);
  const items = sortHubItems(
    memberFilter ? rawItems.filter((it) => it.createdByUserId === memberFilter) : rawItems,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingInstall, setPendingInstall] = useState<{
    item: EigenweltHubItem;
    wasInstalled: boolean;
  } | null>(null);

  const installStateFor = (
    item: EigenweltHubItem,
  ): { record?: EigenweltHubInstall; updateAvailable: boolean } => {
    const record = installs[item.id];
    return { record, updateAvailable: Boolean(record && record.version < item.version) };
  };

  const runInstall = async (item: EigenweltHubItem, wasInstalled: boolean) => {
    if (!legalworkClient || !workspaceId) return;
    setBusyId(item.id);
    try {
      const result = await legalworkClient.hubInstall(workspaceId, item.id, { allowOverwrite: true });
      toast.success(t(wasInstalled ? "firm_hub.updated" : "firm_hub.installed", { name: result.name }));
      await installsQuery.refetch();
      onConfigApplied?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("firm_hub.install_failed"));
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

  const runDelete = async (item: EigenweltHubItem) => {
    if (!legalworkClient || !workspaceId) return;
    setBusyId(item.id);
    try {
      await legalworkClient.hubDelete(workspaceId, item.id);
      toast.success(t("firm_hub.unshared", { name: item.name }));
      await Promise.all([listQuery.refetch(), installsQuery.refetch()]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("firm_hub.delete_failed"));
    } finally {
      setBusyId(null);
    }
  };

  // No workspace to install into — nothing to render.
  if (!connected) return null;

  // Connected but not on Plus: show the upsell, which opens the Plus modal.
  if (!entitled) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-ink">
          {meta.icon}
          <h3 className="text-md font-semibold">{meta.title}</h3>
        </div>
        <p className="text-sm text-subtext">{meta.description}</p>
        <button
          type="button"
          onClick={() => upsell.open()}
          className="flex w-full flex-col items-start gap-1 rounded-2xl border border-dashed border-subtle bg-sunken/40 px-4 py-5 text-left transition-colors hover:border-brand/50 hover:bg-hover"
        >
          <span className="text-sm font-medium text-ink">{t("firm_hub.upsell_title")}</span>
          <span className="text-xs text-subtext">{t("firm_hub.upsell_body")}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-ink">
        {meta.icon}
        <h3 className="text-md font-semibold">{meta.title}</h3>
      </div>
      <p className="text-sm text-subtext">{meta.description}</p>
      {members.length > 1 ? (
        <div className="flex items-center gap-2">
          <span className="text-xs text-subtext">{t("firm_hub.filter_by_member")}</span>
          <select
            value={memberFilter ?? ""}
            onChange={(event) => setMemberFilter(event.currentTarget.value || null)}
            className="rounded-lg border border-subtle bg-transparent px-2 py-1 text-sm text-ink focus:border-brand focus:outline-none"
          >
            <option value="">{t("firm_hub.all_members")}</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <Card padding="none">
        {listQuery.isLoading ? (
          <div className="flex items-center gap-2 px-4 py-6 text-subtext">
            <Spinner size="sm" /> {t("firm_hub.loading")}
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-6 text-base text-subtext">{meta.empty}</div>
        ) : (
          <div className="divide-y divide-subtle">
            {items.map((item) => {
              const { record, updateAvailable } = installStateFor(item);
              const isPreset = kind === "preset";
              return (
                <HubItemRow
                  key={item.id}
                  item={item}
                  busy={busyId === item.id}
                  installed={Boolean(record)}
                  updateAvailable={updateAvailable}
                  installedLabel={isPreset ? t("firm_hub.applied_badge") : t("firm_hub.installed_badge")}
                  actionIcon={<Download className="size-4" />}
                  actionLabel={item.kind === "plugin" && !item.pinned ? "Admin approval required" : isPreset ? t("firm_hub.apply") : t("firm_hub.install")}
                  actionDisabled={item.kind === "plugin" && !item.pinned}
                  reactionLabel={isPreset ? t("firm_hub.reapply") : t("firm_hub.reinstall")}
                  onAction={() => {
                    if (isPreset) void applyPreset(item, Boolean(record));
                    else setPendingInstall({ item, wasInstalled: Boolean(record) });
                  }}
                  onDelete={() => void runDelete(item)}
                />
              );
            })}
          </div>
        )}
      </Card>
      <ConfirmModal
        open={pendingInstall !== null}
        title={pendingInstall?.wasInstalled ? "Review and update shared item" : "Review and install shared item"}
        message={pendingInstall ? (
          <span>
            <strong>{prettifyName(pendingInstall.item.name)}</strong> was shared by {sharedBy(pendingInstall.item)}. Skills can change agent behavior and plugins execute code. Installing may replace a local item with the same name.
            {pendingInstall.item.hasSecret && pendingInstall.item.canAccessSecret ? " This MCP also includes a copyable shared credential." : ""}
          </span>
        ) : ""}
        confirmLabel={pendingInstall?.wasInstalled ? "Trust and update" : "Trust and install"}
        cancelLabel={t("common.cancel")}
        variant="warning"
        onCancel={() => setPendingInstall(null)}
        onConfirm={() => {
          const pending = pendingInstall;
          setPendingInstall(null);
          if (pending) void runInstall(pending.item, pending.wasInstalled);
        }}
      />
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
  actionDisabled?: boolean;
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
      <Button variant="primary" size="sm" disabled={busy || props.actionDisabled} onClick={props.onAction}>
        {busy ? spinner : <RefreshCw className="size-4" />} {t("firm_hub.update")}
      </Button>
    );
  } else if (installed) {
    mainButton = (
      <Button variant="ghost" size="sm" disabled={busy || props.actionDisabled} onClick={props.onAction}>
        {busy ? spinner : <RefreshCw className="size-4" />} {props.reactionLabel}
      </Button>
    );
  } else {
    mainButton = (
      <Button variant="secondary" size="sm" disabled={busy || props.actionDisabled} onClick={props.onAction}>
        {busy ? spinner : props.actionIcon} {props.actionLabel}
      </Button>
    );
  }

  return (
    <Row
      title={
        <span className="flex items-center gap-2">
          {prettifyName(item.name)}
          {item.pinned ? (
            <Badge tone="accent" size="sm">
              <Pin className="size-3" /> {t("firm_hub.pinned")}
            </Badge>
          ) : null}
          <span className="text-2xs font-normal text-subtext">by {sharedBy(item)}</span>
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
