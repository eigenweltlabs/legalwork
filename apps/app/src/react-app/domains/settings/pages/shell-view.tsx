/** @jsxImportSource react */
import { Switch } from "@/components/ui/switch";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

import {
  LayoutSection,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
  LayoutStack,
} from "../settings-layout";
import { ProjectDefaultsSection } from "./project-defaults-section";
import { LanguageSection } from "../appearance/language-section";
import { ThemeSection } from "../appearance/theme-section";
import { useShellConfig } from "../../../shell/shell-config";
import { useLocal } from "@/react-app/kernel/local-provider";
import { t } from "@/i18n";

/* ------------------------------------------------------------------ */
/*  Main view                                                          */
/* ------------------------------------------------------------------ */

export function ShellCustomizationView() {
  const { config, update } = useShellConfig();
  const local = useLocal();

  return (
    <LayoutStack>
      <ThemeSection />
      {/* ---- Language ---- carries its own section header and card. */}
      <LanguageSection />
      <ProjectDefaultsSection />

      <NewWindowPreference />

      <LayoutSection>
        <LayoutSectionItem className="gap-3">
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.customization.task_suggestions")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>
              {t("settings.customization.task_suggestions_desc")}
            </LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch
                aria-label={t("settings.customization.task_suggestions")}
                checked={config.starterCards}
                onCheckedChange={(value) => update({ starterCards: value })}
              />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      </LayoutSection>

      {/* ---- Model ---- */}
      <LayoutSection>
        <LayoutSectionHeader>
          <LayoutSectionTitle>{t("settings.model_title")}</LayoutSectionTitle>
        </LayoutSectionHeader>

        {/* Show model reasoning */}
        <LayoutSectionItem>
          <LayoutSectionItemHeader>
            <LayoutSectionItemTitle>{t("settings.show_model_reasoning")}</LayoutSectionItemTitle>
            <LayoutSectionItemDescription>{t("settings.show_model_reasoning_desc")}</LayoutSectionItemDescription>
            <LayoutSectionItemHeaderActions>
              <Switch
                aria-label={t("settings.show_model_reasoning")}
                checked={local.prefs.showThinking}
                onCheckedChange={(value) =>
                  local.setPrefs((previous) => ({ ...previous, showThinking: value, showThinkingChosen: true }))
                }
              />
            </LayoutSectionItemHeaderActions>
          </LayoutSectionItemHeader>
        </LayoutSectionItem>
      </LayoutSection>
    </LayoutStack>
  );
}

export function NewWindowPreference() {
  const { config, update } = useShellConfig();
  return (
      <LayoutSection><LayoutSectionItem><LayoutSectionItemHeader>
        <LayoutSectionItemTitle>{t("workspace.open_window")}</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>{t("workspace.window_preference_hint")}</LayoutSectionItemDescription>
        <LayoutSectionItemHeaderActions>
          <Select value={config.newWindowBehavior} onValueChange={value => { if (value === "ask" || value === "empty" || value === "copy") update({ newWindowBehavior: value }); }}>
            <SelectTrigger aria-label={t("workspace.open_window")}><SelectValue>{t(config.newWindowBehavior === "ask" ? "workspace.window_ask" : config.newWindowBehavior === "empty" ? "workspace.window_empty" : "workspace.window_copy")}</SelectValue></SelectTrigger>
            <SelectContent><SelectItem value="ask">{t("workspace.window_ask")}</SelectItem><SelectItem value="empty">{t("workspace.window_empty")}</SelectItem><SelectItem value="copy">{t("workspace.window_copy")}</SelectItem></SelectContent>
          </Select>
        </LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader></LayoutSectionItem></LayoutSection>
  );
}
