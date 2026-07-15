/** @jsxImportSource react */
import {
  ArrowRight,
  Building2,
  FileStack,
  FolderLock,
  KeyRound,
  Layout,
  Mic,
  RefreshCcw,
  ShieldCheck,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { t } from "../../../../i18n";
import { isDesktopRuntime } from "../../../../app/utils";
import type { SettingsTab } from "../../../../app/types";

export type GeneralSettingsViewProps = {
  onNavigateTab: (tab: SettingsTab) => void;
  developerMode: boolean;
};

type SettingsItem = { tab: SettingsTab; icon: LucideIcon; title: string; desc: string };

const workspaceItems: SettingsItem[] = [
  { tab: "permissions", icon: FolderLock, title: "Permissions", desc: "Authorized folders and file access." },
];

const globalItems: SettingsItem[] = [
  { tab: "ai", icon: Zap, title: "AI Providers", desc: "Connect services that provide AI models." },
  {
    tab: "account",
    icon: Building2,
    title: t("settings.tab_account"),
    desc: t("settings.tab_description_account"),
  },
  { tab: "safety", icon: ShieldCheck, title: "Tool Permissions", desc: "Decide what LegalWork can do on its own across all workspaces." },
  { tab: "shell", icon: Layout, title: "Customization", desc: "Branding and task suggestions." },
  { tab: "environment", icon: KeyRound, title: "Secrets", desc: "Store API keys and passwords for connected services." },
  { tab: "preferences", icon: ShieldCheck, title: "Privacy", desc: "Usage analytics and data sharing." },
  { tab: "updates", icon: RefreshCcw, title: "Updates", desc: "App version and update channel." },
];

// Recorder and Office add-ins depend on local desktop capabilities, mirroring
// their placement in getGlobalSettingsTabs.
function resolveGlobalItems(): SettingsItem[] {
  if (!isDesktopRuntime()) return globalItems;
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
  return [globalItems[0], recorderItem, officeAddinsItem, ...globalItems.slice(1)];
}

function SettingsRow(props: { icon: LucideIcon; title: string; desc: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="group flex w-full items-center gap-3.5 px-4 py-3 text-left transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-hover"
    >
      <div className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-sunken text-ink">
        <props.icon size={17} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-base font-medium text-ink">{props.title}</div>
        <div className="mt-0.5 text-sm leading-snug text-subtext">{props.desc}</div>
      </div>
      <ArrowRight
        size={16}
        className="shrink-0 text-tertiary transition-transform group-hover:translate-x-0.5 group-hover:text-ink"
      />
    </button>
  );
}

function SettingsGroup(props: { label: string; items: SettingsItem[]; onNavigateTab: (tab: SettingsTab) => void }) {
  return (
    <section className="space-y-2.5">
      <div className="lw-section-eyebrow px-1">{props.label}</div>
      <div className="divide-y divide-subtle overflow-hidden rounded-2xl border border-subtle bg-surface shadow-xs">
        {props.items.map((item) => (
          <SettingsRow
            key={item.tab}
            icon={item.icon}
            title={item.title}
            desc={item.desc}
            onClick={() => props.onNavigateTab(item.tab)}
          />
        ))}
      </div>
    </section>
  );
}

export function GeneralSettingsView(props: GeneralSettingsViewProps) {
  return (
    <div className="w-full max-w-3xl space-y-9">
      <SettingsGroup label="Workspace" items={workspaceItems} onNavigateTab={props.onNavigateTab} />
      <SettingsGroup label="Global" items={resolveGlobalItems()} onNavigateTab={props.onNavigateTab} />
      <p className="px-1 text-[11px] text-muted-foreground/70">
        {t("settings.tab_description_general")}
      </p>
    </div>
  );
}
