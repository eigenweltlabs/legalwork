import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ApiError } from "./errors.js";
import { eigenweltPlatformUrl } from "./eigenwelt-auth.js";
import { sanitizeIntegrationMcp } from "./hub-sanitize.js";
import { resolveSkillDir } from "./skill-resources.js";
import { validateMcpConfig, validateMcpName, validateSkillName } from "./validators.js";
import { globalSkillsDir } from "./workspace-files.js";

/**
 * Client for the Eigenwelt platform "Firm Hub" — an org-shared library of
 * workflows (skill folders), integrations (one MCP server entry) and presets
 * (settings fragments). Every call carries `Authorization: Bearer <token>`
 * where the token is the per-firm platformToken minted at sign-in.
 *
 * Serialization is path-safe by construction: sharing walks a skill's own
 * folder and installing rejects absolute paths and `..` traversal before ANY
 * write, so a malicious/corrupt hub item can never escape the workspace skills
 * dir.
 */

// Team hub categories mirror the app's local surfaces. `integration` and
// `preset` are retained for back-compat (legacy / deferred to a Pro plan).
export type EigenweltHubKind =
  | "skill"
  | "workflow"
  | "mcp"
  | "plugin"
  | "integration"
  | "preset";

export type EigenweltHubItem = {
  id: string;
  kind: EigenweltHubKind;
  name: string;
  description: string;
  createdByUserId: string;
  version: number;
  updatedAt: string;
  /** Platform-pinned items sort first in the hub list (optional; newer platform). */
  pinned?: boolean;
  /** Sharer identity (newer platform join) — for "filter by team member". */
  createdByName?: string | null;
  createdByEmail?: string | null;
  /** Whether an encrypted key is attached and this caller may copy it. */
  hasSecret?: boolean;
  canAccessSecret?: boolean;
};

export type EigenweltHubItemDetail = EigenweltHubItem & { payload: unknown };

/** A single file inside a shared workflow folder. */
export type EigenweltHubFile = { path: string; contentBase64: string };

/** Platform limits mirrored client-side. */
export const EIGENWELT_HUB_MAX_PAYLOAD_BYTES = 20 * 1024 * 1024;
export const EIGENWELT_HUB_MAX_FILES = 2_000;
export const EIGENWELT_HUB_MAX_BATCH_ITEMS = 50;
export const EIGENWELT_HUB_MAX_SECRET_BYTES = 64 * 1024;

const HUB_NAME_REGEX = /^[a-z0-9][a-z0-9-_]*$/i;

