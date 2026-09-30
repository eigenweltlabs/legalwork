/** @jsxImportSource react */
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ProviderActionsMenu } from "../provider-actions-menu";
import type { ReactNode } from "react";

import { t } from "@/i18n";
import { ProviderIcon } from "../../../design-system/provider-icon";
import { SettingsNotice, SettingsStatusBadge } from "../settings-section";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemFootnote,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";

type ConnectedProvider = {
  id: string;
  name: string;
  source?: "env" | "api" | "config" | "custom";
  /** True when this is a user-defined OpenAI-spec provider our form can edit. */
  editableAsCustom?: boolean;
};

export type AiSettingsViewProps = {
  busy: boolean;
  providerAuthBusy: boolean;
  providerStatusLabel: string;
  providerStatusStyle: string;
  providerSummary: string;
  connectedProviders: ConnectedProvider[];
  disconnectingProviderId: string | null;
  providerConnectError: string | null;
  providerDisconnectStatus: string | null;
  providerDisconnectError: string | null;
  onOpenProviderAuth: () => void | Promise<void>;
  onDisconnectProvider: (providerId: string) => void | Promise<void>;
  /** Save a local credential that takes precedence over an inherited env key. */
  onReplaceProviderKey?: (providerId: string) => void | Promise<void>;
  /** Edit a user-defined custom provider (only shown for `source === "custom"`). */
  onEditProvider?: (providerId: string) => void | Promise<void>;
  canDisconnectProvider: (source?: ConnectedProvider["source"]) => boolean;
  eigenweltConnected: boolean;
  onManageEigenweltAccount: () => void;
  /** Set of local provider IDs that were imported from cloud. */
  cloudProviderIds?: Set<string>;
  cloudProvidersView?: ReactNode;
  ocrView?: ReactNode;
  /** Fusion mode configuration section (candidate models + fusion model). */
  fusionView?: ReactNode;
  systemOneView?: ReactNode;
  /** Firm Hub: "share current settings as preset" section (shown only when entitled). */
  presetShareView?: ReactNode;
};

function providerSourceLabel(source?: ConnectedProvider["source"]) {
  if (source === "env") return t("settings.provider_source_env");
  if (source === "api") return t("providers.api_key_label");
  if (source === "config") return t("settings.provider_source_config");
  if (source === "custom") return t("settings.provider_source_custom");
  return null;
}

export function AiSettingsView(props: AiSettingsViewProps) {
  return (
    <LayoutStack>
      {/* ---- Providers ---- */}
      <LayoutSection>
        <LayoutSectionHeader>
          <div className="flex items-center justify-between gap-3">
            <LayoutSectionTitle>{t("settings.providers_title")}</LayoutSectionTitle>
            <Button
              variant="default"
              size="sm"
              onClick={() => void props.onOpenProviderAuth()}
              disabled={props.busy || props.providerAuthBusy}
            >
              {props.providerAuthBusy
                ? t("settings.loading_providers")
                : t("provider_auth.add_provider")}
            </Button>
          </div>
          <LayoutSectionDescription>{t("settings.providers_desc")}</LayoutSectionDescription>
        </LayoutSectionHeader>

        <LayoutSectionItem className="flex-row flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <ProviderIcon providerId="eigenwelt" size={20} className="text-dls-text" />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{t("account.connected_title")}</p>
              <p className="text-xs text-dls-secondary">
                {t(props.eigenweltConnected ? "config.status_connected" : "config.status_not_connected")}
              </p>
            </div>
          </div>
          <ProviderActionsMenu name={t("account.connected_title")}>
            <DropdownMenuItem onClick={props.onManageEigenweltAccount}>
              {t(props.eigenweltConnected ? "account.manage" : "account.sign_in")}
            </DropdownMenuItem>
          </ProviderActionsMenu>
        </LayoutSectionItem>

        {props.connectedProviders.map((provider) => (
          <LayoutSectionItem
            key={provider.id}
            className="flex-row flex-wrap items-center justify-between gap-3"
          >
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <ProviderIcon providerId={provider.id} size={20} className="text-dls-text" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="truncate text-sm font-medium">{provider.name}</p>
                  {props.cloudProviderIds?.has(provider.id) ? (
                    <SettingsStatusBadge label="Cloud" tone="neutral" className="min-h-6 px-2" />
                  ) : null}
                </div>
                <p className="text-xs text-dls-secondary">{providerSourceLabel(provider.source) ?? provider.id}</p>
              </div>
            </div>
            {!props.cloudProviderIds?.has(provider.id) && (
              (provider.source === "env" && props.onReplaceProviderKey) ||
              (provider.editableAsCustom && props.onEditProvider) ||
              props.canDisconnectProvider(provider.source)
            ) ? (
              <ProviderActionsMenu name={provider.name} disabled={props.busy || props.providerAuthBusy || props.disconnectingProviderId !== null}>
                {provider.source === "env" && props.onReplaceProviderKey ? (
                  <DropdownMenuItem
                    onClick={() => void props.onReplaceProviderKey?.(provider.id)}
                    disabled={
                      props.busy ||
                      props.providerAuthBusy ||
                      props.disconnectingProviderId !== null
                    }
                  >
                    {t("settings.replace_key")}
                  </DropdownMenuItem>
                ) : null}
                {provider.editableAsCustom && props.onEditProvider ? (
                  <DropdownMenuItem
                    onClick={() => void props.onEditProvider?.(provider.id)}
                    disabled={
                      props.busy ||
                      props.providerAuthBusy ||
                      props.disconnectingProviderId !== null
                    }
                  >
                    {t("settings.edit")}
                  </DropdownMenuItem>
                ) : null}
                {props.canDisconnectProvider(provider.source) ? (
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => void props.onDisconnectProvider(provider.id)}
                    disabled={
                      props.busy ||
                      props.providerAuthBusy ||
                      props.disconnectingProviderId !== null
                    }
                  >
                    {props.disconnectingProviderId === provider.id
                      ? t("settings.disconnecting")
                      : t("settings.disconnect")}
                  </DropdownMenuItem>
                ) : null}
              </ProviderActionsMenu>
            ) : null}
          </LayoutSectionItem>
        ))}

        {props.providerConnectError ? (
          <SettingsNotice tone="error">{props.providerConnectError}</SettingsNotice>
        ) : null}
        {props.providerDisconnectStatus ? (
          <SettingsNotice>{props.providerDisconnectStatus}</SettingsNotice>
        ) : null}
        {props.providerDisconnectError ? (
          <SettingsNotice tone="error">{props.providerDisconnectError}</SettingsNotice>
        ) : null}

        {props.connectedProviders.some((provider) => provider.source === "env") ? (
          <LayoutSectionItemFootnote>
            {t("settings.env_key_override_info")}
          </LayoutSectionItemFootnote>
        ) : null}
      </LayoutSection>

      {props.cloudProvidersView}

      {props.systemOneView}
      {props.ocrView}

      {props.fusionView}

      {props.presetShareView}

    </LayoutStack>
  );
}
