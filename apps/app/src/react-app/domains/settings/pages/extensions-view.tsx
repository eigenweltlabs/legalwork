import type { ReactElement } from "react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import type { PluginImportStore } from "./plugin-import-dialog";
import type { PluginsExtensionsStore } from "./plugins-view";
import type { SkillsExtensionsStore } from "./skills-view";
import type { SkillCard } from "@/app/types";
import type { SkillDetailsStore } from "./skill-details-dialog";
import type { PluginDetailsAccess } from "./plugin-details-dialog";
import type { McpViewProps } from "./mcp-view";
import { ConnectorBrowser } from "./connector-browser";

export type ExtensionsSection = "all" | "mcp" | "skills" | "plugins" | "storage";

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
  /** Engine extension management is available only in developer mode. */
  developerMode: boolean;
  selectedWorkspaceRoot: string;
  workspaceKey?: string;
  /** Re-read the library when the server starts or reconnects. */
  libraryConnection?: { baseUrl: string } | null;
  isRemoteWorkspace: boolean;
  canEditPlugins: boolean;
  canUseGlobalScope: boolean;
  accessHint?: string | null;
  suggestedPlugins: SuggestedPlugin[];
  extensions: PluginsExtensionsStore;
  pluginImports?: PluginImportStore;
  skillTools?: Pick<SkillsExtensionsStore, "importedPackages" | "removeImportedPackage" | "revealSkillsFolder">;
  skillDetails?: SkillDetailsStore & { skills: () => SkillCard[]; readPackageComponent: PluginDetailsAccess["readComponent"] };
  renderPluginConnector?: PluginDetailsAccess["renderConnector"];
  canAddSkill?: boolean;
  mcpView: ReactElement<McpViewProps>;
  client: LegalworkServerClient | null;
  storageWorkspaceId: string | null;
  onRefresh: () => void;
  initialSection?: ExtensionsSection;
};

export function ExtensionsView(props: ExtensionsViewProps) {
  return <ConnectorBrowser key={props.workspaceKey} {...props} />;
}
