import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, relative, resolve } from "node:path";
import { z } from "zod";
import type { PluginCreateOptions, PluginCreateRequest } from "@legalwork/types/plugin-import";
import { ApiError } from "./errors.js";
import { connectorCommandFields } from "./native-mcp-config.js";
import { listSkillsInDir } from "./skills.js";
import { globalOpencodeConfigDir, globalSkillsDir } from "./workspace-files.js";
import { GLOBAL_MCP_ID, readRuntimeOpencodeConfig } from "./runtime-opencode-config-store.js";
import { planCreatedPlugin, readPluginFolder, type PackageFile } from "./plugin-imports.js";
import type { ServerConfig } from "./types.js";
import { readInstalledCloudPlugins, resolveWorkspaceInstallPath } from "./cloud-plugins.js";

const names = z.array(z.string().min(1).max(256)).max(50);
const headerName = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).refine(name => !["host", "content-length"].includes(name.toLowerCase()));
const headerValue = z.string().max(16384).refine(value => !/[\r\n\0]/.test(value));
const newConnectorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("remote"), url: z.string().trim().max(4096).url().refine(value => { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }),
    headers: z.record(headerName, headerValue).optional(),
    oauth: z.union([z.literal(false), z.object({ clientId: z.string().max(4096).optional(), clientSecret: z.string().max(16384).optional(), scope: z.string().max(4096).optional() }).strict()]),
  }).strict(),
  z.object({ type: z.literal("local"), command: z.array(z.string().max(16384).refine(value => !value.includes("\0"))).min(1).max(100).refine(parts => Boolean(parts[0]?.trim())),
    environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(16384).refine(value => !value.includes("\0"))).optional(),
  }).strict(),
]);
const createSchema = z.object({ name: z.string().trim().min(1).max(80), description: z.string().trim().max(1024).optional(), skills: names, connectors: names, newConnector: newConnectorSchema.optional() });

export function parsePluginCreateRequest(value: unknown): PluginCreateRequest {
  const parsed = createSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_plugin", "Enter a plugin name and choose items from your library.");
  if (parsed.data.skills.length + parsed.data.connectors.length === 0 && !parsed.data.newConnector) throw new ApiError(400, "empty_plugin", "Choose at least one skill or connector.");
  if (new Set(parsed.data.skills).size !== parsed.data.skills.length || new Set(parsed.data.connectors).size !== parsed.data.connectors.length) throw new ApiError(400, "invalid_plugin", "Choose each item only once.");
  return parsed.data;
}

function pluginSlug(name: string) {
  const slug = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || `plugin-${createHash("sha256").update(name.normalize("NFKC").toLowerCase()).digest("hex").slice(0, 12)}`;
}

export function createdPluginId(name: string) { return `local:${pluginSlug(name)}:global`; }

function rebasePaths(value: unknown, source: string, destination: string): unknown {
  if (typeof value === "string") return value.split(source).join(destination);
  if (Array.isArray(value)) return value.map(item => rebasePaths(item, source, destination));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebasePaths(item, source, destination)]));
  return value;
}

async function library(config: ServerConfig) {
  // Use only LegalWork's personal library, never an unrelated Claude directory
  // or project skill that would unexpectedly become available to every project.
  const skills = await listSkillsInDir(globalSkillsDir(), "global");
  const all = (await readRuntimeOpencodeConfig(config, GLOBAL_MCP_ID)).mcp?.servers ?? {};
  const connectors = Object.fromEntries(Object.entries(all).filter(([, item]) => item && typeof item === "object" && !Array.isArray(item) && (item.type === "local" || item.type === "remote")));
  return { skills, connectors };
}

export async function pluginCreateOptions(config: ServerConfig): Promise<PluginCreateOptions> {
  const items = await library(config);
  return { skills: items.skills.map(({ name, path, description }) => ({ name, path, description })).sort((a, b) => a.name.localeCompare(b.name)), connectors: Object.keys(items.connectors).sort().map(name => ({ name })) };
}

