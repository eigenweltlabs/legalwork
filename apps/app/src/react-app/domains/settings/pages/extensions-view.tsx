/** @jsxImportSource react */
import { useMemo, useState, type ReactNode } from "react";
import { Blocks, Cpu, Download, Package, Plug, type LucideIcon } from "lucide-react";

import { t } from "../../../../i18n";
import { Button } from "@/components/ui/button";

import { ClaudePluginImportModal } from "../../connections/modals/claude-plugin-import-modal";
import type { LegalworkClaudePluginPreview } from "../../../../app/lib/legalwork-server";
import { PluginsView, type PluginsExtensionsStore } from "./plugins-view";
import { BUNDLED_PLUGINS } from "../bundled-plugins";
import { HubTabs } from "../segmented-tabs";

export type ExtensionsSection = "all" | "mcp" | "skills" | "plugins";

type ExtensionsTab = "connectors" | "skills" | "plugins";

type SuggestedPlugin = {
  name: string;
  packageName: string;
  description: string;
  tags: string[];
  aliases?: string[];
  installMode?: "simple" | "guided";
  steps?: Array<{
    title: string;
    description: string;
    command?: string;
    url?: string;
    path?: string;
    note?: string;
  }>;
};

export type ExtensionsViewProps = {
  busy: boolean;
  selectedWorkspaceRoot: string;
  isRemoteWorkspace: boolean;
  canEditPlugins: boolean;
  canUseGlobalScope: boolean;
  accessHint?: string | null;
  suggestedPlugins: SuggestedPlugin[];
  extensions: PluginsExtensionsStore;
  mcpConnectedAppsCount: number;
  /** Connectors tab — the MCP quick-connect grid + configured servers + built-ins. */
  mcpView: ReactNode;
  /** Skills tab — bundled + installed skills, with add/import. */
  skillsView: ReactNode;
  /** Preview a Claude Code plugin bundle from a GitHub URL. */
  previewClaudePlugin?: (url: string) => Promise<LegalworkClaudePluginPreview>;
  /** Install a Claude Code plugin bundle from a GitHub URL. */
  installClaudePlugin?: (url: string) => Promise<{ ok: boolean; message: string }>;
  onRefresh: () => void;
  initialSection?: ExtensionsSection;
  setSectionRoute?: (tab: "mcp" | "skills" | "plugins") => void;
  showHeader?: boolean;
};

// The Integrations page covers connectors (MCP), skills, and plugins.
const TABS: Array<{ id: ExtensionsTab; label: string; icon: LucideIcon; subtitle: string }> = [
  { id: "connectors", label: "Connectors", icon: Plug, subtitle: "Connect your favorite tools so LegalWork can use them on your behalf." },
  { id: "skills", label: "Skills", icon: Blocks, subtitle: "Reusable abilities this worker can call on. Add from a repo or create your own." },
  { id: "plugins", label: "Plugins", icon: Package, subtitle: "Bundled capabilities that pair a skill, an agent, and a command, ready to use in chat." },
];

const pageTitleClass = "text-[34px] font-medium leading-[1.04] tracking-[-0.035em] text-dls-text";

// Neutral segmented control matching the reference: a soft gray track with a
// white active pill (no accent fill). Shared by the tab switcher.

