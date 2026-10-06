/** @jsxImportSource react */
import { Radio } from "@base-ui/react/radio";
import { ArrowUp, Eclipse, Moon, Sun } from "lucide-react";
import { useId, useSyncExternalStore } from "react";
import { RadioGroup } from "@/components/ui/radio-group";
import { Switch } from "@/components/ui/switch";
import { getInitialThemeMode, getResolvedAppearance, setThemeMode, subscribeToTheme, type AppearanceMode } from "@/app/theme";
import { t } from "@/i18n";
import {
  LayoutSection,
  LayoutSectionDescription,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionTitle,
} from "../settings-layout";
import "./theme-section.css";

export function ThemeSection({ busy = false }: { busy?: boolean }) {
  const themeMode = useSyncExternalStore(subscribeToTheme, getInitialThemeMode, getInitialThemeMode);
  const appearance = useSyncExternalStore(subscribeToTheme, getResolvedAppearance, getResolvedAppearance);
  const titleId = useId();
  const descriptionId = useId();
  const systemId = useId();
  const modes: Array<{ value: AppearanceMode; label: string; icon: typeof Sun }> = [
    { value: "light", label: t("settings.theme_light"), icon: Sun },
    { value: "dark", label: t("settings.theme_dark"), icon: Moon },
    { value: "blackout", label: t("settings.theme_blackout"), icon: Eclipse },
  ];
  const description = appearance === "blackout"
    ? t("settings.theme_blackout_description")
    : appearance === "dark"
      ? t("settings.theme_dark_description")
      : t("settings.theme_light_description");

  return (
    <LayoutSection>
      <LayoutSectionHeader>
        <LayoutSectionTitle><span id={titleId}>{t("settings.theme_title")}</span></LayoutSectionTitle>
        <LayoutSectionDescription>{t("settings.appearance_hint")}</LayoutSectionDescription>
      </LayoutSectionHeader>
      <LayoutSectionItem className="theme-settings">
        <RadioGroup
          className="theme-segments"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          value={appearance}
          disabled={busy}
          onValueChange={(value) => {
            if (value === "light" || value === "dark" || value === "blackout") setThemeMode(value);
          }}
        >
          {modes.map(({ value, label, icon: Icon }) => (
            <Radio.Root
              key={value}
              value={value}
              className="theme-segment"
              data-appearance-option={value}
              onClick={() => {
                // Clicking the already-selected system appearance makes it an explicit choice too.
                if (themeMode === "system" && value === appearance) setThemeMode(value);
              }}
            >
              <Icon size={16} strokeWidth={1.6} aria-hidden="true" />
              <span>{label}</span>
            </Radio.Root>
          ))}
        </RadioGroup>
        <div className="theme-preview" aria-hidden="true">
          <div className="theme-preview-bar"><span /><span /><span /></div>
          <div className="theme-preview-body">
            <div className="theme-preview-sidebar">
              <div className="theme-preview-brand" />
              <i /><i /><i />
            </div>
            <div className="theme-preview-chat">
              <div className="theme-preview-bubble"><i /><i /></div>
              <div className="theme-preview-answer"><i /><i /><i /></div>
              <div className="theme-preview-composer"><i /><ArrowUp size={14} /></div>
            </div>
            <div className="theme-preview-document"><i /><i /><i /><i /><i /></div>
          </div>
        </div>
        <p id={descriptionId} className="theme-description">{description}</p>
        <div className="theme-system-row">
          <label htmlFor={systemId}>{t("settings.theme_follow_system")}</label>
          <Switch
            id={systemId}
            size="sm"
            disabled={busy}
            checked={themeMode === "system"}
            onCheckedChange={(checked) => setThemeMode(checked ? "system" : appearance)}
          />
        </div>
        <p className="theme-system-hint">{t("settings.theme_follow_system_hint")}</p>
      </LayoutSectionItem>
    </LayoutSection>
  );
}
