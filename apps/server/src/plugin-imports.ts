import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { unzipSync } from "fflate";
import { z } from "zod";
import type { PluginImportCandidate, PluginImportPreview, PluginImportProvider, PluginImportRequest } from "@legalwork/types/plugin-import";
import { ApiError } from "./errors.js";
import { buildFrontmatter, parseFrontmatter } from "./frontmatter.js";
import { pluginNamespace, resolveWorkspaceInstallPath, type CloudPluginResolved } from "./cloud-plugins.js";

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 5000;
const sourceSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("chatgpt"), path: z.string().min(1).optional(), zipBase64: z.string().max(90 * 1024 * 1024).optional() }),
  z.object({ provider: z.literal("claude"), path: z.string().min(1).optional(), zipBase64: z.string().max(90 * 1024 * 1024).optional() }),
]);
const requestSchema = z.object({ source: sourceSchema, root: z.string().optional(), scope: z.enum(["global", "project"]), digest: z.string().optional() });
export function parsePluginImportRequest(value: unknown): PluginImportRequest {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, "invalid_plugin_import", "Choose a plugin folder or ZIP and installation scope.");
  const source = parsed.data.source;
  if (Boolean(source.path) === Boolean(source.zipBase64)) throw new ApiError(400, "invalid_plugin_import", "Provide exactly one folder path or ZIP.");
  return { ...parsed.data, source: source.path ? { provider: source.provider, path: source.path } : { provider: source.provider, zipBase64: source.zipBase64 ?? "" } };
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
type PackageFile = { path: string; bytes: Uint8Array; mode: number };
type PackageFiles = Map<string, PackageFile>;
export type PluginImportPlan = { preview: PluginImportPreview; resolved: CloudPluginResolved; resourceFiles: PackageFile[] };

async function readFolder(root: string): Promise<PackageFiles> {
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
  if ("path" in request.source) {
    const path = resolve(request.source.path);
    if (/\.zip$/i.test(path)) {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) fail("Choose an ordinary ZIP smaller than 64 MB.");
      return readZip(await readFile(path));
    }
    return readFolder(path);
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
function packageRoots(files: PackageFiles, provider: PluginImportProvider): string[] {
  const suffix = provider === "chatgpt" ? ".codex-plugin/plugin.json" : ".claude-plugin/plugin.json";
  const roots = new Set<string>();
  for (const path of files.keys()) {
    if (path === suffix || path.endsWith(`/${suffix}`)) roots.add(path.slice(0, -suffix.length).replace(/\/$/, ""));
    if ((path === "plugin.json" || path.endsWith("/plugin.json")) && !path.includes(".claude-plugin/") && !path.includes(".codex-plugin/")) {
      const manifest = jsonFile(files, path);
      if (str(manifest.name)) roots.add(path.slice(0, -"plugin.json".length).replace(/\/$/, ""));
    }
  }
  if (roots.size) return [...roots].sort();
  const otherManifest = provider === "chatgpt" ? ".claude-plugin/plugin.json" : ".codex-plugin/plugin.json";
  if ([...files.keys()].some(path => path === otherManifest || path.endsWith(`/${otherManifest}`))) fail(`This package uses the ${provider === "chatgpt" ? "Claude" : "ChatGPT"} format. Choose the matching import button.`);
  // Plain skill folders, collections and manifest-free Claude plugins.
  if (files.has("SKILL.md") || [...files.keys()].some(path => /^(skills\/.*\/SKILL\.md|commands\/.*\.md|agents\/.*\.md)$/.test(path))) return [""];
  const skillRoots = [...files.keys()].filter(path => path.endsWith("/SKILL.md")).map(path => dirname(path).replace(/\\/g, "/"));
  if (!skillRoots.length) return [];
  const first = [...files.keys()][0]?.split("/")[0];
  return first && [...files.keys()].every(path => path.startsWith(`${first}/`)) ? [first] : [""];
}
function subFiles(files: PackageFiles, root: string): PackageFiles {
  if (!root) return files;
  const prefix = `${safePath(root)}/`;
  return new Map([...files.values()].filter(file => file.path.startsWith(prefix)).map(file => { const path = file.path.slice(prefix.length); return [path, { ...file, path }]; }));
}
function expandRoot(value: unknown, root: string): unknown {
  if (typeof value === "string") return value.replace(/\$\{(?:(?:CLAUDE|CODEX)_PLUGIN_ROOT|PLUGIN_ROOT)\}/g, root).replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}]+)\}/g, (_, fallback: string) => fallback);
  if (Array.isArray(value)) return value.map(entry => expandRoot(entry, root));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expandRoot(entry, root)]));
  return value;
}
function paths(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every(entry => typeof entry === "string")) return value;
  return fail("Component paths must be a path string or an array of paths.");
}

