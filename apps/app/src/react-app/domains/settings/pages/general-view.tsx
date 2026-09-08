/** @jsxImportSource react */
import {
  ArrowRight,
  FileStack,
  FolderLock,
  KeyRound,
  Layout,
  Mic,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  UserCircle,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { t } from "../../../../i18n";
import { isDesktopRuntime } from "../../../../app/utils";
import type { SettingsTab } from "../../../../app/types";
import { IconTile, Surface } from "@/react-app/design-system/surface";

export type GeneralSettingsViewProps = {
  onNavigateTab: (tab: SettingsTab) => void;
  developerMode: boolean;
};

type SettingsItem = { tab: SettingsTab; icon: LucideIcon; title: string; desc: string };

const workspaceItems = (): SettingsItem[] => [
  { tab: "permissions", icon: FolderLock, title: t("settings.tab_permissions"), desc: `${t("settings.tab_description_permissions")}.` },
];

const globalItems = (): SettingsItem[] => [
  // Account leads, mirroring getGlobalSettingsTabs.
  {
    tab: "account",
    icon: UserCircle,
    title: t("settings.tab_account"),
    desc: t("settings.tab_description_account"),
  },
  { tab: "ai", icon: Zap, title: t("settings.tab_ai"), desc: `${t("settings.tab_description_ai")}.` },
  {
    tab: "personalisation",
    icon: Sparkles,
    title: t("settings.tab_personalisation"),
    desc: `${t("settings.tab_description_personalisation")}.`,
  },
  { tab: "safety", icon: ShieldCheck, title: t("settings.tab_safety"), desc: `${t("settings.tab_description_safety")}.` },
  { tab: "shell", icon: Layout, title: t("settings.tab_shell"), desc: `${t("settings.tab_description_shell")}.` },
  { tab: "environment", icon: KeyRound, title: t("settings.tab_environment"), desc: `${t("settings.tab_description_environment")}` },
  { tab: "preferences", icon: ShieldCheck, title: t("settings.tab_preferences"), desc: `${t("settings.tab_description_preferences")}.` },
  { tab: "updates", icon: RefreshCcw, title: t("settings.tab_updates"), desc: `${t("settings.tab_description_updates_short")}.` },
];

// Recorder and Office add-ins depend on local desktop capabilities, mirroring
// their placement in getGlobalSettingsTabs.
function resolveGlobalItems(): SettingsItem[] {
  const items = globalItems();
  if (!isDesktopRuntime()) return items;
  const recorderItem: SettingsItem = {
    tab: "recorder",
    icon: Mic,
    title: t("recorder.settings_tab_label"),
    desc: `${t("recorder.settings_tab_description")}.`,
  };
  const officeAddinsItem: SettingsItem = {
    tab: "office-addins",
    icon: FileStack,
    title: t("office_addins.tab_label"),
    // Trailing period to match the other overview rows; the shared i18n value
    // omits it because the settings-page tab header uses no trailing period.
    desc: `${t("office_addins.tab_description")}.`,
  };
  // After Account and AI Providers, mirroring getGlobalSettingsTabs.
  return [...items.slice(0, 2), recorderItem, officeAddinsItem, ...items.slice(2)];
}

function SettingsRow(props: { icon: LucideIcon; title: string; desc: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="group flex w-full items-center gap-3.5 px-5 py-3.5 text-left transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
    >
      <IconTile size="sm" variant="inset">
        <props.icon size={17} />
      </IconTile>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground">{props.title}</div>
        <div className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{props.desc}</div>
      </div>
      <ArrowRight
        size={16}
        className="shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground group-focus-visible:translate-x-0.5 group-focus-visible:text-foreground motion-reduce:transform-none motion-reduce:transition-none"
      />
    </button>
  );
}

function SettingsGroup(props: { label: string; items: SettingsItem[]; onNavigateTab: (tab: SettingsTab) => void }) {
  return (
    <section className="space-y-2.5">
      <div className="lw-section-eyebrow px-1">{props.label}</div>
      <Surface className="divide-y divide-border/70 overflow-hidden">
        {props.items.map((item) => (
          <SettingsRow
            key={item.tab}
            icon={item.icon}
            title={item.title}
            desc={item.desc}
            onClick={() => props.onNavigateTab(item.tab)}
          />
        ))}
      </Surface>
    </section>
  );
}

export function GeneralSettingsView(props: GeneralSettingsViewProps) {
  return (
    <div className="w-full max-w-3xl space-y-9">
      <SettingsGroup label={t("settings.group_workspace")} items={workspaceItems()} onNavigateTab={props.onNavigateTab} />
      <SettingsGroup label={t("settings.group_global")} items={resolveGlobalItems()} onNavigateTab={props.onNavigateTab} />
      <p className="px-1 text-[11px] text-muted-foreground/70">
        {t("settings.tab_description_general")}
      </p>
    </div>
  );
}
