import { satisfies, valid, validRange } from "semver";
import type { PluginImportPreview, PluginImportRequirement } from "@legalwork/types/plugin-import";
import type { CloudImportedPlugin } from "./cloud-plugins.js";

/** OpenAI defaults a missing apps map to empty. IDs still describe hosted apps,
 * not endpoint configurations that another host can connect to. */
export function appConnectionRequirements(source: string, path: string): PluginImportRequirement[] {
  const invalid = (): PluginImportRequirement[] => [{ kind: "app", name: path, code: "invalid_apps", required: true, status: "blocked", message: `The app connections in ${path} cannot be read. Correct this file or remove its declaration if the plugin does not use app connections.` }];
  let file: unknown;
  try { file = JSON.parse(source); } catch { return invalid(); }
  if (!file || typeof file !== "object" || Array.isArray(file)) return invalid();
  if (!("apps" in file) || file.apps === null) return [];
  const apps = file.apps;
  // Empty optional scaffolds carry no connection requirements, including older
  // generators that emitted an empty list instead of an empty object.
  if (Array.isArray(apps) && apps.length === 0) return [];
  if (!apps || typeof apps !== "object" || Array.isArray(apps)) return invalid();
  return Object.keys(apps).map(name => ({ kind: "app", name, code: "registered_apps", required: true, status: "blocked", message: `${name} uses a ChatGPT app connection. Its app ID and account session cannot be transferred. Obtain a portable connector configuration before importing this plugin.` }));
}

export function pluginRequirements(manifest: Record<string, unknown>): PluginImportRequirement[] {
  const result: PluginImportRequirement[] = [];
  if (manifest.dependencies !== undefined) {
    const dependencies = Array.isArray(manifest.dependencies) ? manifest.dependencies : [manifest.dependencies];
    for (const dependency of dependencies) {
      const object = dependency && typeof dependency === "object" && !Array.isArray(dependency) ? dependency : {};
      const name = typeof dependency === "string" ? dependency : "name" in object && typeof object.name === "string" ? object.name : "Unknown dependency";
      const version = "version" in object && typeof object.version === "string" ? object.version : undefined;
      const marketplace = "marketplace" in object && typeof object.marketplace === "string" ? object.marketplace : name.includes("@") ? name.split("@")[1] : undefined;
      result.push({ kind: "dependency", name: name.split("@")[0], ...(version ? { version } : {}), ...(marketplace ? { marketplace } : {}), code: "plugin_dependency", status: "blocked", required: true, message: `This plugin requires ${name}${version ? ` (${version})` : ""}. Install a compatible copy from the same trusted source before importing.` });
    }
  }
  return result;
}

/** Identify explicit commands and APIs supplied by the source host. */
export function instructionRequirements(name: string, source: string, kind: "skill" | "agent" | "command"): PluginImportRequirement[] {
  if (kind === "command" && /\b(?:claude|codex)\s+mcp\s+(?:add|remove|import)\b/.test(source)) return [{ kind: "runtime", name, code: "source_app_setup", required: true, status: "blocked", message: "This setup workflow changes connector settings in its original app. It cannot configure LegalWork. Add a standalone connector using the provider's configuration instead." }];
  if (source.includes("@oai/artifact-tool") || /Codex workspace dependencies/i.test(source) && source.includes("load_workspace_dependencies")) return [{ kind: "runtime", name, code: "source_runtime", required: true, status: "blocked", message: "These instructions require OpenAI's artifact runtime or workspace dependency loader. Those dependencies are not included in this package or provided by LegalWork. Adapt the skill to a portable runtime before importing." }];
  if (/\bmcp__codex_(?:app|apps)__/.test(source)) return [{ kind: "runtime", name, code: "source_tool_references", required: false, status: "changed", message: "These instructions reference tools exposed by the original ChatGPT/Codex host. The named tools do not transfer with the skill; adapt those calls to LegalWork connectors before relying on this workflow." }];
  return [];
}

export function evaluateImportRequirements(preview: PluginImportPreview, installed: CloudImportedPlugin[] = []): void {
  const requirements = (preview.requirements ?? []).map((requirement): PluginImportRequirement => {
    if (requirement.kind !== "dependency") return requirement;
    const matches = installed.filter(plugin => plugin.name === requirement.name && plugin.pluginId !== preview.id && (!requirement.marketplace || plugin.marketplaceId === requirement.marketplace) && (!requirement.version || Boolean(valid(plugin.provenance?.version) && validRange(requirement.version) && satisfies(plugin.provenance?.version || "", requirement.version))));
    const match = matches.length === 1 ? matches[0] : undefined;
    const readiness = match?.importState?.readiness;
    if (!match || readiness === "unsupported" || readiness === "partial") return { ...requirement, status: "blocked" satisfies PluginImportRequirement["status"], message: `Install one unambiguous, compatible copy of ${requirement.name}${requirement.version ? ` (${requirement.version})` : ""}${requirement.marketplace ? ` from ${requirement.marketplace}` : ""} before importing. Its dependency requirements must also be met.` };
    return { ...requirement, status: readiness === "setup" ? "setup" : "satisfied" satisfies PluginImportRequirement["status"], message: readiness === "setup" ? `Finish setting up the installed dependency ${requirement.name} before using this plugin.` : `${requirement.name} is installed with a compatible version.` };
  });
  preview.requirements = requirements;
  const connectors = preview.connectors ?? [];
  preview.readiness = requirements.some(item => item.required && item.status === "blocked") || !preview.components.length ? "unsupported"
    : requirements.some(item => item.status === "changed" || item.status === "blocked") || connectors.some(item => item.status === "blocked") ? "partial"
    : requirements.some(item => item.status === "setup") || connectors.some(item => item.status !== "compatible") ? "setup" : "ready";
}
