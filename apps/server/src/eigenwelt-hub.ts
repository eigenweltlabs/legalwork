import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ApiError } from "./errors.js";
import { sanitizeIntegrationMcp } from "./hub-sanitize.js";
import { resolveSkillDir } from "./skill-resources.js";
import { validateMcpConfig, validateMcpName, validateSkillName } from "./validators.js";
import { projectSkillsDir } from "./workspace-files.js";

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

export type EigenweltHubKind = "workflow" | "integration" | "preset";

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
};

export type EigenweltHubItemDetail = EigenweltHubItem & { payload: unknown };

/** A single file inside a shared workflow folder. */
export type EigenweltHubFile = { path: string; contentBase64: string };

/** Platform rejects payloads whose JSON exceeds 2MB (mirrored client-side). */
export const EIGENWELT_HUB_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

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
    }
  }
}

/**
 * Serialize a local skill folder (SKILL.md + resources/) to base64 files.
 * Rejects a folder whose JSON payload would exceed 2MB.
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
      `This workflow is too large to share (${Math.round(payloadBytes / 1024)}KB; limit 2MB).`,
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
  if (!Array.isArray(files) || files.length === 0) {
    throw new ApiError(400, "invalid_workflow", "The shared workflow has no files.");
  }

  const normalized = files.map((file) => {
    if (!file || typeof file !== "object") {
      throw new ApiError(400, "invalid_workflow", "Each workflow file must be an object.");
    }
    const record = file as Record<string, unknown>;
    const relPath = validateHubFilePath(typeof record.path === "string" ? record.path : "");
    if (typeof record.contentBase64 !== "string") {
      throw new ApiError(400, "invalid_workflow", `Missing file content: ${relPath}`);
    }
    return { path: relPath, contentBase64: record.contentBase64 };
  });

  if (!normalized.some((file) => file.path === "SKILL.md")) {
    throw new ApiError(400, "invalid_workflow", "The shared workflow is missing its SKILL.md.");
  }

  const baseDir = join(projectSkillsDir(workspaceRoot), name);
  let written = 0;
  for (const file of normalized) {
    const dest = resolveSafeChild(baseDir, file.path);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(file.contentBase64, "base64"));
    written += 1;
  }

  return { name, path: baseDir, written };
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
  const platformURL = connection.platformURL?.replace(/\/+$/, "") ?? "";
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
    const detail = errorMessageFrom(json);
    if (response.status === 403) {
      throw new ApiError(403, "hub_forbidden", detail || "Your firm's subscription does not allow this hub action.");
    }
    if (response.status === 413) {
      throw new ApiError(413, "hub_payload_too_large", detail || "The hub item is too large (limit 2MB).");
    }
    if (response.status === 404) {
      throw new ApiError(404, "hub_item_not_found", detail || "Hub item not found.");
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

export async function hubGet(client: HubClient, id: string): Promise<EigenweltHubItemDetail> {
  const json = await hubRequest(client, "GET", `/api/hub/${encodeURIComponent(id)}`);
  if (!json || typeof json !== "object") {
    throw new ApiError(502, "hub_request_failed", "The hub returned an invalid item.");
  }
  return json as EigenweltHubItemDetail;
}

export async function hubCreate(
  client: HubClient,
  input: { kind: EigenweltHubKind; name: string; description?: string; payload: unknown },
): Promise<{ id: string; version: number }> {
  const json = await hubRequest(client, "POST", "/api/hub", {
    kind: input.kind,
    name: validateHubName(input.name),
    description: input.description ?? undefined,
    payload: input.payload,
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
