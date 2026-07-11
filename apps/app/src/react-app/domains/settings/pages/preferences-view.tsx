/** @jsxImportSource react */
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { t } from "@/i18n";
import type { HideAppMode } from "@/react-app/kernel/local-provider";

import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";

export type PreferencesViewProps = {
  busy: boolean;
  showThinking: boolean;
  onToggleShowThinking: () => void;
  autoCompactContext: boolean;
  autoCompactContextBusy: boolean;
  onToggleAutoCompactContext: () => void;
  analyticsEnabled: boolean;
  onToggleAnalytics: () => void;
  hideAppMode: HideAppMode;
  onChangeHideAppMode: (mode: HideAppMode) => void;
};

export function PreferencesView(props: PreferencesViewProps) {
  return (
    <LayoutStack>
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.privacy_title")}</LayoutSectionTitle>
          <LayoutSectionDescription>{t("settings.privacy_section_desc")}</LayoutSectionDescription>
        </LayoutSectionHeader>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.hide_app_title")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.hide_app_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Select
                value={props.hideAppMode}
                onValueChange={(value) => props.onChangeHideAppMode(value as HideAppMode)}
                disabled={props.busy}
              >
                <SelectTrigger size="sm" className="w-[200px]" aria-label={t("settings.hide_app_title")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="never">{t("settings.hide_app_never")}</SelectItem>
                  <SelectItem value="recording">{t("settings.hide_app_recording")}</SelectItem>
                  <SelectItem value="always">{t("settings.hide_app_always")}</SelectItem>
                </SelectContent>
              </Select>
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>

        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.analytics_toggle")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.analytics_toggle_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch
                aria-label={t("settings.analytics_toggle")}
                checked={props.analyticsEnabled}
                disabled={props.busy}
                onCheckedChange={props.onToggleAnalytics}
              />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      </LayoutSection>
    </LayoutStack>
  );
}
