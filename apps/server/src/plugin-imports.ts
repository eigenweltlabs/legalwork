import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, resolve, relative } from "node:path";
import { unzipSync } from "fflate";
import { z } from "zod";
import type { ConnectorImportCheck, PluginImportCandidate, PluginImportPreview, PluginImportProvider, PluginImportRequest, PluginImportProvenance } from "@legalwork/types/plugin-import";
import { ApiError } from "./errors.js";
import { buildFrontmatter, parseFrontmatter } from "./frontmatter.js";
import { pluginNamespace, resolveWorkspaceInstallPath, type CloudPluginResolved } from "./cloud-plugins.js";
import { connectorImportBundle, discoverConnectorImports, normalizeImportedConnector } from "./connector-imports.js";
import { connectorConfigVariables } from "./connector-config.js";
import { assessImportedConnector } from "./connector-import-compatibility.js";
import { validatePortableManifest, validatePortableMcp, portableEntryError } from "./plugin-import-format.js";
import { appConnectionRequirements, evaluateImportRequirements, pluginRequirements, instructionRequirements } from "./plugin-import-requirements.js";
import { githubPluginSource } from "./plugin-import-source.js";
import { sourceInstallationStates } from "./plugin-import-discovery.js";
import { localMarketplaceEntries, marketplaceManifest } from "./plugin-import-marketplaces.js";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 5000;
const connectorSchema = z.object({ name: z.string().min(1).max(256), project: z.string().min(1).max(4096).optional(), pluginRoot: z.string().max(4096).optional() });
const sourceSchema = z.object({ provider: z.enum(["chatgpt", "claude"]), path: z.string().min(1).optional(), marketplace: z.string().max(4096).optional(), zipBase64: z.string().max(90 * 1024 * 1024).optional(), filename: z.string().max(256).optional(), connector: connectorSchema.optional(), url: z.string().max(2048).optional(), ref: z.string().max(256).optional(), directory: z.string().max(4096).optional() });
const requestSchema = z.object({ source: sourceSchema, root: z.string().optional(), scope: z.enum(["global", "project"]), detectFormat: z.boolean().optional(), digest: z.string().optional(), validationId: z.string().max(100).optional(), recheck: z.boolean().optional(), acknowledgePartial: z.boolean().optional(), asWorkflow: z.boolean().optional(), workflowSkillsOnly: z.boolean().optional() });
export function parsePluginImportRequest(value: unknown): PluginImportRequest {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_plugin_import", "Choose a plugin folder or ZIP and installation scope.");
  const source = parsed.data.source;
  if ([source.path, source.zipBase64, source.url].filter(Boolean).length !== 1) throw new ApiError(400, "invalid_plugin_import", "Provide exactly one folder, archive or repository URL.");
  if (source.connector && (!source.path || source.provider === "chatgpt" && source.connector.project)) throw new ApiError(400, "invalid_plugin_import", "Choose a connector from a local configuration file.");
  if (source.directory) safePath(source.directory);
  if (source.connector?.pluginRoot !== undefined) {
    if (source.connector.project !== undefined) fail("Choose either a plugin connector or a project configuration connector.");
    if (source.connector.pluginRoot !== "") safePath(source.connector.pluginRoot);
  }
  return { ...parsed.data, source: source.path ? { provider: source.provider, path: source.path, ...(source.marketplace ? { marketplace: source.marketplace } : {}), ...(source.connector ? { connector: source.connector } : {}) } : source.url ? { provider: source.provider, url: source.url, ref: source.ref, directory: source.directory } : { provider: source.provider, zipBase64: source.zipBase64 || "", filename: source.filename } };
}
function fail(message: string): never { throw new ApiError(400, "invalid_plugin_import", message); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function str(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "") || "plugin"; }
function safePath(value: string): string {
  const name = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!name || name.startsWith("/") || /^[a-z]:/i.test(name) || name.includes("\0") || name.split("/").some(part => !part || part === ".." || part === "." || /[:<>"|?*]/.test(part) || /[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) fail(`Unsafe plugin path: ${value}`);
  return name;
}
export type PackageFile = { path: string; bytes: Uint8Array; mode: number };
type PackageFiles = Map<string, PackageFile>;
export type PluginImportPlan = { preview: PluginImportPreview; resolved: CloudPluginResolved; resourceFiles: PackageFile[]; connectorConfigs?: Record<string, Record<string, unknown>>; dataPaths?: string[] };

export async function readPluginFolder(root: string): Promise<PackageFiles> {
  const files: PackageFiles = new Map();
  let bytes = 0;
  const visit = async (directory: string, prefix: string, depth: number) => {
    if (depth > 24) fail("Plugin folder nesting exceeds 24 levels.");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      // Generated dependencies and version-control metadata are never imported.
      if ([".git", "node_modules", ".DS_Store"].includes(entry.name)) continue;
      const path = safePath(prefix ? `${prefix}/${entry.name}` : entry.name);
      const absolute = join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) fail(`Plugin contains a link: ${path}. Copy the actual file into the plugin first.`);
      if (info.isDirectory()) await visit(absolute, path, depth + 1);
      else if (info.isFile()) {
        bytes += info.size;
        if (bytes > MAX_BYTES || files.size >= MAX_FILES) fail("Plugin exceeds 64 MB or 5,000 files.");
        const content = await readFile(absolute);
        if (content.length !== info.size) fail("Plugin changed while being read. Please preview it again.");
        files.set(path, { path, bytes: content, mode: info.mode & 0o777 });
      } else fail(`Plugin contains a non-regular file: ${path}`);
    }
  };
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("Choose an ordinary plugin folder.");
  await visit(root, "", 0);
  return files;
}

