/** @jsxImportSource react */
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { useSyncExternalStore, type ReactNode } from "react";
import { getInitialThemeMode, setThemeMode, subscribeToTheme, type ThemeMode } from "@/app/theme";
import { t } from "@/i18n";
import {
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemFootnote,
  LayoutSectionItemHeader,
  LayoutSectionItemTitle,
} from "../settings-layout";

interface ThemeSectionProps {
  busy?: boolean;
}

export function ThemeSection(props: ThemeSectionProps) {
  const themeMode = useSyncExternalStore(subscribeToTheme, getInitialThemeMode, getInitialThemeMode);
  return (
    <LayoutSectionItem className="items-center">
      <LayoutSectionItemHeader className="w-full">
        <LayoutSectionItemTitle>{t("settings.theme_title")}</LayoutSectionItemTitle>
        <LayoutSectionItemDescription>{t("settings.appearance_hint")}</LayoutSectionItemDescription>
      </LayoutSectionItemHeader>

      <ThemePicker
        className="pt-1"
        busy={props.busy ?? false}
        themeMode={themeMode}
        setThemeMode={setThemeMode}
      />

      <LayoutSectionItemFootnote>{t("settings.theme_system_hint")}</LayoutSectionItemFootnote>
    </LayoutSectionItem>
  );
}

interface ThemePickerProps {
  className?: string;
  busy: boolean;
  themeMode: ThemeMode;
  setThemeMode: (value: ThemeMode) => void;
}

function ThemePicker(props: ThemePickerProps) {
  return (
    <ToggleGroup
      value={[props.themeMode]}
      onValueChange={(value) => {
        const mode = value[0];
        if (mode === "light" || mode === "dark" || mode === "system") {
          props.setThemeMode(mode);
        }
      }}
      disabled={props.busy}
      className={cn("w-full gap-6 max-w-xl", props.className)}
    >
      <ThemePickerItem
        value="system"
        label={t("settings.theme_system")}
      >
        <ThemePreview value="system" />
        <ThemePickerLabel>{t("settings.theme_system")}</ThemePickerLabel>
      </ThemePickerItem>
      <ThemePickerItem
        value="light"
        label={t("settings.theme_light")}
      >
        <ThemePreview value="light" className="bg-white" />
        <ThemePickerLabel>{t("settings.theme_light")}</ThemePickerLabel>
      </ThemePickerItem>
      <ThemePickerItem
        value="dark"
        label={t("settings.theme_dark")}
      >
        <ThemePreview value="dark" className="bg-zinc-950" />
        <ThemePickerLabel>{t("settings.theme_dark")}</ThemePickerLabel>
      </ThemePickerItem>
    </ToggleGroup>
  );
}

interface ThemePickerItemProps {
  value: ThemeMode;
  label: string;
  children: ReactNode;
}

function ThemePickerItem(props: ThemePickerItemProps) {
  return (
    <ToggleGroupItem
      value={props.value}
      aria-label={props.label}
      className="group/theme h-auto flex-1 flex-col gap-3 rounded-sm p-0 hover:bg-transparent aria-pressed:bg-transparent"
    >
      {props.children}
    </ToggleGroupItem>
  );
}

interface ThemePreviewProps {
  value: ThemeMode;
  className?: string;
}

function ThemePreview(props: ThemePreviewProps) {
  return (
    <div
      className={cn(
        "aspect-4/3 w-full overflow-hidden rounded-md border transition-shadow group-data-pressed/theme:ring-2 group-data-pressed/theme:ring-primary group-data-pressed/theme:ring-offset-2 group-data-pressed/theme:ring-offset-background group-hover/theme:ring-1 group-hover/theme:ring-primary/40 group-hover/theme:ring-offset-2 group-hover/theme:ring-offset-background",
        props.className,
      )}
    >
      {props.value === "system" && (
        <div className="flex h-full">
          <div className="w-1/2 bg-white" />
          <div className="w-1/2 bg-zinc-950" />
        </div>
      )}
    </div>
  );
}

interface ThemePickerLabelProps {
  children: string;
}

function ThemePickerLabel(props: ThemePickerLabelProps) {
  return (
    <span className="text-sm text-muted-foreground group-data-pressed/theme:text-foreground">
      {props.children}
    </span>
  );
}
