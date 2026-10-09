/** @jsxImportSource react */
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ProviderActionsMenu } from "../provider-actions-menu";
import { useState, type ReactNode } from "react";

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
import { useOrgPolicyForbids } from "../../connections/org-policy";
import { FirmItemNote, MemberKeyDialog, OrgPolicyNote } from "../../connections/org-policy-ui";
import { ChatGptSignInButton } from "../../connections/provider-auth/chatgpt-plan-card";

type ConnectedProvider = {
  id: string;
  name: string;
  source?: "env" | "api" | "config" | "custom";
  /** True when this is a user-defined OpenAI-spec provider our form can edit. */
  editableAsCustom?: boolean;
};

/** One of the firm's chat providers, by its engine id; `key` says whose key it uses. */
type FirmChatProvider = { id: string; name: string; key: "firm" | "member" | "oauth"; connected: boolean };

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
  onRefreshProvider?: (providerId: string) => void | Promise<void>;
  canDisconnectProvider: (source?: ConnectedProvider["source"]) => boolean;
  firmProviders: FirmChatProvider[];
  /** Sign in to one of the firm's providers with the member's own account (ChatGPT, for OpenAI). */
  onSignInFirmProvider: (providerId: string) => void | Promise<void>;
  /** Save the member's own key for one of the firm's providers. */
  onSaveFirmProviderKey: (providerId: string, key: string) => Promise<unknown>;
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
  const providersForbidden = useOrgPolicyForbids("ai.chat.allowCustom");
  const [keyFor, setKeyFor] = useState<FirmChatProvider | null>(null);
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
              disabled={props.busy || props.providerAuthBusy || providersForbidden}
            >
              {props.providerAuthBusy
                ? t("settings.loading_providers")
                : t("provider_auth.add_provider")}
            </Button>
          </div>
          <LayoutSectionDescription>{t("settings.providers_desc")}</LayoutSectionDescription>
          <OrgPolicyNote policyKey="ai.chat.allowCustom" />
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

        {props.connectedProviders.map((provider) => {
          const firm = props.firmProviders.find((each) => each.id === provider.id);
          return (
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
                {firm ? <FirmItemNote /> : <p className="text-xs text-dls-secondary">{providerSourceLabel(provider.source) ?? provider.id}</p>}
              </div>
            </div>
            {/* The firm's key is not the member's to disconnect. */}
            {!props.cloudProviderIds?.has(provider.id) && firm?.key !== "firm" && (
              (provider.source === "env" && props.onReplaceProviderKey) ||
              (provider.editableAsCustom && props.onEditProvider) || props.onRefreshProvider ||
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
                {props.onRefreshProvider ? (
                  <DropdownMenuItem
                    onClick={() => void props.onRefreshProvider?.(provider.id)}
                    disabled={props.busy || props.providerAuthBusy || props.disconnectingProviderId !== null}
                  >
                    {t("provider_auth.refresh_models")}
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
          );
        })}

        {props.firmProviders.filter((provider) => !provider.connected).map((provider) => (
          <LayoutSectionItem key={provider.id} className="flex-row flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <ProviderIcon providerId={provider.id} size={20} className="text-dls-text" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{provider.name}</p>
                <FirmItemNote />
              </div>
            </div>
            {provider.key === "oauth" ? (
              // The row's size, like the other buttons here.
              <ChatGptSignInButton className="h-8 gap-2 rounded-lg px-3 text-[13px] [&>span]:size-4" disabled={props.busy || props.providerAuthBusy} onClick={() => void props.onSignInFirmProvider(provider.id)} />
            ) : provider.key === "member" ? (
              <Button variant="outline" size="sm" disabled={props.busy || props.providerAuthBusy} onClick={() => setKeyFor(provider)}>
                {t("org_policy.add_own_key")}
              </Button>
            ) : (
              <p className="text-xs text-dls-secondary">{t("org_policy.firm_key_signed_out")}</p>
            )}
          </LayoutSectionItem>
        ))}

        {keyFor ? (
          <MemberKeyDialog
            name={keyFor.name}
            onClose={() => setKeyFor(null)}
            onSave={async (key) => {
              await props.onSaveFirmProviderKey(keyFor.id, key);
            }}
          />
        ) : null}

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