function readZip(bytes: Uint8Array): PackageFiles {
  if (bytes.byteLength > MAX_BYTES) fail("ZIP exceeds 64 MB.");
  // Inspect central-directory metadata before decompression (including links).
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) if (view.getUint32(end, true) === 0x06054b50) break;
  if (end < 0 || view.getUint32(end, true) !== 0x06054b50) fail("Invalid ZIP archive.");
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) fail("Multi-volume ZIPs are unsupported.");
  const count = view.getUint16(end + 10, true);
  if (count > MAX_FILES || count === 0xffff) fail("ZIP exceeds 5,000 entries or uses ZIP64.");
  let offset = view.getUint32(end + 16, true);
  let total = 0;
  const modes = new Map<string, number>();
  const names = new Set<string>();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== 0x02014b50) fail("Invalid ZIP directory.");
    const length = view.getUint16(offset + 28, true);
    if (offset + 46 + length > end) fail("Invalid ZIP file name.");
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset + 46, offset + 46 + length));
    const path = safePath(raw);
    if (names.has(path.toLowerCase())) fail(`Duplicate ZIP path: ${path}`);
    names.add(path.toLowerCase());
    const mode = view.getUint32(offset + 38, true) >>> 16;
    if ((mode & 0o170000) === 0o120000) fail(`ZIP contains a link: ${path}`);
    if (view.getUint16(offset + 8, true) & 1) fail("Encrypted ZIPs are unsupported.");
    total += view.getUint32(offset + 24, true);
    if (total > MAX_BYTES) fail("Expanded ZIP exceeds 64 MB.");
    modes.set(raw, mode & 0o777 || 0o600);
    offset += 46 + length + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  const files: PackageFiles = new Map();
  try {
    const contents = unzipSync(bytes, { filter: entry => {
      if (!modes.has(entry.name)) fail("ZIP directory does not match its contents.");
      if (entry.originalSize > MAX_BYTES) fail("Expanded ZIP file exceeds 64 MB.");
      return !entry.name.endsWith("/") && !entry.name.split("/").some(part => [".git", "node_modules", "__MACOSX", ".DS_Store"].includes(part));
    } });
    for (const [raw, content] of Object.entries(contents)) {
      const path = safePath(raw);
      files.set(path, { path, bytes: content, mode: modes.get(raw) ?? 0o600 });
    }
  } catch (error) { if (error instanceof ApiError) throw error; fail("Could not read ZIP. Export an unencrypted ZIP folder."); }
  return files;
}
async function loadSource(request: PluginImportRequest): Promise<PackageFiles> {
  if ("url" in request.source) fail("Repository sources must be resolved to an immutable snapshot first.");
  if ("path" in request.source) {
    const path = resolve(request.source.path);
    if (/\.(zip|plugin)$/i.test(path)) {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) fail("Choose an ordinary ZIP smaller than 64 MB.");
      return readZip(await readFile(path));
    }
    return readPluginFolder(path);
  }
  const base64 = request.source.zipBase64;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) fail("Invalid ZIP encoding.");
  return readZip(Buffer.from(base64, "base64"));
}
function textFile(files: PackageFiles, path: string): string {
  const file = files.get(path);
  if (!file) fail(`The plugin references a missing file: ${path}`);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes); } catch { return fail(`Expected UTF-8 text in ${path}`); }
}
function jsonFile(files: PackageFiles, path: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(textFile(files, path)); } catch (error) { if (error instanceof ApiError) throw error; return fail(`Invalid JSON in ${path}`); }
  if (!record(parsed)) fail(`Expected an object in ${path}`);
  return parsed;
}
function packageRoots(files: PackageFiles, provider: PluginImportProvider, detectFormat = false): string[] {
  const suffixes = detectFormat ? [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"] : [provider === "chatgpt" ? ".codex-plugin/plugin.json" : ".claude-plugin/plugin.json"];
  const roots = new Set<string>();
  for (const path of files.keys()) {
    for (const manifest of suffixes) if (path === manifest || path.endsWith(`/${manifest}`)) roots.add(path.slice(0, -manifest.length).replace(/\/$/, ""));
    if ((path === "plugin.json" || path.endsWith("/plugin.json")) && !path.includes(".claude-plugin/") && !path.includes(".codex-plugin/")) {
      const manifest = jsonFile(files, path);
      if (str(manifest.name)) roots.add(path.slice(0, -"plugin.json".length).replace(/\/$/, ""));
    }
  }
  if (roots.size) return [...roots].filter(root => ![...roots].some(parent => parent !== root && (!parent || root.startsWith(`${parent}/`)))).sort();
  const otherManifest = provider === "chatgpt" ? ".claude-plugin/plugin.json" : ".codex-plugin/plugin.json";
  if ([...files.keys()].some(path => path === otherManifest || path.endsWith(`/${otherManifest}`))) fail(`This package uses the ${provider === "chatgpt" ? "Claude" : "ChatGPT"} format. Choose the matching import button.`);
  // Plain skill folders, collections and manifest-free Claude plugins.
  if (files.has("SKILL.md") || [...files.keys()].some(path => /^(skills\/.*\/SKILL\.md|commands\/.*\.md|agents\/.*\.md)$/.test(path))) return [""];
  const skillRoots = [...files.keys()].filter(path => path.endsWith("/SKILL.md")).map(path => dirname(path).replace(/\\/g, "/"));
  if (!skillRoots.length) return [];
  const keys = [...files.keys()];
  const folders = keys[0]?.split("/").slice(0, -1) ?? [];
  let root = "";
  for (const folder of folders) {
    const candidate = root ? `${root}/${folder}` : folder;
    if (!keys.every(path => path.startsWith(`${candidate}/`))) break;
    root = candidate;
  }
  return [root];
}
function subFiles(files: PackageFiles, root: string): PackageFiles {
  if (!root) return files;
  const prefix = `${safePath(root)}/`;
  return new Map([...files.values()].filter(file => file.path.startsWith(prefix)).map(file => { const path = file.path.slice(prefix.length); return [path, { ...file, path }]; }));
}
function expandRoot(value: unknown, root: string, data?: string): unknown {
  if (typeof value === "string") return data ? value.replaceAll("${PLUGIN_ROOT}", root).replaceAll("${PLUGIN_DATA}", data) : value.replace(/\$\{(?:(?:CLAUDE|CODEX)_PLUGIN_ROOT|PLUGIN_ROOT)\}/g, root).replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]+)\}/g, (_, fallback: string) => fallback);
  if (Array.isArray(value)) return value.map(entry => expandRoot(entry, root, data));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandRoot(entry, root, data)]));
  return value;
}
function paths(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every(entry => typeof entry === "string")) return value;
  return fail("Component paths must be a path string or an array of paths.");
}

function packageManifest(files: PackageFiles, provider: PluginImportProvider | "legalwork", warnings: string[] = [], entry?: Record<string, unknown>) {
  const portable = files.has("plugin.json");
  const legacyPath = provider === "chatgpt" ? ".codex-plugin/plugin.json" : ".claude-plugin/plugin.json";
  const raw = portable ? jsonFile(files, "plugin.json") : marketplaceManifest(files.has(legacyPath) ? jsonFile(files, legacyPath) : {}, entry, files.has(legacyPath));
  const base: Record<string, unknown> = portable && provider !== "legalwork" ? validatePortableManifest(raw, warnings) : raw;
  const openai = record(base.extensions) && record(base.extensions["com.openai"]) ? base.extensions["com.openai"] : null;
  // OpenAI's portable extension replaces the legacy overlay, rather than merging it.
  const overlay = portable && provider === "chatgpt" && !openai && files.has(legacyPath) ? jsonFile(files, legacyPath) : openai;
  const manifest: Record<string, unknown> = { ...base, ...overlay, ...(portable ? { name: base.name, description: base.description, version: base.version } : {}) };
  return { portable, legacyPath, base, manifest };
}

/** Use the same MCP precedence for whole plugins, discovery and individual imports. */
function packageConnectors(files: PackageFiles, manifest: Record<string, unknown>, portable: boolean, warnings: string[], native = false) {
  let servers: Record<string, unknown> = {};
  const configPaths = new Set([".mcp.json", "mcp.json"]);
  const portableNames = new Set<string>();
  const mergeMcp = (value: unknown, strict = false) => {
    if (typeof value === "string") {
      if (/\.(mcpb|dxt)$|^https?:/i.test(value)) { warnings.push(`Connector bundle ${value}: its connectors will not be installed. This bundle format is not supported.`); return; }
      const path = safePath(value);
      configPaths.add(path);
      mergeMcp(jsonFile(files, path), strict);
    } else if (Array.isArray(value)) value.forEach(entry => mergeMcp(entry, strict));
    else if (record(value)) {
      const definitions = strict ? validatePortableMcp(value) : record(value.mcpServers) ? value.mcpServers : value;
      servers = { ...servers, ...definitions };
      for (const name of Object.keys(definitions)) { if (strict) portableNames.add(name); else portableNames.delete(name); }
    }
    else if (value !== undefined) fail("Invalid MCP configuration.");
  };
  const defaultMcp = portable ? "mcp.json" : ".mcp.json";
  if (files.has(defaultMcp)) mergeMcp(defaultMcp, portable && !native);
  if (manifest.mcpServers !== undefined) mergeMcp(manifest.mcpServers);
  return { servers, configPaths, portableNames };
}

