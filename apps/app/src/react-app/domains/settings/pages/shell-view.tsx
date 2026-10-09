/** @jsxImportSource react */
import { Switch } from "@/components/ui/switch";

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
