/** @jsxImportSource react */
import {
  ArrowRight,
  Cloud,
  Cog,
  FolderLock,
  Paintbrush,
  Puzzle,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wrench,
} from "lucide-react";

import { t } from "../../../../i18n";
import type { SettingsTab } from "../../../../app/types";

export type GeneralSettingsViewProps = {
  onNavigateTab: (tab: SettingsTab) => void;
  developerMode: boolean;
  onSendFeedback: () => void;
  onJoinDiscord: () => void;
  onReportIssue: () => void;
};

type SettingsItem = { tab: SettingsTab; icon: typeof Sparkles; title: string; desc: string };

const workspaceItems: SettingsItem[] = [
  { tab: "preferences", icon: Cog, title: "Preferences", desc: "Default model, reasoning, and compaction." },
  { tab: "permissions", icon: FolderLock, title: "Permissions", desc: "Authorized folders and file access." },
  { tab: "extensions", icon: Puzzle, title: "Extensions", desc: "MCPs, skills, plugins, and integrations." },
  { tab: "advanced", icon: Wrench, title: "Advanced", desc: "Runtime, engine, and developer options." },
];

const globalItems: SettingsItem[] = [
  { tab: "ai", icon: Sparkles, title: "AI Providers", desc: "Connect services that provide AI models." },
  { tab: "cloud-account", icon: Cloud, title: "Cloud", desc: "LegalWork Cloud account and organization." },
  { tab: "appearance", icon: Paintbrush, title: "Appearance", desc: "Theme, font size, and display." },
  { tab: "environment", icon: Terminal, title: "Environment", desc: "Environment variables and paths." },
  { tab: "updates", icon: RefreshCcw, title: "Updates", desc: "App version and update channel." },
  { tab: "recovery", icon: ShieldCheck, title: "Recovery", desc: "Reset onboarding and clear data." },
];

function SettingsRow(props: { icon: typeof Sparkles; title: string; desc: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="group flex w-full items-center gap-4 px-4 py-3.5 text-left transition-colors hover:bg-[rgba(35,82,222,0.055)]"
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-[11px] border border-[rgba(35,82,222,0.22)] bg-[rgba(35,82,222,0.09)] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)]">
        <props.icon size={16} className="text-[#2352DE]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] font-medium tracking-[-0.01em] text-foreground">{props.title}</div>
        <div className="text-[11.5px] leading-snug text-muted-foreground">{props.desc}</div>
      </div>
      <ArrowRight
        size={15}
        className="shrink-0 text-muted-foreground/45 transition-all group-hover:translate-x-0.5 group-hover:text-[#2352DE]"
      />
    </button>
  );
}

function SettingsGroup(props: { label: string; items: SettingsItem[]; onNavigateTab: (tab: SettingsTab) => void }) {
  return (
    <section className="space-y-3">
      <div className="lw-section-eyebrow px-1">{props.label}</div>
      <div className="lw-glass-panel divide-y divide-[color:var(--glass-border)] overflow-hidden rounded-[20px]">
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
    <div className="w-full max-w-2xl space-y-9">
      <SettingsGroup label="Workspace" items={workspaceItems} onNavigateTab={props.onNavigateTab} />
      <SettingsGroup label="Global" items={globalItems} onNavigateTab={props.onNavigateTab} />
      <p className="px-1 text-[11px] text-muted-foreground/70">
        {t("settings.tab_description_general")}
      </p>
    </div>
  );
}