function bundledConnectorFiles(files: PackageFiles, request: PluginImportRequest, entry?: Record<string, unknown>): PackageFiles {
  if (!("path" in request.source) || !request.source.connector) fail("Choose a bundled connector.");
  const selector = request.source.connector;
  const { portable, legacyPath, base, manifest } = packageManifest(files, request.source.provider, [], entry);
  const { servers, configPaths } = packageConnectors(files, manifest, portable, []);
  const selected = Object.hasOwn(servers, selector.name) ? servers[selector.name] : undefined;
  if (!record(selected)) fail("This connector is no longer in the plugin. Scan again and select another connector.");
  const pluginName = str(base.name) ?? str(manifest.name) ?? basename(request.source.path);
  const presentation = record(manifest.interface) ? manifest.interface : {};
  const pluginLabel = str(presentation.displayName) ?? pluginName;
  const identity = createHash("sha256").update(JSON.stringify({ provider: request.source.provider, plugin: pluginName, connector: selector.name })).digest("hex").slice(0, 12);
  // Local connectors may depend on arbitrary package-relative files. Keep those
  // in a separate bundle, but never register the plugin's other components or copy its MCP configs.
  const resources: PackageFiles = new Map();
  if (selected.command) for (const file of files.values()) {
    if (!configPaths.has(file.path) && !["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".app.json"].includes(file.path)) resources.set(file.path, file);
  }
  const contents = {
    [legacyPath]: { name: `connector-${slug(selector.name).slice(0, 32)}-${identity}`, version: manifest.version, interface: { displayName: selector.name.replace(/[-_]+/g, " ").replace(/\b\w/g, letter => letter.toUpperCase()), shortDescription: `Connector from ${pluginLabel}` } },
    ".mcp.json": { mcpServers: { [selector.name]: { ...selected, enabled: false } } },
    "LEGALWORK-CONNECTOR-SOURCE.json": { provider: request.source.provider, plugin: pluginName, pluginRoot: selector.pluginRoot, connector: selector.name },
  };
  for (const [path, value] of Object.entries(contents)) resources.set(path, { path, bytes: Buffer.from(JSON.stringify(value, null, 2)), mode: 0o600 });
  return resources;
}

function planPackage(files: PackageFiles, root: string, request: PluginImportRequest, workspaceRoot: string, connectorWarnings: string[] = [], marketplaceEntry?: Record<string, unknown>): PluginImportPlan {
  const source = request.source;
  const origin: Omit<PluginImportProvenance, "root" | "digest" | "version"> = { provider: source.provider, kind: "url" in source ? "github" : "path" in source ? source.connector ? "configuration" : /\.(zip|plugin)$/i.test(source.path) ? "archive" : "folder" : "archive", location: "path" in source ? resolve(source.path) : "url" in source ? source.url : source.filename || "uploaded-archive", ...("url" in source && source.ref ? { ref: source.ref } : {}), ...("path" in source && source.marketplace ? { marketplace: source.marketplace } : {}) };
  return planPluginFiles(files, root, { provider: source.provider, scope: request.scope, path: "path" in source ? source.path : undefined, connector: "path" in source && Boolean(source.connector), asWorkflow: request.asWorkflow, marketplaceEntry, origin: { ...origin, ...(request.asWorkflow ? { asWorkflow: true } : {}) } }, workspaceRoot, connectorWarnings);
}

export function planCreatedPlugin(files: PackageFiles, workspaceRoot: string, id: string): PluginImportPlan {
  return planPluginFiles(files, "", { provider: "legalwork", scope: "global", id }, workspaceRoot);
}

function planPluginFiles(files: PackageFiles, root: string, target: { provider: PluginImportProvider | "legalwork"; scope: "global" | "project"; path?: string; connector?: boolean; asWorkflow?: boolean; marketplaceEntry?: Record<string, unknown>; id?: string; origin?: Omit<PluginImportProvenance, "root" | "digest" | "version"> }, workspaceRoot: string, connectorWarnings: string[] = []): PluginImportPlan {
  const warnings: string[] = [...connectorWarnings];
  const { portable, legacyPath, base, manifest } = packageManifest(files, target.provider, warnings, target.marketplaceEntry);
  const name = str(base.name) ?? str(manifest.name) ?? (files.has("SKILL.md") ? str(parseFrontmatter(textFile(files, "SKILL.md")).data.name) : null) ?? basename(root || target.path || "imported-plugin");
  const presentation = record(manifest.interface) ? manifest.interface : {};
  const displayName = str(presentation.displayName) ?? str(manifest.displayName) ?? undefined;
  const description = str(presentation.shortDescription) ?? str(base.description) ?? str(manifest.description);
  const sourceIdentity = target.origin ? createHash("sha256").update(JSON.stringify([target.origin.kind, target.origin.location, target.origin.directory, root, target.connector, target.origin.asWorkflow])).digest("hex").slice(0, 16) : undefined;
  const id = target.id ?? `import:${target.provider}:${name}:${sourceIdentity ? `${sourceIdentity}:` : ""}${target.scope}`;
  const namespace = pluginNamespace(name, id);
  const bundlePath = `.opencode/imported-plugins/${namespace}`;
  const absoluteBundle = resolveWorkspaceInstallPath(workspaceRoot, bundlePath, target.scope === "global");
  const dataPath = `.opencode/plugin-data/${namespace}`;
  const absoluteData = resolveWorkspaceInstallPath(workspaceRoot, dataPath, target.scope === "global");
  const requirements = target.provider === "legalwork" ? [] : pluginRequirements(manifest);
  const components: PluginImportPreview["components"] = [];
  const memberships: CloudPluginResolved["memberships"] = [];
  const resourceFiles: PackageFile[] = [...files.values()].map(file => ({ ...file, path: `${bundlePath}/${file.path}` }));
  const seen = new Set<string>();
  const sourceDocuments = new Set<string>();
  const addDocument = (type: "skill" | "agent" | "command", sourcePath: string, inline?: string, suppliedName?: string, overrides?: Record<string, unknown>) => {
    const raw = inline ?? textFile(files, sourcePath);
    const parsed = parseFrontmatter(raw);
    if (overrides) for (const [key, value] of Object.entries(overrides)) if (key !== "source" && key !== "content") parsed.data[key] = value;
    const originalName = suppliedName ?? str(parsed.data.name) ?? (type === "skill" ? (dirname(sourcePath) === "." ? name : basename(dirname(sourcePath))) : basename(sourcePath, ".md"));
    const documentKey = `${type}:${sourcePath}`;
    if (sourceDocuments.has(documentKey)) return;
    sourceDocuments.add(documentKey);
    let installedName = `${slug(name).slice(0, 20)}-${createHash("sha256").update(id).digest("hex").slice(0, 8)}-${slug(originalName).slice(0, 32)}`;
    if (seen.has(`${type}:${installedName}`)) {
      installedName = `${installedName.slice(0, 54).replace(/-+$/, "")}-${createHash("sha256").update(sourcePath).digest("hex").slice(0, 8)}`;
    }
    if (type === "skill" && target.asWorkflow) installedName = `workflow-assistant-${installedName}`.slice(0, 64).replace(/-+$/, "");
    const key = `${type}:${installedName}`;
    seen.add(key);
    const destination = type === "skill" ? `.opencode/skills/${namespace}/${installedName}/SKILL.md` : `.opencode/${type === "agent" ? "agents" : "commands"}/${namespace}/${installedName}.md`;
    let body = parsed.body.replace(/\$\{(?:(?:CLAUDE|CODEX)_PLUGIN_ROOT|PLUGIN_ROOT)\}/g, absoluteBundle)
      .replace(/\$\{CLAUDE_SKILL_DIR\}/g, join(absoluteBundle, dirname(sourcePath)))
      .replace(/\$\{CLAUDE_PROJECT_DIR\}/g, workspaceRoot)
      .replace(/\$\{(?:CLAUDE_)?PLUGIN_DATA\}/g, absoluteData);
    if (/\$\{CLAUDE_(SESSION_ID|EFFORT)\}|!`/.test(body)) warnings.push(`${type} ${originalName}: Claude runtime substitutions and dynamic commands will not run in LegalWork.`);
    // Links and code paths retain a usable location even when outside a skill's folder.
    body = body.replace(/\]\((\.\.?\/[^)]+)\)/g, (_, relative: string) => `](${join(absoluteBundle, dirname(sourcePath), relative).replace(/\\/g, "/")})`);
    body += `\n\nImported package resources: ${absoluteBundle.replace(/\\/g, "/")}. Resolve package-relative paths there.\n`;
    if (components.some(entry => entry.type === "mcp")) body += "\nImported connector names are listed in the package's LegalWork import report.\n";
    if (str(parsed.data.model) && !str(parsed.data.model)?.includes("/")) warnings.push(`${type} ${originalName}: the source model "${str(parsed.data.model)}" will not be selected automatically. LegalWork's current model will be used instead.`);
    const unsupportedExecution = {
      "allowed-tools": "tool restrictions", "disable-model-invocation": "manual-only invocation", context: "separate execution context",
      hooks: "automatic hooks", permissionMode: "permission mode", skills: "automatic skill loading", mcpServers: "embedded connector declarations",
    };
    const ignored = Object.entries(unsupportedExecution).filter(([field]) => parsed.data[field]).map(([, label]) => label);
    if (target.provider === "legalwork" && ignored.length) warnings.push(`${type} ${originalName}: ${ignored.join(", ")} will not carry over. LegalWork's own execution and tool permissions apply.`);
    if (target.provider !== "legalwork" && ignored.length) requirements.push({ kind: "permission", name: originalName, code: "execution_semantics", required: Boolean(parsed.data["allowed-tools"] || parsed.data["disable-model-invocation"] || parsed.data.context), status: parsed.data["allowed-tools"] || parsed.data["disable-model-invocation"] || parsed.data.context ? "blocked" : "changed", message: `${originalName} requires ${ignored.join(", ")}. LegalWork cannot preserve this behavior; adapt the skill before using it here.` });
    if (target.provider !== "legalwork") requirements.push(...instructionRequirements(originalName, raw, type));
    const content = buildFrontmatter({ ...parsed.data, name: installedName }) + "\n" + body;
    memberships.push({ configObjectId: key, configObject: { id: key, objectType: type, title: installedName, description: str(parsed.data.description) ?? originalName, currentRelativePath: destination, status: "active", updatedAt: null, latestVersion: { id: createHash("sha256").update(raw).digest("hex"), rawSourceText: content, normalizedPayloadJson: null } } });
    components.push({ type, name: originalName, installedName: type === "agent" ? `${namespace}/${installedName}` : installedName });
    if (type === "skill" && inline === undefined) {
      const directory = posix.dirname(sourcePath);
      const prefix = directory === "." ? "" : `${directory}/`;
      const nestedSkills = [...files.keys()].filter(path => path !== sourcePath && /(^|\/)SKILL\.md$/.test(path) && path.startsWith(prefix)).map(path => `${posix.dirname(path)}/`);
      for (const file of files.values()) {
        if (nestedSkills.some(nested => file.path.startsWith(nested))) continue;
        if (/(^|\/)SKILL\.md$/.test(file.path) || !file.path.startsWith(prefix)) continue;
        resourceFiles.push({ ...file, path: `${posix.dirname(destination)}/${file.path.slice(prefix.length)}` });
      }
    }
  };
  const selectDocuments = (value: unknown, defaults: string[], type: "skill" | "agent" | "command") => {
    const roots = [...new Set([...defaults, ...paths(value)])];
    for (const path of roots) {
      const selected = path === "." || path === "./" ? "" : safePath(path);
      if (files.has(selected) && selected.endsWith(".md")) { addDocument(type, selected); continue; }
      const matches = [...files.keys()].filter(entry => (!selected || entry.startsWith(`${selected}/`)) && (type === "skill" ? portable && target.provider !== "legalwork" ? new RegExp(`^${selected}/[^/]+/SKILL\\.md$`).test(entry) : /(^|\/)SKILL\.md$/.test(entry) : entry.endsWith(".md")));
      const defaultLocation = defaults.some(path => (path === "." || path === "./" ? "" : safePath(path)) === selected);
      if (!matches.length && !defaultLocation) fail(`No ${type} files found at ${path}`);
      for (const entry of matches) addDocument(type, entry);
    }
  };
  if (!target.connector) {
    selectDocuments(manifest.skills, files.has("SKILL.md") || (!portable && !files.has(legacyPath) && ![...files.keys()].some(path => path.startsWith("skills/"))) ? ["."] : ["skills"], "skill");
    selectDocuments(manifest.agents, manifest.agents ? [] : ["agents"], "agent");
    const addCommands = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(addCommands); return; }
      if (!record(value)) { selectDocuments(value, [], "command"); return; }
      for (const [commandName, definition] of Object.entries(value)) {
        if (!record(definition)) fail(`Invalid command definition: ${commandName}`);
        const source = str(definition.source);
        const content = str(definition.content);
        if (source) addDocument("command", safePath(source), undefined, commandName, definition);
        else if (content) addDocument("command", `commands/${slug(commandName)}.md`, buildFrontmatter({ description: definition.description, model: definition.model }) + "\n" + content, commandName);
        else fail(`Command ${commandName} needs source or content.`);
      }
    };
    if (manifest.commands === undefined) selectDocuments(undefined, ["commands"], "command");
    else addCommands(manifest.commands);
  }
  let servers: Record<string, unknown> = {};
  let portableNames = new Set<string>();
  try { const configs = packageConnectors(files, manifest, portable, warnings, target.provider === "legalwork"); servers = configs.servers; portableNames = configs.portableNames; }
  catch (error) { if (!portable || target.provider === "legalwork") throw error; requirements.push({ kind: "runtime", name: "Connectors", code: "invalid_mcp_document", status: "changed", required: false, message: error instanceof Error ? error.message : "The portable connectors are invalid and will be excluded." }); }
  const normalizedServers: Record<string, unknown> = {};
  const connectorConfigs: Record<string, Record<string, unknown>> = {};
  const connectorChecks: ConnectorImportCheck[] = [];
  for (const [serverName, original] of Object.entries(servers)) {
    if (serverName === "$schema") continue;
    const installedName = `${namespace}-${target.scope === "global" ? "global" : createHash("sha256").update(resolve(workspaceRoot)).digest("hex").slice(0, 8)}-${slug(serverName)}-${createHash("sha256").update(serverName).digest("hex").slice(0, 6)}`;
    if (!record(original)) {
      connectorChecks.push({ name: serverName, installedName, status: "blocked", code: "invalid_entry", message: "This connector has an invalid configuration. Correct its declaration before importing." });
      continue;
    }
    const portableConnector = portableNames.has(serverName) && target.provider !== "legalwork";
    let portableError = portableConnector ? portableEntryError(original) : undefined;
    if (portableNames.has(serverName) && original.type === "sse") portableError = "LegalWork cannot preserve the required SSE-first transport for this portable connector. Obtain a Streamable HTTP configuration instead.";
    if (portableError) { connectorChecks.push({ name: serverName, installedName, status: "blocked", code: "portable_entry", message: portableError }); continue; }
    const imported = normalizeImportedConnector(original, warnings, target.provider);
    const expanded = portableConnector ? { ...imported, ...Object.fromEntries(["args", "env", "cwd"].filter(key => imported[key] !== undefined).map(key => [key, expandRoot(imported[key], absoluteBundle, absoluteData)])) } : expandRoot(imported, absoluteBundle);
    if (!record(expanded)) fail(`Invalid MCP server: ${serverName}`);
    const withData = (value: unknown): unknown => typeof value === "string" ? value.replace(/\$\{(?:CLAUDE_|CODEX_)?PLUGIN_DATA\}/g, absoluteData) : Array.isArray(value) ? value.map(withData) : record(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withData(item)])) : value;
    const expandedData = portableConnector ? expanded : withData(expanded);
    if (!record(expandedData)) fail(`Invalid connector: ${serverName}`);
    const normalized: Record<string, unknown> = { ...expandedData };
    if (typeof normalized.cwd === "string" && !isAbsolute(normalized.cwd) && !normalized.cwd.includes("${")) normalized.cwd = resolve(absoluteBundle, normalized.cwd);
    if (portableConnector) {
      if (!normalized.url && !normalized.cwd) normalized.cwd = absoluteBundle;
      if (typeof normalized.cwd === "string" && !connectorConfigVariables(normalized.cwd).length && ![absoluteBundle, absoluteData].some(boundary => { const path = relative(boundary, String(normalized.cwd)); return !path.startsWith("..") && !isAbsolute(path); })) portableError = "A portable connector's working directory must stay inside its package or persistent data directory.";
    } else if (Array.isArray(normalized.args)) normalized.args = normalized.args.map(argument => typeof argument === "string" && files.has(argument.replace(/^\.\//, "")) ? join(absoluteBundle, argument.replace(/^\.\//, "")) : argument);
    if (typeof normalized.command === "string" && !normalized.url) normalized.env = { ...(record(normalized.env) ? normalized.env : {}), CLAUDE_PLUGIN_ROOT: absoluteBundle, CODEX_PLUGIN_ROOT: absoluteBundle, PLUGIN_ROOT: absoluteBundle, PLUGIN_DATA: absoluteData, CLAUDE_PLUGIN_DATA: absoluteData };
    if (portableConnector && !normalized.url && record(normalized.env)) normalized.env.PLUGIN_DATA = absoluteData;
    if (typeof normalized.command === "string" && /^\.\//.test(normalized.command)) normalized.command = join(absoluteBundle, safePath(normalized.command));
    const auth = record(normalized.extensions) && record(normalized.extensions["com.openai"]) && record(normalized.extensions["com.openai"].auth) ? normalized.extensions["com.openai"].auth : null;
    if (auth?.type === "none") normalized.oauth = false;
    else if (auth?.type === "api_key") {
      normalized.oauth = false;
      const header = auth.headerScheme === "custom_header" ? str(auth.headerName) : "Authorization";
      if (header && !/^host$/i.test(header)) normalized.headers = { ...(record(normalized.headers) ? normalized.headers : {}), [header]: auth.headerScheme === "bearer" ? "Bearer ${API_KEY}" : auth.headerScheme === "basic" ? "Basic ${BASIC_AUTH_CREDENTIALS}" : "${API_KEY}" };
    }
    else if (auth?.type === "oauth" || auth?.type === "mixed") {
      const client = record(auth.client) ? auth.client : {};
      const scopes = Array.isArray(auth.defaultScopes) ? auth.defaultScopes : auth.baseScopes;
      normalized.oauth = { ...(record(normalized.oauth) ? normalized.oauth : {}), ...(str(client.clientId) ? { clientId: client.clientId } : {}), ...(client.mode === "provided" && client.tokenEndpointAuthMethod === "client_secret_post" ? { clientSecret: "${OAUTH_CLIENT_SECRET}" } : {}), ...(Array.isArray(scopes) ? { scope: scopes.filter(scope => typeof scope === "string").join(" ") } : {}) };
    }
    if (connectorConfigVariables(normalized).length || auth?.type === "api_key" || normalized.userConfig) {
      normalized.enabled = false;
    }
    if (typeof normalized.url === "string" && (!normalized.url.trim() || /\$\{|[{}]/.test(normalized.url))) {
      normalized.enabled = false;
    }
    if (normalized.headersHelper) normalized.enabled = false;
    if (Array.isArray(normalized.command) && (!normalized.command.length || normalized.command.some(part => typeof part !== "string") || !str(normalized.command[0]))) fail(`Invalid command array for connector ${serverName}`);
    if (normalized.args && (!Array.isArray(normalized.args) || normalized.args.some(part => typeof part !== "string"))) fail(`Invalid arguments for connector ${serverName}`);
    if (target.provider !== "legalwork") {
      connectorConfigs[installedName] = normalized;
      const check: ConnectorImportCheck = portableError ? { name: serverName, installedName, status: "blocked", code: "portable_entry", message: portableError } satisfies ConnectorImportCheck : assessImportedConnector(serverName, installedName, original, normalized);
      if (portableConnector && original.type === "streamable-http") check.declaredTransport = "streamable-http";
      connectorChecks.push(check);
      if (check.status === "blocked") continue;
      // Imported declarations never run before users finish their own setup.
      normalized.enabled = false;
    }
    normalizedServers[installedName] = normalized;
    components.push({ type: "mcp", name: serverName, installedName });
  }
  if (Object.keys(normalizedServers).length) memberships.push({ configObjectId: `${id}/mcp`, configObject: { id: `${id}/mcp`, objectType: "mcp", title: name, description: null, currentRelativePath: null, status: "active", updatedAt: null, latestVersion: { id: "mcp", rawSourceText: null, normalizedPayloadJson: { mcpServers: normalizedServers } } } });
  if (resourceFiles.length > 10000 || resourceFiles.reduce((total, file) => total + file.bytes.length, 0) > 128 * 1024 * 1024) fail("Installed package resources exceed 128 MB or 10,000 files. Import a smaller plugin folder.");
  const unsupported = {
    hooks: "Automatic hooks", lspServers: "Language-server integrations", outputStyles: "Custom output styles", settings: "Platform settings",
    workflows: "Platform workflow definitions", userConfig: "Provider setup forms", channels: "Provider message channels", themes: "Themes", monitors: "Background monitors", evals: "Evaluation runners",
  };
  const hasBehavior = (field: string) => Boolean(manifest[field] || (field === "hooks" && files.has("hooks/hooks.json")) || (field === "lspServers" && files.has(".lsp.json")) || (field === "settings" && files.has("settings.json")) || [...files.keys()].some(path => path.startsWith(`${field === "outputStyles" ? "output-styles" : field}/`)));
  for (const [field, label] of Object.entries(unsupported)) if (target.provider === "legalwork" && hasBehavior(field)) warnings.push(`${label} (${field}) will not run in LegalWork. Their source files will be saved without activating them.`);
  if (manifest.experimental) warnings.push("Experimental Claude features will not run in LegalWork. Their source files will be saved without activating them.");
  const appPaths = paths(manifest.apps ?? (files.has(".app.json") ? ".app.json" : undefined)).map(safePath);
  for (const path of appPaths) {
    requirements.push(...appConnectionRequirements(files.has(path) ? textFile(files, path) : "", path));
  }
  if (target.provider !== "legalwork") for (const [field, label] of Object.entries(unsupported)) if (hasBehavior(field)) requirements.push({ kind: "runtime", name: label, code: `unsupported_${field}`, required: false, status: "changed", message: `${label} will not run in LegalWork. Workflows that depend on this behavior must be adapted.` });
  if (components.length === 0 && !connectorChecks.length) warnings.push("This package has no supported skills, agents, commands or connectors to import.");
  const hash = createHash("sha256").update(JSON.stringify({ provider: target.provider, root, scope: target.scope, workspaceRoot: resolve(workspaceRoot), marketplaceEntry: target.marketplaceEntry }));
  for (const file of [...files.values()].sort((a, b) => a.path.localeCompare(b.path))) hash.update(file.path).update(String(file.mode)).update(file.bytes);
  const preview: PluginImportPreview = { id, digest: hash.digest("hex"), name, displayName, description, version: str(manifest.version), format: target.connector ? "connectors" : portable ? "portable" : files.has(legacyPath) || target.marketplaceEntry ? target.provider === "chatgpt" ? "codex" : "claude" : "skills", root, fileCount: files.size, bytes: [...files.values()].reduce((sum, file) => sum + file.bytes.length, 0), components, warnings: [...new Set(warnings)], ...(connectorChecks.length ? { connectors: connectorChecks } : {}) };
  preview.requirements = requirements;
  if (target.origin) preview.provenance = { ...target.origin, root, digest: preview.digest, version: preview.version };
  evaluateImportRequirements(preview);
  let reportName = "LEGALWORK-IMPORT.json";
  for (let i = 2; files.has(reportName); i++) reportName = `LEGALWORK-IMPORT-${i}.json`;
  resourceFiles.push({ path: `${bundlePath}/${reportName}`, bytes: Buffer.from(JSON.stringify(preview, null, 2)), mode: 0o600 });
  // Namespaced components remain discoverable from every imported instruction.
  for (const membership of memberships) {
    const version = membership.configObject?.latestVersion;
    if (version?.rawSourceText) {
      const parsed = parseFrontmatter(version.rawSourceText);
      const referencedAgent = components.find(entry => entry.type === "agent" && (entry.name === parsed.data.agent || `${name}:${entry.name}` === parsed.data.agent));
      if (referencedAgent) parsed.data.agent = referencedAgent.installedName;
      let body = parsed.body;
      for (const component of components) body = body.split(`${name}:${component.name}`).join(component.installedName);
      version.rawSourceText = buildFrontmatter(parsed.data) + "\n" + body + `\nComponent mapping: ${components.map(entry => `${entry.type} ${entry.name} → ${entry.installedName}`).join(", ")}.\n`;
    }
  }
  return { preview, resolved: { plugin: { id, name, displayName, description, updatedAt: null, sourceKind: preview.format === "connectors" ? "connector" : preview.format === "skills" && components.every(component => component.type === "skill") ? "skill" : "plugin", provenance: preview.provenance, importState: { readiness: preview.readiness || "ready", requirements } }, memberships }, resourceFiles, ...(connectorChecks.length ? { connectorConfigs } : {}), ...(target.provider !== "legalwork" ? { dataPaths: [dataPath] } : {}) };
}
export async function resolvePluginImports(request: PluginImportRequest, workspaceRoot: string): Promise<PluginImportPlan[]> {
  if ("path" in request.source && request.source.connector && request.source.connector.pluginRoot === undefined) {
    if (request.root !== undefined && request.root !== "") fail("Selected connector root was not found.");
    const bundle = await connectorImportBundle(request.source.provider, request.source.path, request.source.connector);
    const files: PackageFiles = new Map(Object.entries(bundle.files).map(([path, text]) => [path, { path, bytes: Buffer.from(text), mode: 0o600 }]));
    return [planPackage(files, "", request, workspaceRoot, bundle.warnings)];
  }
  const marketplaces = new Map<string, { entry: Record<string, unknown>; provider: PluginImportProvider }>();
  if ("path" in request.source && request.source.marketplace) {
    const catalogPath = resolve(request.source.marketplace).replace(/\\/g, "/");
    const suffix = catalogPath.endsWith("/.agents/plugins/marketplace.json") ? ".agents/plugins/marketplace.json" : catalogPath.endsWith("/.claude-plugin/marketplace.json") ? ".claude-plugin/marketplace.json" : null;
    const info = await lstat(catalogPath).catch(() => null);
    if (!suffix || !info?.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) fail("The local marketplace is no longer available. Scan again or choose the plugin folder.");
    const catalogRoot = catalogPath.slice(0, -suffix.length);
    const sourcePath = resolve(request.source.path);
    const rootPath = await realpath(catalogRoot);
    const selectedPath = await realpath(sourcePath);
    const relativePath = relative(rootPath, selectedPath);
    if (relativePath.split(/[\\/]/)[0] === ".." || isAbsolute(relativePath)) fail("The marketplace plugin resolves outside its marketplace folder. Copy it inside the marketplace before importing.");
    let catalog: unknown;
    try { catalog = JSON.parse(await readFile(catalogPath, "utf8")); } catch { fail("The local marketplace cannot be read. Correct its JSON and scan again."); }
    const selected = localMarketplaceEntries(catalog).find(source => resolve(catalogRoot, source.path) === sourcePath);
    if (!selected) fail("This plugin is no longer listed in its marketplace. Scan again or choose its folder.");
    marketplaces.set("", { entry: selected.entry, provider: suffix.startsWith(".agents") ? "chatgpt" : request.source.provider });
  }
  const remote = "url" in request.source ? await githubPluginSource(request.source.url, request.source.ref, request.source.directory) : undefined;
  const localRequest = "path" in request.source && request.source.marketplace ? { ...request, source: { ...request.source, path: await realpath(request.source.path) } } : request;
  let files = remote ? readZip(remote.bytes) : await loadSource(localRequest);
  if (remote) {
    const wrapper = [...files.keys()][0]?.split("/")[0];
    if (!wrapper || ![...files.keys()].every(path => path.startsWith(`${wrapper}/`))) fail("The repository archive has an invalid package root.");
    files = subFiles(files, [wrapper, remote.directory].filter(Boolean).join("/"));
  }
  const detectFormat = request.detectFormat !== false;
  let hasMarketplace = false;
  for (const path of files.keys()) {
    const suffix = path.endsWith(".agents/plugins/marketplace.json") ? ".agents/plugins/marketplace.json" : path.endsWith(".claude-plugin/marketplace.json") ? ".claude-plugin/marketplace.json" : null;
    if (!suffix || path !== suffix && !path.endsWith(`/${suffix}`)) continue;
    // A plugin may include marketplace templates as supporting resources. They
    // must not turn the containing plugin into an unrelated collection.
    const insidePlugin = [...files.keys()].some(file => {
      const manifest = [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", "plugin.json"].find(name => file === name || file.endsWith(`/${name}`));
      if (!manifest) return false;
      const root = file.slice(0, -manifest.length);
      return path.startsWith(root);
    });
    if (insidePlugin) continue;
    hasMarketplace = true;
    const base = path.slice(0, -suffix.length);
    for (const { path: sourcePath, entry } of localMarketplaceEntries(jsonFile(files, path))) {
      const root = posix.join(base, sourcePath).replace(/^\.$/, "");
      if ([...files.keys()].some(file => !root || file.startsWith(`${root}/`))) marketplaces.set(root, { entry, provider: suffix.startsWith(".agents") ? "chatgpt" : request.source.provider });
    }
  }
  const roots = marketplaces.size || hasMarketplace ? [...marketplaces.keys()] : packageRoots(files, request.source.provider, detectFormat);
  if (hasMarketplace && !roots.length) fail("This marketplace has no local plugin folders in this download. Choose an installed plugin folder or import its repository directly. Remote, registry and command sources are not fetched from marketplace catalogs.");
  if (!roots.length) fail("No plugin manifest or SKILL.md found. Choose a plugin folder, skills folder, or their ZIP export.");
  if ("path" in request.source && request.source.connector?.pluginRoot !== undefined) {
    const root = request.source.connector.pluginRoot;
    if (!roots.includes(root) || request.root !== undefined && request.root !== root) fail("Selected plugin connector root was not found.");
    const selectedFiles = bundledConnectorFiles(subFiles(files, root), request, marketplaces.get(root)?.entry);
    return [planPackage(selectedFiles, root, request, workspaceRoot)];
  }
  if (request.root !== undefined && !roots.includes(request.root)) fail("Selected plugin root was not found.");
  return roots.filter(root => request.root === undefined || root === request.root).map(root => {
    const selected = subFiles(files, root);
    const marketplace = marketplaces.get(root);
    const provider = detectFormat ? selected.has(".codex-plugin/plugin.json") || selected.has("plugin.json") ? "chatgpt" : selected.has(".claude-plugin/plugin.json") ? "claude" : marketplace?.provider ?? request.source.provider : request.source.provider;
    // The workflow chooser converts only plain skill packages. Keep the older
    // explicit conversion contract for saved imports and their updates.
    const asWorkflow = request.asWorkflow && (!request.workflowSkillsOnly || !marketplace && !["plugin.json", ".codex-plugin/plugin.json", ".claude-plugin/plugin.json"].some(path => selected.has(path)));
    return remote
      ? planPluginFiles(selected, root, { provider, scope: request.scope, asWorkflow, marketplaceEntry: marketplace?.entry, origin: { provider, kind: "github", location: remote.location, ref: remote.ref, directory: remote.directory, revision: remote.revision, ...(asWorkflow ? { asWorkflow: true } : {}) } }, workspaceRoot)
      : planPackage(selected, root, { ...request, asWorkflow, source: { ...request.source, provider } }, workspaceRoot, [], marketplace?.entry);
  });
}

export async function discoverPluginImports(provider: PluginImportProvider, workspaceRoot: string): Promise<PluginImportCandidate[]> {
  const home = process.env.LEGALWORK_PLUGIN_DISCOVERY_HOME?.trim() || homedir();
  const codex = process.env.CODEX_HOME?.trim() || join(home, ".codex");
  const claude = process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  const roots = provider === "chatgpt" ? [join(codex, "plugins"), join(home, ".agents", "plugins"), join(home, ".agents", "skills"), join(workspaceRoot, ".agents", "skills"), join(workspaceRoot, ".agents", "plugins")] : [join(claude, "plugins"), join(claude, "skills"), join(workspaceRoot, ".claude", "skills"), join(workspaceRoot, ".claude", "plugins")];
  const results = new Map<string, PluginImportCandidate>();
  const packages = new Set<string>();
  let visited = 0;
  const visit = async (path: string, depth: number, marketplaceEntry?: Record<string, unknown>, marketplaceSource?: { path: string; marketplace: string }) => {
    if (depth > 8 || visited++ > 2000 || packages.size >= 100 || packages.has(path) && !marketplaceEntry) return;
    const info = await lstat(path).catch(() => null);
    if (info?.isSymbolicLink()) {
      // Resolve a linked installation as its own source root; package-internal
      // links remain forbidden by the existing archive and folder loader.
      const canonical = await realpath(path).catch(() => null);
      if (canonical && marketplaceSource) {
        const catalogRoot = marketplaceSource.marketplace.replace(/\\/g, "/").replace(/(?:\.agents\/plugins|\.claude-plugin)\/marketplace\.json$/, "");
        const root = await realpath(catalogRoot).catch(() => null);
        const selected = root ? relative(root, canonical) : "..";
        if (selected.split(/[\\/]/)[0] === ".." || isAbsolute(selected)) return;
      }
      if (canonical && canonical !== path) await visit(canonical, depth + 1, marketplaceEntry, marketplaceSource);
      return;
    }
    if (!info?.isDirectory()) return;
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    for (const catalog of [".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json"]) {
      const info = await lstat(join(path, catalog)).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) continue;
      try { for (const source of localMarketplaceEntries(JSON.parse(await readFile(join(path, catalog), "utf8")))) if (resolve(path, source.path) !== path) await visit(resolve(path, source.path), depth + 1, source.entry, { path: resolve(path, source.path), marketplace: join(path, catalog) }); } catch { /* A broken catalog does not hide other installations. */ }
    }
    const manifestPaths = [provider === "chatgpt" ? ".codex-plugin/plugin.json" : ".claude-plugin/plugin.json", "plugin.json", ...(marketplaceEntry ? [""] : [])];
    for (const manifest of manifestPaths) {
      const manifestInfo = await lstat(join(path, manifest)).catch(() => null);
      if (manifest && (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 1024 * 1024)) continue;
      try {
        const value: unknown = manifest ? JSON.parse(await readFile(join(path, manifest), "utf8")) : marketplaceEntry;
        if (record(value) && str(value.name)) {
          const presentation = record(value.interface) ? value.interface : {};
          results.set(path, { path, name: str(value.name) ?? basename(path), version: str(value.version), displayName: str(presentation.displayName) ?? undefined, description: str(presentation.shortDescription) ?? str(value.description), kind: "plugin" });
          packages.add(path);
          try {
            const files = await discoveryPackageFiles(path, provider, marketplaceEntry);
            const { base, manifest: metadata, portable } = packageManifest(files, provider, [], marketplaceEntry);
            const ui = record(metadata.interface) ? metadata.interface : {};
            const plugin = { name: str(base.name) ?? basename(path), displayName: str(ui.displayName) ?? str(metadata.displayName) ?? undefined };
            const version = str(metadata.version);
            results.set(path, { ...plugin, path, ...marketplaceSource, version, description: str(ui.shortDescription) ?? str(base.description) ?? str(metadata.description), kind: "plugin" });
            const { preview } = planPluginFiles(files, "", { provider, scope: "project", path, marketplaceEntry }, workspaceRoot);
            if (!preview.components.length || preview.requirements?.some(item => item.required && item.status === "blocked" && item.kind !== "dependency")) results.delete(path);
            const { servers } = packageConnectors(files, metadata, portable, []);
            for (const [name, definition] of Object.entries(servers)) {
              if (name === "$schema" || !record(definition)) continue;
              if (preview.connectors?.some(item => item.name === name && item.status === "blocked")) continue;
              results.set(JSON.stringify([path, name]), { path, ...marketplaceSource, name, version, kind: "connector", connector: { name, pluginRoot: "" }, bundledIn: plugin });
            }
          } catch { results.delete(path); /* Invalid packages cannot produce an installable review. Other sources remain available. */ }
          return;
        }
      } catch { /* Other valid installations remain discoverable. */ }
    }
    if (entries.some(entry => entry.name === "SKILL.md" && entry.isFile())) {
      let description: string | null = null;
      try { const info = await lstat(join(path, "SKILL.md")); if (info.size <= 1024 * 1024) description = str(parseFrontmatter(await readFile(join(path, "SKILL.md"), "utf8")).data.description); } catch { /* Metadata is optional; the preview validates the full skill. */ }
      packages.add(path);
      results.set(path, { path, name: basename(path), version: null, description, kind: "skill" }); return;
    }
    for (const entry of entries) if ((entry.isDirectory() || entry.isSymbolicLink()) && ![".git", "node_modules", ".claude-plugin", ".codex-plugin", ".trash", "trash", ".legalwork-import-backups"].includes(entry.name)) await visit(join(path, entry.name), depth + 1);
  };
  for (const root of roots) await visit(root, 0);
  if (provider === "chatgpt") {
    // Source paths are relative to the marketplace's home/repository root,
    // not to .agents/plugins (OpenAI's local marketplace path rules).
    for (const base of [home, workspaceRoot]) {
      const marketplacePath = join(base, ".agents", "plugins", "marketplace.json");
      const info = await lstat(marketplacePath).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) continue;
      try {
        const marketplace: unknown = JSON.parse(await readFile(marketplacePath, "utf8"));
        for (const source of localMarketplaceEntries(marketplace)) await visit(resolve(base, source.path), 0, source.entry, { path: resolve(base, source.path), marketplace: marketplacePath });
      } catch { /* One broken authoring marketplace does not hide other plugins. */ }
    }
  }
  // Claude's install registry also covers packages installed outside its cache.
  if (provider === "claude") {
    try {
      const info = await lstat(join(claude, "plugins", "installed_plugins.json"));
      if (info.isFile() && !info.isSymbolicLink() && info.size < 1024 * 1024) {
        const registry: unknown = JSON.parse(await readFile(join(claude, "plugins", "installed_plugins.json"), "utf8"));
        if (record(registry) && record(registry.plugins)) for (const entries of Object.values(registry.plugins)) if (Array.isArray(entries)) for (const entry of entries) if (record(entry) && str(entry.installPath)) await visit(String(entry.installPath), 0);
      }
    } catch { /* Registry is optional. */ }
  }
  const installationState = await sourceInstallationStates(provider, workspaceRoot, codex, claude);
  return [...results.values(), ...await discoverConnectorImports(provider, workspaceRoot, home, codex, claude)].map(installationState).sort((a, b) => a.name.localeCompare(b.name));
}

/** Reuse the planner with bounded metadata/documents, without reading executable or binary assets. */
async function discoveryPackageFiles(root: string, provider: PluginImportProvider, marketplaceEntry?: Record<string, unknown>): Promise<PackageFiles> {
  const files: PackageFiles = new Map();
  let bytes = 0;
  let metadataBytes = 0;
  let metadataFiles = 0;
  const load = async (value: string) => {
    const path = safePath(value);
    if (files.has(path)) return;
    let absolute = root;
    const parts = path.split("/");
    for (const [index, part] of parts.entries()) {
      absolute = join(absolute, part);
      const info = await lstat(absolute).catch(() => null);
      if (!info) return;
      if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) fail("Plugin metadata must use ordinary files and folders.");
      if (index === parts.length - 1) {
        bytes += info.size;
        if (path.endsWith(".md")) {
          if (bytes > MAX_BYTES || files.size >= MAX_FILES) fail("Plugin discovery documents are too large.");
        } else {
          metadataBytes += info.size;
          if (info.size > 1024 * 1024 || metadataBytes > 4 * 1024 * 1024 || metadataFiles++ >= 64) fail("Plugin discovery metadata is too large.");
        }
        const content = await readFile(absolute);
        if (content.length !== info.size) fail("Plugin changed during discovery. Scan again.");
        files.set(path, { path, bytes: content, mode: info.mode & 0o777 });
      }
    }
  };
  for (const path of ["plugin.json", provider === "chatgpt" ? ".codex-plugin/plugin.json" : ".claude-plugin/plugin.json", ".mcp.json", "mcp.json", ".app.json"]) await load(path);
  const { manifest } = packageManifest(files, provider, [], marketplaceEntry);
  const loadReferences = async (value: unknown): Promise<void> => {
    if (typeof value === "string" && !/\.(mcpb|dxt)$|^https?:/i.test(value)) await load(value);
    else if (Array.isArray(value)) for (const entry of value) await loadReferences(entry);
  };
  await loadReferences(manifest.mcpServers);
  await loadReferences(manifest.apps);
  let visited = 0;
  const documents = async (directory: string, prefix = "", depth = 0): Promise<void> => {
    if (depth > 24 || visited++ > MAX_FILES) fail("Plugin discovery documents are too large.");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if ([".git", "node_modules", ".DS_Store"].includes(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await documents(join(directory, entry.name), relative, depth + 1);
      else if (entry.name.endsWith(".md")) await load(relative);
    }
  };
  await documents(root);
  return files;
}

/** Serialize package mutations, including removal, so update rollback is safe. */
let mutationQueue: Promise<unknown> = Promise.resolve();
export function withPluginImportLock<T>(action: () => Promise<T>): Promise<T> {
  const pending = mutationQueue.then(action, action);
  mutationQueue = pending.catch(() => undefined);
  return pending;
}