export function validateHubName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100 || !HUB_NAME_REGEX.test(trimmed)) {
    throw new ApiError(
      400,
      "invalid_hub_name",
      "Name must start alphanumeric, use only letters, numbers, - or _, and be at most 100 characters.",
    );
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

/**
 * Validate a relative file path from a hub workflow payload. MANDATORY guard on
 * install: rejects absolute paths (POSIX `/…`, Windows `C:\…`, UNC `\\…`),
 * backslashes, empty segments and any `..` traversal. Returns the normalized
 * forward-slash relative path.
 */
export function validateHubFilePath(rawPath: string): string {
  const path = String(rawPath ?? "").trim();
  if (!path) {
    throw new ApiError(400, "invalid_hub_path", "Workflow file path is required.");
  }
  if (path.includes("\0")) {
    throw new ApiError(400, "invalid_hub_path", `Invalid workflow file path: ${path}`);
  }
  // Backslashes (Windows separators / UNC) are never allowed — paths are POSIX.
  if (path.includes("\\")) {
    throw new ApiError(400, "invalid_hub_path", `Workflow file path must use forward slashes: ${path}`);
  }
  // Absolute POSIX or Windows-drive paths escape the skill folder.
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new ApiError(400, "invalid_hub_path", `Workflow file path must be relative: ${path}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ApiError(400, "invalid_hub_path", `Workflow file path may not contain traversal or empty segments: ${path}`);
  }
  return segments.join("/");
}

/** Resolve `child` under `baseDir`, refusing anything that escapes it. */
function resolveSafeChild(baseDir: string, child: string): string {
  const base = resolve(baseDir);
  const target = resolve(baseDir, child);
  if (target !== base && !target.startsWith(base + "/") && !target.startsWith(base + "\\")) {
    throw new ApiError(400, "invalid_hub_path", `Workflow file path escapes the skill folder: ${child}`);
  }
  return target;
}

// ---------------------------------------------------------------------------
// Workflow (skill folder) serialization
// ---------------------------------------------------------------------------

async function walkSkillFiles(root: string, dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // no dotfiles in a shared workflow
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkSkillFiles(root, abs, out);
    } else if (entry.isFile()) {
      out.push(abs.slice(root.length + 1).split("\\").join("/"));
      if (out.length > EIGENWELT_HUB_MAX_FILES) {
        throw new ApiError(413, "too_many_hub_files", `A shared item may contain at most ${EIGENWELT_HUB_MAX_FILES} files.`);
      }
    }
  }
}

/**
 * Serialize a local skill folder (SKILL.md + resources/) to base64 files.
 * Rejects a folder whose JSON payload would exceed 20 MiB.
 */
export async function serializeWorkflowSkill(
  workspaceRoot: string,
  skillName: string,
): Promise<{ files: EigenweltHubFile[] }> {
  const skillDir = await resolveSkillDir(workspaceRoot, skillName);
  const relPaths: string[] = [];
  await walkSkillFiles(skillDir, skillDir, relPaths);
  relPaths.sort((a, b) => a.localeCompare(b));

  if (!relPaths.includes("SKILL.md")) {
    throw new ApiError(400, "invalid_workflow", "A workflow must contain a SKILL.md at its root.");
  }

  const files: EigenweltHubFile[] = [];
  for (const path of relPaths) {
    validateHubFilePath(path);
    const buf = await readFile(join(skillDir, path));
    files.push({ path, contentBase64: buf.toString("base64") });
  }

  const payloadBytes = Buffer.byteLength(JSON.stringify({ files }), "utf8");
  if (payloadBytes > EIGENWELT_HUB_MAX_PAYLOAD_BYTES) {
    throw new ApiError(
      413,
      "workflow_too_large",
      `This workflow is too large to share (${Math.round(payloadBytes / 1024)} KiB; limit 20 MiB).`,
    );
  }

  return { files };
}

/**
 * Write a shared workflow's files into the workspace skills dir under
 * `<skills>/<skillName>/`. Every path is validated (no absolute, no `..`) and
 * re-checked against the skill folder before writing.
 */
export async function installWorkflowFiles(
  workspaceRoot: string,
  skillName: string,
  files: unknown,
): Promise<{ name: string; path: string; written: number }> {
  const name = skillName.trim();
  validateSkillName(name);
  if (!Array.isArray(files) || files.length === 0 || files.length > EIGENWELT_HUB_MAX_FILES) {
    throw new ApiError(400, "invalid_workflow", "The shared workflow has no files.");
  }

  const normalized = normalizeHubFiles(files, "invalid_workflow");

  if (!normalized.some((file) => file.path === "SKILL.md")) {
    throw new ApiError(400, "invalid_workflow", "The shared workflow is missing its SKILL.md.");
  }

  // Install into the GLOBAL skills dir the desktop app reads from (skills are
  // global there and auto-sync into projects); fall back to the workspace's
  // project dir for remote workspaces that don't have the global one.
  const baseDir = join(globalSkillsDir(), name);
  await writeHubFiles(baseDir, normalized);
  return { name, path: baseDir, written: normalized.length };
}

function normalizeHubFiles(
  files: unknown[],
  errorCode: "invalid_workflow" | "invalid_bundle",
): EigenweltHubFile[] {
  const seen = new Set<string>();
  let encodedBytes = 0;
  return files.map((file) => {
    if (!file || typeof file !== "object") {
      throw new ApiError(400, errorCode, "Each shared file must be an object.");
    }
    const record = file as Record<string, unknown>;
    const relPath = validateHubFilePath(typeof record.path === "string" ? record.path : "");
    if (typeof record.contentBase64 !== "string") {
      throw new ApiError(400, errorCode, `Missing file content: ${relPath}`);
    }
    if (seen.has(relPath)) throw new ApiError(400, errorCode, `Duplicate file path: ${relPath}`);
    seen.add(relPath);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.contentBase64)) {
      throw new ApiError(400, errorCode, `Invalid base64 content: ${relPath}`);
    }
    encodedBytes += Buffer.byteLength(record.contentBase64, "ascii");
    if (encodedBytes > EIGENWELT_HUB_MAX_PAYLOAD_BYTES) {
      throw new ApiError(413, "hub_payload_too_large", "Shared file content exceeds 20 MiB.");
    }
    return { path: relPath, contentBase64: record.contentBase64 };
  });
}

async function writeHubFiles(baseDir: string, files: EigenweltHubFile[]): Promise<void> {
  await mkdir(baseDir, { recursive: true });
  if ((await lstat(baseDir)).isSymbolicLink()) {
    throw new ApiError(400, "invalid_hub_path", "Refusing to install through a symlinked destination.");
  }
  const trustedBase = await realpath(baseDir);
  const destinations: Array<{ dest: string; file: EigenweltHubFile }> = [];
  for (const file of files) {
    const dest = resolveSafeChild(baseDir, file.path);
    let parent = baseDir;
    const parentSegments = dirname(file.path).split("/").filter((segment) => segment !== ".");
    for (const segment of parentSegments) {
      parent = join(parent, segment);
      try {
        const entry = await lstat(parent);
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          throw new ApiError(400, "invalid_hub_path", `Unsafe shared file parent: ${file.path}`);
        }
      } catch (error) {
        if (error instanceof ApiError) throw error;
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
        // Create one segment at a time only after its parent was verified. A
        // recursive mkdir could follow an existing nested symlink first.
        await mkdir(parent);
      }
      const trustedParent = await realpath(parent);
      if (trustedParent !== trustedBase && !trustedParent.startsWith(trustedBase + "/") && !trustedParent.startsWith(trustedBase + "\\")) {
        throw new ApiError(400, "invalid_hub_path", `Shared file parent escapes through a symlink: ${file.path}`);
      }
    }
    try {
      if ((await lstat(dest)).isSymbolicLink()) {
        throw new ApiError(400, "invalid_hub_path", `Refusing to overwrite a symlink: ${file.path}`);
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    destinations.push({ dest, file });
  }
  // All paths are preflighted before the first content write, avoiding a
  // partial install when a later path is unsafe.
  for (const { dest, file } of destinations) {
    await writeFile(dest, Buffer.from(file.contentBase64, "base64"));
  }
}

// ---------------------------------------------------------------------------
// Generic local-folder bundle (skills, workflows, dir plugins) — nested folders
// preserved via relative paths; no SKILL.md requirement (that's workflow-only).
// ---------------------------------------------------------------------------

/** Serialize any local folder to a base64 file bundle (recursive; skips dotfiles). */
export async function serializeLocalFolder(rootDir: string): Promise<{ files: EigenweltHubFile[] }> {
  const relPaths: string[] = [];
  await walkSkillFiles(rootDir, rootDir, relPaths);
  relPaths.sort((a, b) => a.localeCompare(b));
  if (relPaths.length === 0) {
    throw new ApiError(400, "invalid_bundle", "This folder has no shareable files.");
  }
  const files: EigenweltHubFile[] = [];
  for (const path of relPaths) {
    validateHubFilePath(path);
    const buf = await readFile(join(rootDir, path));
    files.push({ path, contentBase64: buf.toString("base64") });
  }
  const payloadBytes = Buffer.byteLength(JSON.stringify({ files }), "utf8");
  if (payloadBytes > EIGENWELT_HUB_MAX_PAYLOAD_BYTES) {
    throw new ApiError(413, "bundle_too_large", `Too large to share (${Math.round(payloadBytes / 1024)} KiB; limit 20 MiB).`);
  }
  return { files };
}

/** Write a shared file bundle under `baseDir`, path-validated (no `..`/absolute). */
export async function installFolderFiles(
  baseDir: string,
  files: unknown,
): Promise<{ path: string; written: number }> {
  if (!Array.isArray(files) || files.length === 0 || files.length > EIGENWELT_HUB_MAX_FILES) {
    throw new ApiError(400, "invalid_bundle", "The shared item has no files.");
  }
  const normalized = normalizeHubFiles(files, "invalid_bundle");
  await writeHubFiles(baseDir, normalized);
  return { path: baseDir, written: normalized.length };
}

// ---------------------------------------------------------------------------
// Plugin payloads: a config spec (url/npm) OR a local file/folder bundle.
// ---------------------------------------------------------------------------

export type EigenweltPluginPayload = { spec: string } | { files: EigenweltHubFile[] };

export function parsePluginPayload(payload: unknown): EigenweltPluginPayload {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.spec === "string" && record.spec.trim()) {
      const spec = record.spec.trim();
      if (/^(?:file:|\/|[A-Za-z]:[\\/]|http:)/i.test(spec)) {
        throw new ApiError(400, "invalid_plugin", "Shared plugin specs may not reference local files or insecure HTTP URLs.");
      }
      return { spec };
    }
    if (Array.isArray(record.files)) return { files: record.files as EigenweltHubFile[] };
  }
  throw new ApiError(400, "invalid_plugin", "The shared plugin has no spec or files.");
}

// ---------------------------------------------------------------------------
// Integration (single MCP server entry) payloads
// ---------------------------------------------------------------------------

export type EigenweltIntegrationPayload = { mcp: Record<string, unknown>; key: string };

/**
 * Build an integration payload from a workspace MCP entry. The MCP config is a
 * SHARE TEMPLATE, so every credential (api keys, tokens, auth headers/env) is
 * stripped first — the installer re-supplies their own auth. The platform also
 * rejects payloads with secret-shaped keys, so the strip must be thorough.
 */
export function buildIntegrationPayload(name: string, config: Record<string, unknown>): EigenweltIntegrationPayload {
  const key = name.trim();
  validateMcpName(key);
  const mcp = sanitizeIntegrationMcp(config);
  // Validate the sanitized shape — stripping never removes type/url/command, so
  // a valid entry stays valid (and a secret-only "config" is caught here).
  validateMcpConfig(mcp);
  return { mcp, key };
}

/** Extract + validate the MCP entry from a shared integration payload. */
export function parseIntegrationPayload(payload: unknown): EigenweltIntegrationPayload {
  if (!payload || typeof payload !== "object") {
    throw new ApiError(400, "invalid_integration", "The shared integration has no payload.");
  }
  const record = payload as Record<string, unknown>;
  const key = typeof record.key === "string" ? record.key.trim() : "";
  if (!key) {
    throw new ApiError(400, "invalid_integration", "The shared integration has no server name.");
  }
  validateMcpName(key);
  if (!record.mcp || typeof record.mcp !== "object" || Array.isArray(record.mcp)) {
    throw new ApiError(400, "invalid_integration", "The shared integration is missing its MCP server entry.");
  }
  const mcp = record.mcp as Record<string, unknown>;
  validateMcpConfig(mcp);
  return { mcp, key };
}

// ---------------------------------------------------------------------------
// Platform hub HTTP client
// ---------------------------------------------------------------------------

type HubClient = { platformURL: string; platformToken: string };

/** Build a hub client from a stored connection, or fail with a clear 403. */
export function requireHubClient(connection: {
  platformURL: string | null;
  platformToken: string | null;
}): HubClient {
  // Hub traffic always targets the configured trusted platform. The stored URL
  // is display metadata from OAuth and must never become a server-side fetch
  // destination.
  const platformURL = eigenweltPlatformUrl();
  const platformToken = connection.platformToken ?? "";
  if (!platformURL || !platformToken) {
    throw new ApiError(
      403,
      "hub_not_available",
      "The Firm Hub needs an Eigenwelt subscription. Sign in with Eigenwelt to enable it.",
    );
  }
  return { platformURL, platformToken };
}

async function hubRequest(
  client: HubClient,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${client.platformURL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${client.platformToken}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(502, "hub_unreachable", "Could not reach the Eigenwelt platform hub.");
  }

  const text = await response.text();
  const json: unknown = text ? safeParseJson(text) : null;
  if (!response.ok) {
    const detail = errorMessageFrom(json) || (json === null ? text.trim().slice(0, 500) : "");
    if (response.status === 403) {
      throw new ApiError(403, "hub_forbidden", detail || "Your firm's subscription does not allow this hub action.");
    }
    if (response.status === 413) {
      throw new ApiError(413, "hub_payload_too_large", detail || "The hub item is too large (limit 20 MiB).");
    }
    if (response.status === 404) {
      throw new ApiError(404, "hub_item_not_found", detail || "Hub item not found.");
    }
    if (response.status === 429) {
      throw new ApiError(429, "hub_rate_limited", detail || "Too many hub requests. Please try again shortly.");
    }
    throw new ApiError(502, "hub_request_failed", detail || `The hub request failed (HTTP ${response.status}).`);
  }
  return json;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorMessageFrom(json: unknown): string {
  if (json && typeof json === "object") {
    const record = json as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
  }
  return "";
}

export async function hubList(client: HubClient, kind: EigenweltHubKind): Promise<EigenweltHubItem[]> {
  const json = await hubRequest(client, "GET", `/api/hub?kind=${encodeURIComponent(kind)}`);
  const items = json && typeof json === "object" ? (json as { items?: unknown }).items : null;
  return Array.isArray(items) ? (items as EigenweltHubItem[]) : [];
}

/** List every team category at once (for the app's cross-category browse). */
export async function hubListAll(client: HubClient): Promise<EigenweltHubItem[]> {
  const json = await hubRequest(client, "GET", `/api/hub?all=1`);
  const items = json && typeof json === "object" ? (json as { items?: unknown }).items : null;
  return Array.isArray(items) ? (items as EigenweltHubItem[]) : [];
}

/**
 * Fetch the decrypted key for an item on install. Returns null when no key is
 * attached OR the caller isn't on the allow-list (403) — the caller then falls
 * back to the secret-free template.
 */
export async function hubGetSecret(client: HubClient, id: string): Promise<string | null> {
  try {
    const json = await hubRequest(client, "GET", `/api/hub/${encodeURIComponent(id)}/secret`);
    const secret = json && typeof json === "object" ? (json as { secret?: unknown }).secret : null;
    return typeof secret === "string" ? secret : null;
  } catch (err) {
    // Not allowed to copy, or no key — install the template instead.
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) return null;
    throw err;
  }
}

export async function hubGet(client: HubClient, id: string): Promise<EigenweltHubItemDetail> {
  const json = await hubRequest(client, "GET", `/api/hub/${encodeURIComponent(id)}`);
  if (!json || typeof json !== "object") {
    throw new ApiError(502, "hub_request_failed", "The hub returned an invalid item.");
  }
  return json as EigenweltHubItemDetail;
}

export async function hubCreate(
  client: HubClient,
  input: {
    kind: EigenweltHubKind;
    name: string;
    description?: string;
    payload: unknown;
    secret?: { value: string; allow: "all" | string[] } | null;
  },
): Promise<{ id: string; version: number }> {
  const json = await hubRequest(client, "POST", "/api/hub", {
    kind: input.kind,
    name: validateHubName(input.name),
    description: input.description ?? undefined,
    payload: input.payload,
    ...(input.secret === undefined ? {} : { secret: input.secret }),
  });
  const record = json && typeof json === "object" ? (json as Record<string, unknown>) : {};
  const id = typeof record.id === "string" ? record.id : "";
  if (!id) {
    throw new ApiError(502, "hub_request_failed", "The hub did not return an id for the shared item.");
  }
  return { id, version: typeof record.version === "number" ? record.version : 1 };
}

export async function hubDelete(client: HubClient, id: string): Promise<void> {
  await hubRequest(client, "DELETE", `/api/hub/${encodeURIComponent(id)}`);
}