function planPackage(files: PackageFiles, root: string, request: PluginImportRequest, workspaceRoot: string): PluginImportPlan {
  const portable = files.has("plugin.json");
  const legacyPath = request.source.provider === "chatgpt" ? ".codex-plugin/plugin.json" : ".claude-plugin/plugin.json";
  const base = portable ? jsonFile(files, "plugin.json") : files.has(legacyPath) ? jsonFile(files, legacyPath) : {};
  const openai = record(base.extensions) && record(base.extensions["com.openai"]) ? base.extensions["com.openai"] : null;
  // OpenAI's portable extension replaces the legacy overlay, rather than merging it.
  const overlay = portable && request.source.provider === "chatgpt" && !openai && files.has(legacyPath) ? jsonFile(files, legacyPath) : openai;
  const manifest: Record<string, unknown> = { ...base, ...overlay, ...(portable ? { name: base.name, description: base.description, version: base.version } : {}) };
  const name = str(base.name) ?? str(manifest.name) ?? (files.has("SKILL.md") ? str(parseFrontmatter(textFile(files, "SKILL.md")).data.name) : null) ?? basename(root || ("path" in request.source ? request.source.path : "imported-plugin"));
  const description = str(base.description) ?? str(manifest.description);
  const id = `import:${request.source.provider}:${name}:${request.scope}`;
  const namespace = pluginNamespace(name, id);
  const bundlePath = `.opencode/imported-plugins/${namespace}`;
  const absoluteBundle = resolveWorkspaceInstallPath(workspaceRoot, bundlePath, request.scope === "global");
  const warnings: string[] = ["All source files are preserved. Generated node_modules and .git folders are excluded; install dependencies separately if needed."];
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
      warnings.push(`${type} ${originalName}: a duplicate component name was disambiguated. Use the component mapping in the imported instructions.`);
    }
    const key = `${type}:${installedName}`;
    seen.add(key);
    const target = type === "skill" ? `.opencode/skills/${namespace}/${installedName}/SKILL.md` : `.opencode/${type === "agent" ? "agents" : "commands"}/${namespace}/${installedName}.md`;
    let body = parsed.body.replace(/\$\{(?:(?:CLAUDE|CODEX)_PLUGIN_ROOT|PLUGIN_ROOT)\}/g, absoluteBundle)
      .replace(/\$\{CLAUDE_SKILL_DIR\}/g, join(absoluteBundle, dirname(sourcePath)))
      .replace(/\$\{CLAUDE_PROJECT_DIR\}/g, workspaceRoot);
    if (/\$\{CLAUDE_(SESSION_ID|EFFORT|PLUGIN_DATA)\}|!`/.test(body)) warnings.push(`${type} ${originalName}: runtime variables or dynamic command injection require adapting to LegalWork; no injected command runs during import.`);
    // Links and code paths retain a usable location even when outside a skill's folder.
    body = body.replace(/\]\((\.\.?\/[^)]+)\)/g, (_, relative: string) => `](${join(absoluteBundle, dirname(sourcePath), relative).replace(/\\/g, "/")})`);
    body += `\n\nImported package resources: ${absoluteBundle.replace(/\\/g, "/")}. Resolve package-relative paths there.\n`;
    if (components.some(entry => entry.type === "mcp")) body += "\nImported connector names are listed in the package's LegalWork import report.\n";
    if (str(parsed.data.model) && !str(parsed.data.model)?.includes("/")) warnings.push(`${type} ${originalName}: choose a LegalWork model; provider aliases such as sonnet/opus cannot be mapped automatically.`);
    if (parsed.data["allowed-tools"] || parsed.data["disable-model-invocation"] || parsed.data.context || parsed.data.hooks || parsed.data.permissionMode || parsed.data.skills || parsed.data.mcpServers) warnings.push(`${type} ${originalName}: platform-specific execution or permission metadata is preserved in the source; review it in LegalWork before use.`);
    const content = buildFrontmatter({ ...parsed.data, name: installedName }) + "\n" + body;
    memberships.push({ configObjectId: key, configObject: { id: key, objectType: type, title: installedName, description: str(parsed.data.description) ?? originalName, currentRelativePath: target, status: "active", updatedAt: null, latestVersion: { id: createHash("sha256").update(raw).digest("hex"), rawSourceText: content, normalizedPayloadJson: null } } });
    components.push({ type, name: originalName, installedName });
    if (type === "skill" && inline === undefined) {
      const directory = posix.dirname(sourcePath);
      const prefix = directory === "." ? "" : `${directory}/`;
      const nestedSkills = [...files.keys()].filter(path => path !== sourcePath && /(^|\/)SKILL\.md$/.test(path) && path.startsWith(prefix)).map(path => `${posix.dirname(path)}/`);
      for (const file of files.values()) {
        if (nestedSkills.some(nested => file.path.startsWith(nested))) continue;
        if (/(^|\/)SKILL\.md$/.test(file.path) || !file.path.startsWith(prefix)) continue;
        resourceFiles.push({ ...file, path: `${posix.dirname(target)}/${file.path.slice(prefix.length)}` });
      }
    }
  };
  const selectDocuments = (value: unknown, defaults: string[], type: "skill" | "agent" | "command") => {
    const roots = [...new Set([...defaults, ...paths(value)])];
    for (const path of roots) {
      const selected = path === "." || path === "./" ? "" : safePath(path);
      if (files.has(selected) && selected.endsWith(".md")) { addDocument(type, selected); continue; }
      const matches = [...files.keys()].filter(entry => (!selected || entry.startsWith(`${selected}/`)) && (type === "skill" ? /(^|\/)SKILL\.md$/.test(entry) : entry.endsWith(".md")));
      if (!matches.length && !defaults.includes(path)) fail(`No ${type} files found at ${path}`);
      for (const entry of matches) addDocument(type, entry);
    }
  };
  selectDocuments(manifest.skills, files.has("SKILL.md") || (!portable && !files.has(legacyPath) && ![...files.keys()].some(path => path.startsWith("skills/"))) ? ["."] : ["skills"], "skill");
  selectDocuments(manifest.agents, manifest.agents ? [] : ["agents"], "agent");
  if (record(manifest.commands)) {
    for (const [commandName, definition] of Object.entries(manifest.commands)) {
      if (!record(definition)) fail(`Invalid command definition: ${commandName}`);
      const source = str(definition.source);
      const content = str(definition.content);
      if (source) addDocument("command", safePath(source), undefined, commandName, definition);
      else if (content) addDocument("command", `commands/${slug(commandName)}.md`, buildFrontmatter({ description: definition.description, model: definition.model }) + "\n" + content, commandName);
      else fail(`Command ${commandName} needs source or content.`);
    }
  } else selectDocuments(manifest.commands, manifest.commands ? [] : ["commands"], "command");

  const servers: Record<string, unknown> = {};
  const mergeMcp = (value: unknown) => {
    if (typeof value === "string") {
      if (/\.(mcpb|dxt)$|^https?:/i.test(value)) { warnings.push(`MCP bundle ${value} is preserved but requires manual setup.`); return; }
      const path = safePath(value);
      mergeMcp(jsonFile(files, path));
    } else if (Array.isArray(value)) value.forEach(mergeMcp);
    else if (record(value)) Object.assign(servers, record(value.mcpServers) ? value.mcpServers : value);
    else if (value !== undefined) fail("Invalid MCP configuration.");
  };
  const defaultMcp = portable ? "mcp.json" : ".mcp.json";
  if (files.has(defaultMcp)) mergeMcp(defaultMcp);
  if (manifest.mcpServers !== undefined) mergeMcp(manifest.mcpServers);
  const normalizedServers: Record<string, unknown> = {};
  for (const [serverName, original] of Object.entries(servers)) {
    if (serverName === "$schema") continue;
    if (!record(original)) fail(`Invalid MCP server: ${serverName}`);
    const expanded = expandRoot(original, absoluteBundle);
    if (!record(expanded)) fail(`Invalid MCP server: ${serverName}`);
    if (/\$\{[A-Za-z_][A-Za-z0-9_]*:-/.test(JSON.stringify(original))) warnings.push(`Connector ${serverName}: environment defaults use their declared fallback; review locally configured values before connecting.`);
    const normalized: Record<string, unknown> = { ...expanded };
    if (Array.isArray(normalized.args)) normalized.args = normalized.args.map(argument => typeof argument === "string" && files.has(argument.replace(/^\.\//, "")) ? join(absoluteBundle, argument.replace(/^\.\//, "")) : argument);
    if (typeof normalized.command === "string" && !normalized.url) normalized.env = { ...(record(normalized.env) ? normalized.env : {}), CLAUDE_PLUGIN_ROOT: absoluteBundle, CODEX_PLUGIN_ROOT: absoluteBundle, PLUGIN_ROOT: absoluteBundle };
    if (normalized.headersHelper || normalized.transport || normalized.timeout || normalized.oauth && request.source.provider === "claude") warnings.push(`Connector ${serverName}: review transport, authentication and helper settings in LegalWork; the original configuration is preserved.`);
    if (typeof normalized.command === "string" && /^\.\//.test(normalized.command)) normalized.command = join(absoluteBundle, safePath(normalized.command));
    const auth = record(normalized.extensions) && record(normalized.extensions["com.openai"]) && record(normalized.extensions["com.openai"].auth) ? normalized.extensions["com.openai"].auth : null;
    if (auth?.type === "none") normalized.oauth = false;
    else if (auth?.type === "oauth" || auth?.type === "mixed") {
      const client = record(auth.client) ? auth.client : {};
      normalized.oauth = { ...(str(client.clientId) ? { clientId: client.clientId } : {}), ...(Array.isArray(auth.baseScopes) ? { scope: auth.baseScopes.filter(scope => typeof scope === "string").join(" ") } : {}) };
      if (auth.authorizationUrl || auth.tokenUrl || (client.tokenEndpointAuthMethod && client.tokenEndpointAuthMethod !== "none")) { normalized.enabled = false; warnings.push(`Connector ${serverName}: OAuth endpoint overrides or confidential client registration need manual configuration before connecting.`); }
      warnings.push(`Connector ${serverName}: sign in again in LegalWork. Provider-managed app connections and tokens are not portable.`);
    }
    const unresolved = JSON.stringify(normalized).match(/\$\{(?!CLAUDE_PLUGIN_ROOT|CODEX_PLUGIN_ROOT)[^}]+\}/g);
    if (unresolved || normalized.cwd || auth?.type === "api_key" || normalized.userConfig) {
      normalized.enabled = false;
      warnings.push(`Connector ${serverName} is imported disabled: configure its environment, working directory or credentials in LegalWork before connecting.`);
    }
    if (typeof normalized.url === "string" && (!normalized.url.trim() || /\$\{|[{}]/.test(normalized.url))) {
      normalized.url = "https://configure-before-connecting.invalid/mcp";
      normalized.enabled = false;
      warnings.push(`Connector ${serverName}: its URL needs configuration. The connector is disabled and the original URL is preserved in the source package.`);
    }
    if (normalized.headersHelper) normalized.enabled = false;
    if (Array.isArray(normalized.command) && (!normalized.command.length || normalized.command.some(part => typeof part !== "string") || !str(normalized.command[0]))) fail(`Invalid command array for connector ${serverName}`);
    if (normalized.args && (!Array.isArray(normalized.args) || normalized.args.some(part => typeof part !== "string"))) fail(`Invalid arguments for connector ${serverName}`);
    if (!str(normalized.url) && !(str(normalized.command) || Array.isArray(normalized.command))) fail(`Connector ${serverName} requires a URL or command.`);
    const installedName = `${namespace}-${request.scope === "global" ? "global" : createHash("sha256").update(resolve(workspaceRoot)).digest("hex").slice(0, 8)}-${slug(serverName)}-${createHash("sha256").update(serverName).digest("hex").slice(0, 6)}`;
    normalizedServers[installedName] = normalized;
    components.push({ type: "mcp", name: serverName, installedName });
  }
  if (Object.keys(normalizedServers).length) memberships.push({ configObjectId: `${id}/mcp`, configObject: { id: `${id}/mcp`, objectType: "mcp", title: name, description: null, currentRelativePath: null, status: "active", updatedAt: null, latestVersion: { id: "mcp", rawSourceText: null, normalizedPayloadJson: { mcpServers: normalizedServers } } } });
  if (resourceFiles.length > 10000 || resourceFiles.reduce((total, file) => total + file.bytes.length, 0) > 128 * 1024 * 1024) fail("Installed package resources exceed 128 MB or 10,000 files. Import a smaller plugin folder.");
  const unsupported = ["hooks", "lspServers", "outputStyles", "settings", "workflows", "dependencies", "userConfig", "themes", "monitors", "evals"];
  for (const field of unsupported) if (manifest[field] || (field === "hooks" && files.has("hooks/hooks.json")) || (field === "lspServers" && files.has(".lsp.json")) || [...files.keys()].some(path => path.startsWith(`${field}/`))) warnings.push(`${field}: original files/configuration are preserved, but this platform-specific feature is not activated by LegalWork.`);
  if (manifest.experimental) warnings.push("Experimental Claude components are preserved but are not activated by LegalWork.");
  if (manifest.onboardingSkill) warnings.push("The onboarding skill is imported; invoke it manually after installing.");
  if (manifest.apps || files.has(".app.json")) warnings.push("ChatGPT app connections are preserved in the source. Reconnect each app using LegalWork connectors; provider app IDs cannot be imported as credentials.");
  if (components.length === 0) warnings.push("This package has no supported skills, agents, commands or MCP servers. Only its complete source will be stored.");
  const hash = createHash("sha256").update(JSON.stringify({ provider: request.source.provider, root, scope: request.scope, workspaceRoot: resolve(workspaceRoot) }));
  for (const file of [...files.values()].sort((a, b) => a.path.localeCompare(b.path))) hash.update(file.path).update(String(file.mode)).update(file.bytes);
  const preview: PluginImportPreview = { id, digest: hash.digest("hex"), name, description, version: str(manifest.version), format: portable ? "portable" : files.has(legacyPath) ? request.source.provider === "chatgpt" ? "codex" : "claude" : "skills", root, fileCount: files.size, bytes: [...files.values()].reduce((sum, file) => sum + file.bytes.length, 0), components, warnings: [...new Set(warnings)] };
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
  return { preview, resolved: { plugin: { id, name, description, updatedAt: null }, memberships }, resourceFiles };
}
export async function resolvePluginImports(request: PluginImportRequest, workspaceRoot: string): Promise<PluginImportPlan[]> {
  const files = await loadSource(request);
  const roots = packageRoots(files, request.source.provider);
  if (!roots.length) fail("No plugin manifest or SKILL.md found. Choose a plugin folder, skills folder, or their ZIP export.");
  if (request.root !== undefined && !roots.includes(request.root)) fail("Selected plugin root was not found.");
  return roots.filter(root => request.root === undefined || root === request.root).map(root => planPackage(subFiles(files, root), root, request, workspaceRoot));
}

export async function discoverPluginImports(provider: PluginImportProvider, workspaceRoot: string): Promise<PluginImportCandidate[]> {
  const home = homedir();
  const codex = process.env.CODEX_HOME?.trim() || join(home, ".codex");
  const claude = process.env.CLAUDE_CONFIG_DIR?.trim() || join(home, ".claude");
  const roots = provider === "chatgpt" ? [join(codex, "plugins"), join(home, ".agents", "plugins"), join(home, ".agents", "skills"), join(workspaceRoot, ".agents", "skills"), join(workspaceRoot, ".agents", "plugins")] : [join(claude, "plugins"), join(claude, "skills"), join(workspaceRoot, ".claude", "skills"), join(workspaceRoot, ".claude", "plugins")];
  const results = new Map<string, PluginImportCandidate>();
  let visited = 0;
  const visit = async (path: string, depth: number) => {
    if (depth > 8 || visited++ > 2000 || results.size >= 100) return;
    const info = await lstat(path).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) return;
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    const manifestPaths = [provider === "chatgpt" ? ".codex-plugin/plugin.json" : ".claude-plugin/plugin.json", "plugin.json"];
    for (const manifest of manifestPaths) {
      const manifestInfo = await lstat(join(path, manifest)).catch(() => null);
      if (!manifestInfo?.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 1024 * 1024) continue;
      try {
        const value: unknown = JSON.parse(await readFile(join(path, manifest), "utf8"));
        if (record(value) && str(value.name)) { results.set(path, { path, name: str(value.name) ?? basename(path), version: str(value.version) }); return; }
      } catch { /* Other valid installations remain discoverable. */ }
    }
    if (entries.some(entry => entry.name === "SKILL.md" && entry.isFile())) { results.set(path, { path, name: basename(path), version: null }); return; }
    for (const entry of entries) if (entry.isDirectory() && ![".git", "node_modules", ".claude-plugin", ".codex-plugin"].includes(entry.name)) await visit(join(path, entry.name), depth + 1);
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
        if (record(marketplace) && Array.isArray(marketplace.plugins)) for (const entry of marketplace.plugins) {
          if (!record(entry) || !record(entry.source) || !str(entry.source.path)) continue;
          await visit(resolve(base, String(entry.source.path)), 0);
        }
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
  return [...results.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Serialize package mutations, including removal, so update rollback is safe. */
let mutationQueue: Promise<unknown> = Promise.resolve();
export function withPluginImportLock<T>(action: () => Promise<T>): Promise<T> {
  const pending = mutationQueue.then(action, action);
  mutationQueue = pending.catch(() => undefined);
  return pending;
}
