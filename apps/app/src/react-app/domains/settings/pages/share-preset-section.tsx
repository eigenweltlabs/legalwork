/** @jsxImportSource react */
import { useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { Button, Card, Input } from "@legalwork/ui/react";

import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import {
  hasEigenweltFeature,
  useEigenweltEntitlements,
} from "@/react-app/domains/connections/eigenwelt-entitlements";

/**
 * Keep only the safe, shareable slice of a workspace's opencode config: the
 * provider shape (keys are stripped again on the server) plus the model /
 * small_model defaults. Shared by the Firm Hub tab and the AI settings page.
 */
export function buildPresetFragment(opencode: Record<string, unknown>): Record<string, unknown> {
  const fragment: Record<string, unknown> = {};
  for (const key of ["provider", "model", "small_model"] as const) {
    if (opencode[key] !== undefined) fragment[key] = opencode[key];
  }
  return fragment;
}

export type SharePresetControlProps = {
  client: LegalworkServerClient;
  workspaceId: string;
  onShared?: () => void;
};

/** Inline "name + Share" control that publishes the current settings as a preset. */
export function SharePresetControl({ client, workspaceId, onShared }: SharePresetControlProps) {
  const [name, setName] = useState("");
  const [sharing, setSharing] = useState(false);

  const share = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSharing(true);
    try {
      const config = await client.getConfig(workspaceId);
      const fragment = buildPresetFragment(config.opencode ?? {});
      if (Object.keys(fragment).length === 0) {
        throw new Error(t("firm_hub.share_preset_empty"));
      }
      // The server re-sanitizes (strips provider secrets) before publishing.
      await client.hubSharePreset(workspaceId, { name: trimmed, payload: fragment });
      toast.success(t("firm_hub.shared", { name: trimmed }));
      setName("");
      onShared?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("firm_hub.share_failed"));
    } finally {
      setSharing(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Input
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        placeholder={t("firm_hub.share_preset_name_placeholder")}
        className="flex-1"
      />
      <Button
        variant="secondary"
        size="sm"
        disabled={sharing || !name.trim()}
        onClick={() => void share()}
      >
        {sharing ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
        {t("firm_hub.share")}
      </Button>
    </div>
  );
}

export type SharePresetSectionProps = {
  client: LegalworkServerClient | null;
  workspaceId: string | null;
};

/**
 * Self-gating "Share current settings as preset" card for the AI settings page.
 * Renders nothing unless the firm's plan grants `settings_presets`, so the host
 * can drop it in unconditionally.
 */
export function SharePresetSection({ client, workspaceId }: SharePresetSectionProps) {
  const entitlementsQuery = useEigenweltEntitlements({ client, workspaceId });
  const canShare = hasEigenweltFeature(entitlementsQuery.data?.entitlements, "settings_presets");

  if (!client || !workspaceId || !canShare) return null;

  return (
    <Card padding="lg" className="space-y-3">
      <div>
        <div className="text-md font-semibold text-ink">{t("firm_hub.share_preset_title")}</div>
        <p className="mt-0.5 text-sm text-subtext">{t("firm_hub.share_preset_desc")}</p>
      </div>
      <SharePresetControl client={client} workspaceId={workspaceId} />
    </Card>
  );
}
