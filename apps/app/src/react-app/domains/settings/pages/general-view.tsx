/** @jsxImportSource react */
import type { ReactNode } from "react";
import type { AssistantIcon } from "@legalwork/types/main-assistant";
import { ArrowRight } from "lucide-react";

import { t } from "../../../../i18n";
import type { SettingsTab } from "../../../../app/types";
import { IconTile, Surface } from "@/react-app/design-system/surface";
import { getGlobalSettingsTabs, getSettingsTabDescription, getSettingsTabLabel, getWorkspaceSettingsTabs, SettingsTabIcon } from "../shell/settings-page";

export type GeneralSettingsViewProps = {
  assistantIcon?: AssistantIcon;
  onNavigateTab: (tab: SettingsTab) => void;
  developerMode: boolean;
};

function SettingsRow(props: { icon: ReactNode; title: string; desc: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="group flex w-full items-center gap-3.5 px-5 py-3.5 text-left transition-colors first:rounded-t-2xl last:rounded-b-2xl hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
    >
      <IconTile size="sm" variant="inset">
        {props.icon}
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

function SettingsGroup(props: { label: string; tabs: SettingsTab[]; assistantIcon?: AssistantIcon; onNavigateTab: (tab: SettingsTab) => void }) {
  return (
    <section className="space-y-2.5">
      <div className="lw-section-eyebrow px-1">{props.label}</div>
      <Surface className="divide-y divide-border/70 overflow-hidden">
        {props.tabs.map(tab => (
          <SettingsRow
            key={tab}
            icon={<SettingsTabIcon tab={tab} assistantIcon={props.assistantIcon} className="size-[17px]" />}
            title={getSettingsTabLabel(tab)}
            desc={tab === "updates" ? t("settings.tab_description_updates_short") : getSettingsTabDescription(tab)}
            onClick={() => props.onNavigateTab(tab)}
          />
        ))}
      </Surface>
    </section>
  );
}

export function GeneralSettingsView(props: GeneralSettingsViewProps) {
  return (
    <div className="w-full max-w-3xl space-y-9">
      <SettingsGroup label={t("settings.group_workspace")} tabs={getWorkspaceSettingsTabs()} onNavigateTab={props.onNavigateTab} />
      <SettingsGroup label={t("settings.group_global")} tabs={getGlobalSettingsTabs(props.developerMode)} assistantIcon={props.assistantIcon} onNavigateTab={props.onNavigateTab} />
      <p className="px-1 text-[11px] text-muted-foreground/70">
        {t("settings.tab_description_general")}
      </p>
    </div>
  );
}