export function ExtensionsView(props: ExtensionsViewProps) {
  const initialTab: ExtensionsTab =
    props.initialSection === "plugins"
      ? "plugins"
      : props.initialSection === "skills"
        ? "skills"
        : "connectors";
  const [tab, setTab] = useState<ExtensionsTab>(initialTab);
  const [importOpen, setImportOpen] = useState(false);
  const pluginCount = useMemo(() => props.extensions.pluginList().length, [props.extensions]);

  const selectTab = (next: ExtensionsTab) => {
    setTab(next);
    props.setSectionRoute?.(next === "connectors" ? "mcp" : next);
  };

  const activeTab = TABS.find((entry) => entry.id === tab) ?? TABS[0];

  return (
    <section className="space-y-7 max-w-5xl w-full animate-in fade-in duration-300">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <HubTabs items={TABS} value={tab} onChange={selectTab} />
        <div className="flex items-center gap-2">
          {props.mcpConnectedAppsCount > 0 ? (
            <div className="hidden items-center gap-2 rounded-full bg-green-3 px-3 py-1 sm:inline-flex">
              <div className="size-2 rounded-full bg-green-9" />
              <span className="text-xs font-medium text-green-11">
                {t("extensions.app_count", { count: props.mcpConnectedAppsCount })}
              </span>
            </div>
          ) : null}
          <Button variant="outline" onClick={props.onRefresh}>
            {t("common.refresh")}
          </Button>
        </div>
      </div>

      {props.showHeader !== false ? (
        <div className="space-y-3">
          <span className="lw-section-eyebrow uppercase text-dls-secondary">Integrations</span>
          <h2 className={pageTitleClass}>{activeTab.label}</h2>
          <p className="max-w-xl text-[14px] leading-[1.65] text-dls-secondary">{activeTab.subtitle}</p>
        </div>
      ) : null}

      {tab === "connectors" ? props.mcpView : null}

      {tab === "skills" ? props.skillsView : null}

      {tab === "plugins" ? (
        <div className="space-y-6">
          <div className={`flex flex-wrap items-start gap-3 ${props.showHeader !== false ? "justify-end" : "justify-between"}`}>
            {props.showHeader === false ? (
              <p className="max-w-prose text-sm text-dls-secondary">
                Plugins bundle a skill, an agent, and a command into one capability. These ship with the app and are ready to use in chat.
              </p>
            ) : null}
            {props.previewClaudePlugin && props.installClaudePlugin ? (
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <Download size={14} />
                Import from GitHub
              </Button>
            ) : null}
          </div>

          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,20rem),1fr))] gap-3">
            {BUNDLED_PLUGINS.map((plugin) => (
              <div
                key={plugin.id}
                className="group rounded-[18px] border border-dls-border bg-dls-surface p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-[rgba(var(--dls-accent-rgb),0.25)] hover:shadow-[0_14px_34px_-18px_rgba(8,23,79,0.28)]"
              >
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold text-dls-text">{plugin.name}</h4>
                  <span className="shrink-0 rounded-full bg-teal-3 px-2 py-0.5 text-[10px] font-medium text-teal-11">
                    Bundled
                  </span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-dls-secondary">{plugin.description}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {plugin.components.map((component) => (
                    <span
                      key={component}
                      className="rounded-full border border-dls-border bg-dls-hover px-2 py-0.5 text-[11px] text-dls-secondary"
                    >
                      {component}
                    </span>
                  ))}
                </div>
                <div className="mt-3 inline-flex items-center rounded-lg bg-dls-hover px-2 py-1 font-mono text-[11px] text-dls-text">
                  {plugin.command}
                </div>
              </div>
            ))}
          </div>

          {/* OpenCode plugins -- advanced */}
          <details className="group" open={pluginCount > 0}>
            <summary className="flex cursor-pointer items-center gap-2 rounded-lg px-1 py-2 text-sm font-medium text-dls-secondary transition-colors hover:text-dls-text">
              <Cpu size={14} />
              <span>OpenCode Plugins</span>
              <span className="text-[11px] text-dls-secondary">({pluginCount})</span>
            </summary>
            <div className="mt-3">
              <PluginsView
                extensions={props.extensions}
                busy={props.busy}
                selectedWorkspaceRoot={props.selectedWorkspaceRoot}
                canEditPlugins={props.canEditPlugins}
                canUseGlobalScope={props.canUseGlobalScope}
                accessHint={props.accessHint}
                suggestedPlugins={props.suggestedPlugins}
              />
            </div>
          </details>
        </div>
      ) : null}

      {props.previewClaudePlugin && props.installClaudePlugin ? (
        <ClaudePluginImportModal
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onPreview={props.previewClaudePlugin}
          onInstall={props.installClaudePlugin}
          onInstalled={props.onRefresh}
        />
      ) : null}
    </section>
  );
}