/** Copy complete skill folders and connection definitions into an owned bundle. */
export async function planPluginCreation(config: ServerConfig, workspaceRoot: string, input: PluginCreateRequest) {
  const items = await library(config);
  const files = new Map<string, PackageFile>();
  let bytes = 0;
  const addFile = (file: PackageFile) => {
    bytes += file.bytes.length;
    files.set(file.path, file);
    if (files.size > 5000 || bytes > 64 * 1024 * 1024) throw new ApiError(400, "plugin_too_large", "Choose fewer items. Plugins can contain up to 64 MB or 5,000 files.");
  };
  const installed = await readInstalledCloudPlugins(config, GLOBAL_MCP_ID);
  const copiedBundles = new Set<string>();
  const copyOwnerSource = async (path: string) => {
    const owner = Object.values(installed.plugins).find(plugin => plugin.files.some(file => file.objectType === "mcp" ? file.path === path : resolveWorkspaceInstallPath(workspaceRoot, file.path, true) === path));
    const bundle = owner?.files.find(file => file.objectType === "bundle");
    if (!bundle || !bundle.path.startsWith(".opencode/imported-plugins/")) return null;
    const source = resolveWorkspaceInstallPath(workspaceRoot, bundle.path, true);
    const destination = `resources/${basename(source)}`;
    if (!copiedBundles.has(source)) {
      if (await realpath(source) !== resolve(await realpath(globalOpencodeConfigDir()), relative(globalOpencodeConfigDir(), source))) throw new ApiError(400, "plugin_source_link", "The source plugin uses a linked folder. Copy its files first.");
      for (const file of (await readPluginFolder(source)).values()) addFile({ ...file, path: `${destination}/${file.path}` });
      copiedBundles.add(source);
    }
    return { source, destination: `\${PLUGIN_ROOT}/${destination}` };
  };
  for (const name of input.skills) {
    const matches = items.skills.filter(skill => skill.name === name);
    const skill = matches.length === 1 ? matches[0] : undefined;
    if (!skill) throw new ApiError(409, "plugin_item_missing", `Skill ${name} is no longer available. Choose items again.`);
    const directory = resolve(dirname(skill.path));
    if (await realpath(directory) !== resolve(await realpath(globalSkillsDir()), relative(globalSkillsDir(), directory))) throw new ApiError(400, "plugin_skill_link", `Skill ${name} uses a linked folder. Copy its files into your skills library first.`);
    const owner = await copyOwnerSource(resolve(skill.path));
    for (const file of (await readPluginFolder(directory)).values()) addFile({ ...file, bytes: owner && file.path === "SKILL.md" ? Buffer.from(new TextDecoder().decode(file.bytes).split(owner.source).join(owner.destination)) : file.bytes, path: `skills/${name}/${file.path}` });
  }
  const connectorEntries: Array<[string, unknown]> = [];
  for (const name of input.connectors) {
    const connector = Object.hasOwn(items.connectors, name) ? items.connectors[name] : undefined;
    if (!connector) throw new ApiError(409, "plugin_item_missing", `Connector ${name} is no longer available. Choose items again.`);
    const owner = await copyOwnerSource(`opencode.jsonc#mcp.${name}`);
    // Rebase command/argument paths into the new bundle without touching OAuth
    // sessions, which are stored separately and never read by the creator.
    connectorEntries.push([name, owner ? rebasePaths({ ...connector, disabled: true }, owner.source, owner.destination) : { ...connector, disabled: true }]);
  }
  if (input.newConnector) {
    const name = pluginSlug(input.name);
    if (connectorEntries.some(([existing]) => existing === name)) throw new ApiError(400, "duplicate_connector", "The new connector has the same name as a selected connector.");
    connectorEntries.push([name, connectorCommandFields({ ...input.newConnector, enabled: true })]);
  }
  const manifest = { name: pluginSlug(input.name), description: input.description || undefined, version: "1.0.0", interface: { displayName: input.name } };
  for (const [path, value] of Object.entries({ "plugin.json": manifest, "mcp.json": { mcpServers: Object.fromEntries(connectorEntries) } })) addFile({ path, bytes: Buffer.from(JSON.stringify(value, null, 2)), mode: 0o600 });
  return planCreatedPlugin(files, workspaceRoot, createdPluginId(input.name));
}
