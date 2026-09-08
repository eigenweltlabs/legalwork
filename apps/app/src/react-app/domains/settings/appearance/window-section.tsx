/** @jsxImportSource react */
import { Switch } from "@/components/ui/switch";
import { t } from "@/i18n";
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
} from "../settings-layout";

// The window/frame controls are hidden today, so nothing renders this yet;
// the section keeps its own props so it stays compilable and reusable.
interface WindowSectionProps {
  busy: boolean;
  hideTitlebar: boolean;
  toggleHideTitlebar: () => void;
}

export function WindowSection(props: WindowSectionProps) {
  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <LayoutSectionTitle>{t("settings.window_title")}</LayoutSectionTitle>
        <LayoutSectionDescription>{t("settings.window_appearance_desc")}</LayoutSectionDescription>
      </LayoutSectionHeader>

      <LayoutSectionItem>
        <LayoutSectionItemHeader>
          <LayoutSectionItemTitle>{t("settings.hide_titlebar")}</LayoutSectionItemTitle>
          <LayoutSectionItemDescription>{t("settings.hide_titlebar_desc")}</LayoutSectionItemDescription>
          <LayoutSectionItemHeaderActions>
            <Switch
              checked={props.hideTitlebar}
              disabled={props.busy}
              onCheckedChange={props.toggleHideTitlebar}
            />
          </LayoutSectionItemHeaderActions>
        </LayoutSectionItemHeader>
      </LayoutSectionItem>
    </LayoutSection>
  );
}
