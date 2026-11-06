import type { PluginCreateConnector, PluginImportCandidate, PluginImportPreview } from "@legalwork/types/plugin-import";
import { t } from "@/i18n";
import type { ImportedPlugin } from "@/app/lib/extension-imports";

/** Creation adds one new connector; copied connectors keep their existing sign-in flow. */
export function createdPluginSignInConnector(plugin: ImportedPlugin, connector: PluginCreateConnector | undefined): string | undefined {
  if (connector?.type !== "remote" || connector.oauth === false) return;
  const prefix = "opencode.jsonc#mcp.";
  return plugin.files.find(file => file.objectType === "mcp" && file.path.startsWith(prefix))?.path.slice(prefix.length);
}

/** A whole plugin remains a plugin even when its only component is a connector. */
export function pluginImportDestination(preview: PluginImportPreview): { tab: "connectors" | "skills" | "plugins"; connectorName: string | null } {
  if (preview.format === "connectors") {
    const connector = preview.components.length === 1 && preview.components[0]?.type === "mcp" ? preview.components[0] : null;
    return { tab: "connectors", connectorName: connector?.installedName ?? null };
  }
  if (preview.format === "skills" && preview.components.every(component => component.type === "skill")) return { tab: "skills", connectorName: null };
  return { tab: "plugins", connectorName: null };
}

export function pluginImportName(plugin: { name: string; displayName?: string }): string {
  if (plugin.displayName) return plugin.displayName;
  if (/^app-[a-f0-9]{16,}$/i.test(plugin.name)) return t("extensions.import_unnamed");
  return plugin.name.replace(/[-_]+/g, " ").trim().replace(/\b\w/g, letter => letter.toUpperCase());
}

/** Imported skills keep their unique execution name; cards show the component name. */
export function pluginImportSkillName(skill: { name: string; path: string }): string {
  const owner = skill.path.replace(/\\/g, "/").match(/\/(?:skills|agents|commands)\/[^/]+-([a-f0-9]{8})-plugin\/[^/]+(?:\/SKILL\.md)?\/?$/i);
  if (!owner) return skill.name;
  const prefix = skill.name.match(new RegExp(`^[a-z0-9-]+-${owner[1]}-(.+)$`));
  return prefix ? pluginImportName({ name: prefix[1] }) : skill.name;
}

export function pluginImportConnectorName(name: string): string {
  const imported = name.match(/^.+-[a-f0-9]{8}-plugin-(?:global|[a-f0-9]{8})-(.+)-[a-f0-9]{6}$/i);
  return imported ? pluginImportName({ name: imported[1] }) : name;
}

/** Match installed components by their recorded destination, never a name prefix. */
export function importedConnectorPlugin(name: string, plugins: readonly ImportedPlugin[] = []) {
  return plugins.find(plugin => plugin.sourceKind !== "skill" && plugin.sourceKind !== "connector" && plugin.files.some(file => file.objectType === "mcp" && file.path === `opencode.jsonc#mcp.${name}`));
}

export function importedSkillPlugin(skill: { path: string }, plugins: readonly ImportedPlugin[] = []) {
  const path = skill.path.replace(/\\/g, "/").replace(/\/SKILL\.md\/?$/i, "").replace(/\/$/, "");
  return plugins.find(plugin => plugin.sourceKind !== "skill" && plugin.sourceKind !== "connector" && plugin.files.some(file => {
    if (file.objectType !== "skill") return false;
    const destination = file.path.replace(/\\/g, "/").replace(/^\.opencode\//, "/").replace(/\/SKILL\.md$/i, "");
    return destination.startsWith("/skills/") && path.endsWith(destination);
  }));
}

/** Keep connector copies together within their plugin, retaining each source choice. */
export function groupPluginImportCandidates(candidates: PluginImportCandidate[]) {
  const groups = new Map<string, PluginImportCandidate[]>();
  for (const candidate of candidates) {
    // Connectors sharing a name can point at different services or belong to different projects.
    const key = candidate.bundledIn ? JSON.stringify(["bundled-connector", candidate.bundledIn.name, candidate.connector?.name]) : candidate.connector ? pluginImportCandidateKey(candidate) : `${candidate.kind ?? "plugin"}:${candidate.name}`;
    const copies = groups.get(key) ?? [];
    copies.push(candidate);
    groups.set(key, copies);
  }
  return [...groups.values()].flatMap(sources => {
    sources.sort((a, b) => Number(b.state === "installed" || b.state === "synced") - Number(a.state === "installed" || a.state === "synced") || (b.version ?? "").localeCompare(a.version ?? "", undefined, { numeric: true }) || a.path.localeCompare(b.path));
    return sources[0] ? [{ candidate: sources[0], sources }] : [];
  }).sort((a, b) => pluginImportName(a.candidate).localeCompare(pluginImportName(b.candidate)));
}

export function pluginImportCandidateKey(candidate: PluginImportCandidate): string {
  return JSON.stringify([candidate.path, candidate.marketplace, candidate.connector?.name, candidate.connector?.project, candidate.connector?.pluginRoot]);
}
