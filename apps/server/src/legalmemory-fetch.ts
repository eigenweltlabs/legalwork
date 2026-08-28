/**
 * Fetching a LegalMemory document into the workspace, from our own software.
 *
 * The appliance offers two ways to get an original out. `download_document`
 * normally answers with a short-lived URL under `/api/downloads/…`, which means
 * a second HTTP hop on a side channel: it has to be externally reachable, the
 * base URL has to survive whatever proxy sits in front, and the capability
 * token has to live in the same instance that later serves it. Behind the
 * hosted proxy none of that held, and the download 404'd.
 *
 * The same tool takes `inline_blob`, which returns the bytes in the tool result
 * as a base64 MCP resource. That is what we use. Nothing leaves the MCP
 * transport, so there is no base URL to get wrong, no token to expire, and no
 * model-supplied URL for us to have to validate before fetching it.
 *
 * It also means the agent is not involved. Opening a cited document is a thing
 * the app does when the user clicks, not a task handed to a model.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const JSON_RPC_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

/** Guards a document that would blow out memory: this is buffered, not streamed. */
const MAX_INLINE_BYTES = 96 * 1024 * 1024;

export type LegalMemoryServer = {
  name: string;
  url: string;
  headers?: Record<string, string>;
};

export type FetchedDocument = {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
};

const legalMemoryTreeRootSchema = z.object({
  source_id: z.string(),
  display_name: z.string(),
  kind: z.string(),
  project_id: z.string().nullable(),
  status: z.string(),
  files: z.number(),
});

const legalMemoryTreeFolderSchema = z.object({
  name: z.string(),
  path: z.string(),
  files: z.number(),
});

const legalMemoryTreeFileSchema = z.object({
  source_object_id: z.string(),
  source_id: z.string(),
  name: z.string(),
  path: z.string(),
  mime_type: z.string().nullable(),
  size_bytes: z.number().nullable(),
  mtime: z.string().nullable(),
  document_id: z.string(),
});

const legalMemoryTreePageSchema = z.object({
  source_id: z.string(),
  path: z.string(),
  folders: z.array(legalMemoryTreeFolderSchema),
  files: z.array(legalMemoryTreeFileSchema),
  pagination: z.object({
    total: z.number(),
    offset: z.number(),
    limit: z.number(),
    returned: z.number(),
    has_more: z.boolean(),
  }),
});

export type LegalMemoryTreeRoot = z.infer<typeof legalMemoryTreeRootSchema>;
export type LegalMemoryTreePage = z.infer<typeof legalMemoryTreePageSchema>;
export type LegalMemoryTreeFile = z.infer<typeof legalMemoryTreeFileSchema>;

const LEGALMEMORY_SERVER_NAME = /^(?:legal[_-]?memory|knowledge[_-]?index)$/i;
const LEGALMEMORY_MCP_TREE_SOURCE_PREFIX = "__legalmemory_mcp__:";
const LEGALMEMORY_MCP_MATTER_PREFIX = "matter/";

const legalMemoryMcpMatterSchema = z.object({
  id: z.string(),
  title: z.string().nullable().optional(),
  visible_versions: z.number().optional(),
});

const legalMemoryMcpDocumentSchema = z.object({
  document_id: z.string(),
  version_id: z.string(),
  title: z.string().nullable().optional(),
  source_path: z.string(),
  doc_date: z.string().nullable().optional(),
});

const legalMemoryMcpSearchResultSchema = z.object({
  document_id: z.string(),
  version_id: z.string(),
  title: z.string().nullable().optional(),
  source_paths: z.array(z.string()).optional(),
  doc_date: z.string().nullable().optional(),
});

const legalMemoryMcpConnectorSchema = z.object({
  id: z.string(),
  project_id: z.string().nullable().optional(),
  kind: z.string(),
  display_name: z.string(),
});

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The configured LegalMemory server, if the firm has one. */
export function resolveLegalMemoryServer(
  items: readonly { name: string; config?: unknown }[],
): LegalMemoryServer | null {
  for (const item of items) {
    if (!LEGALMEMORY_SERVER_NAME.test(item.name)) continue;
    const config = asRecord(item.config);
    const url = config && typeof config.url === "string" ? config.url.trim() : "";
    if (!url) continue;
    const headers = asRecord(config?.headers);
    return {
      name: item.name,
      url,
      headers: headers
        ? Object.fromEntries(
            Object.entries(headers).filter(([, v]) => typeof v === "string") as [string, string][],
          )
        : undefined,
    };
  }
  return null;
}

/**
 * The tree is served by the same LegalMemory deployment as MCP and authorizes
 * against the same bearer token. Keep the appliance URL and token on the
 * LegalWork server: the renderer only talks to its workspace API.
 */
export function legalMemoryTreeApiUrl(serverUrl: string, path: string): string {
  const url = new URL(serverUrl);
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  const mcpSuffix = /\/mcp$/i;
  if (!mcpSuffix.test(normalizedPath)) {
    throw new Error("LegalMemory MCP URL must end in /mcp");
  }
  url.pathname = `${normalizedPath.replace(mcpSuffix, "")}${path.startsWith("/") ? path : `/${path}`}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** The hosted demo exposes its appliance tree through one Clerk-protected
 * proxy route. Raw appliances expose the four `/api/tree/*` routes directly. */
export function legalMemoryTreeProxyUrl(serverUrl: string, operation: string): string {
  const url = new URL(legalMemoryTreeApiUrl(serverUrl, "/api/tree"));
  url.searchParams.set("op", operation);
  return url.toString();
}

async function fetchLegalMemoryTreeResponse(
  server: LegalMemoryServer,
  url: URL,
  bearer?: string,
): Promise<Response> {
  return fetch(url, {
    headers: {
      accept: "application/json",
      ...(server.headers ?? {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
  });
}

async function fetchLegalMemoryTreeJson(
  server: LegalMemoryServer,
  path: string,
  operation: string,
  params: Record<string, string | number | undefined>,
  bearer?: string,
): Promise<unknown> {
  const candidates = [
    new URL(legalMemoryTreeProxyUrl(server.url, operation)),
    new URL(legalMemoryTreeApiUrl(server.url, path)),
  ];
  let lastFailure = "LegalMemory file tree failed";
  for (const url of candidates) {
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
    }
    const response = await fetchLegalMemoryTreeResponse(server, url, bearer);
    if (response.ok) return response.json();
    const detail = (await response.text().catch(() => "")).trim().slice(0, 300);
    lastFailure = `LegalMemory file tree failed (${response.status})${detail ? `: ${detail}` : ""}`;
  }
  throw new Error(lastFailure);
}

export async function fetchLegalMemoryTreeRoots(
  server: LegalMemoryServer,
  bearer?: string,
): Promise<{ roots: LegalMemoryTreeRoot[] }> {
  try {
    const body = await fetchLegalMemoryTreeJson(server, "/api/tree/roots", "roots", {}, bearer);
    return z.object({ roots: z.array(legalMemoryTreeRootSchema) }).parse(body);
  } catch {
    return { roots: await fetchLegalMemoryMcpRoots(server, bearer) };
  }
}

export async function fetchLegalMemoryTreeChildren(
  server: LegalMemoryServer,
  input: { sourceId: string; path?: string; offset: number; limit: number },
  bearer?: string,
): Promise<LegalMemoryTreePage> {
  if (input.sourceId.startsWith(LEGALMEMORY_MCP_TREE_SOURCE_PREFIX)) {
    return fetchLegalMemoryMcpChildren(server, input, bearer);
  }
  const body = await fetchLegalMemoryTreeJson(server, "/api/tree/children", "children", {
    source_id: input.sourceId,
    path: input.path,
    offset: input.offset,
    limit: input.limit,
  }, bearer);
  return legalMemoryTreePageSchema.parse(body);
}

export async function fetchLegalMemoryTreeSearch(
  server: LegalMemoryServer,
  input: { query: string; limit: number },
  bearer?: string,
): Promise<{ files: LegalMemoryTreeFile[] }> {
  try {
    const body = await fetchLegalMemoryTreeJson(server, "/api/tree/search", "search", input, bearer);
    return z.object({ files: z.array(legalMemoryTreeFileSchema) }).parse(body);
  } catch {
    return { files: await fetchLegalMemoryMcpSearch(server, input, bearer) };
  }
}

/** Parse one streamable-HTTP response body, which is either JSON or an SSE
 * frame carrying the JSON on a `data:` line. */
function parseRpcBody(text: string): unknown {
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  const payload = line ? line.replace(/^data:\s*/, "") : text;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

type Session = { url: string; headers: Record<string, string> };

async function rpc(session: Session, method: string, params: unknown, id?: number): Promise<unknown> {
  const response = await fetch(session.url, {
    method: "POST",
    headers: session.headers,
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }),
  });
  // The server assigns a session on initialize and expects it echoed after.
  const assigned = response.headers.get("mcp-session-id");
  if (assigned) session.headers["mcp-session-id"] = assigned;
  if (!response.ok && response.status !== 202) {
    throw new Error(`LegalMemory ${method} failed (${response.status})`);
  }
  return parseRpcBody(await response.text());
}

function legalMemorySession(server: LegalMemoryServer, bearer?: string): Session {
  return {
    url: server.url,
    headers: {
      ...JSON_RPC_HEADERS,
      ...(server.headers ?? {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
  };
}

function legalMemoryToolPayload(value: unknown): unknown {
  const envelope = asRecord(value);
  const error = asRecord(envelope?.error);
  if (error) throw new Error(String(error.message ?? "LegalMemory tool call failed"));
  const result = asRecord(envelope?.result ?? envelope);
  if (!result) throw new Error("LegalMemory returned no tool result");
  if (result.isError === true) throw new Error("LegalMemory tool call failed");
  const structured = asRecord(result.structuredContent);
  if (structured) return structured;
  if (!Array.isArray(result.content)) throw new Error("LegalMemory returned no structured tool content");
  for (const item of result.content) {
    const text = asRecord(item)?.text;
    if (typeof text !== "string") continue;
    try {
      return JSON.parse(text);
    } catch {
      // Tool cards may precede the JSON payload; keep looking.
    }
  }
  throw new Error("LegalMemory returned no structured tool content");
}

async function callLegalMemoryTool(
  server: LegalMemoryServer,
  name: string,
  args: Record<string, unknown>,
  bearer?: string,
): Promise<unknown> {
  const session = legalMemorySession(server, bearer);
  await rpc(session, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "LegalWork", version: "1" },
  }, 1);
  await rpc(session, "notifications/initialized", {});
  const result = await rpc(session, "tools/call", { name, arguments: args }, 2);
  return legalMemoryToolPayload(result);
}

function normalizedSourcePath(value: string): string {
  return value.replace(/\\/g, "/").split("/").filter(Boolean).join("/");
}

function mcpMatterPath(matterId: string, sourcePath = ""): string {
  const base = `${LEGALMEMORY_MCP_MATTER_PREFIX}${encodeURIComponent(matterId)}`;
  return sourcePath ? `${base}/${normalizedSourcePath(sourcePath)}` : base;
}

function parseMcpMatterPath(path: string): { matterId: string; sourcePath: string } {
  if (!path.startsWith(LEGALMEMORY_MCP_MATTER_PREFIX)) {
    throw new Error("LegalMemory returned an unknown MCP folder path");
  }
  const rest = path.slice(LEGALMEMORY_MCP_MATTER_PREFIX.length);
  const separator = rest.indexOf("/");
  const encodedMatterId = separator === -1 ? rest : rest.slice(0, separator);
  const matterId = decodeURIComponent(encodedMatterId);
  if (!matterId) throw new Error("LegalMemory returned an empty matter id");
  return {
    matterId,
    sourcePath: separator === -1 ? "" : normalizedSourcePath(rest.slice(separator + 1)),
  };
}

async function fetchLegalMemoryMcpMatters(
  server: LegalMemoryServer,
  bearer?: string,
  input: { limit?: number; offset?: number } = {},
): Promise<z.infer<typeof legalMemoryMcpMatterSchema>[]> {
  const payload = await callLegalMemoryTool(server, "list_matters", {
    limit: input.limit ?? 500,
    offset: input.offset ?? 0,
  }, bearer);
  const body = z.object({ results: z.array(legalMemoryMcpMatterSchema) }).parse(payload);
  return body.results;
}

function mcpTreeSourceId(connectorId: string): string {
  return `${LEGALMEMORY_MCP_TREE_SOURCE_PREFIX}${encodeURIComponent(connectorId)}`;
}

function findLegalMemoryMcpConnectors(
  value: unknown,
  found = new Map<string, z.infer<typeof legalMemoryMcpConnectorSchema>>(),
  depth = 0,
): Map<string, z.infer<typeof legalMemoryMcpConnectorSchema>> {
  if (depth > 8) return found;
  const record = asRecord(value);
  if (record) {
    const connector = legalMemoryMcpConnectorSchema.safeParse(record.connector);
    if (connector.success) found.set(connector.data.id, connector.data);
    for (const nested of Object.values(record)) {
      findLegalMemoryMcpConnectors(nested, found, depth + 1);
    }
    return found;
  }
  if (Array.isArray(value)) {
    for (const nested of value) findLegalMemoryMcpConnectors(nested, found, depth + 1);
  }
  return found;
}

/**
 * Hosted demo deployments currently expose the document tools publicly while
 * their browser-only tree route sits behind the signed-in page. The MCP
 * citation on an original carries the real connector identity, so use that as
 * the compatibility root instead of inventing a "LegalMemory" folder above it.
 * Appliances with the native tree API skip this path and return every connector
 * directly.
 */
async function fetchLegalMemoryMcpRoots(
  server: LegalMemoryServer,
  bearer?: string,
): Promise<LegalMemoryTreeRoot[]> {
  const matters = await fetchLegalMemoryMcpMatters(server, bearer);
  const matter = matters[0];
  if (!matter) return [];
  const documents = await fetchLegalMemoryMcpDocuments(server, matter.id, bearer);
  const document = documents[0];
  if (!document) return [];
  const payload = await callLegalMemoryTool(server, "download_document", {
    document_id: document.document_id,
    version_id: document.version_id,
    inline_blob: false,
  }, bearer);
  return Array.from(findLegalMemoryMcpConnectors(payload).values(), (connector) => ({
    source_id: mcpTreeSourceId(connector.id),
    display_name: connector.display_name,
    kind: connector.kind,
    project_id: connector.project_id ?? null,
    status: "ready",
    // The MCP matter listing omits unclassified documents and has no exact
    // estate total. Native tree roots carry the authoritative count.
    files: 0,
  })).sort((left, right) => left.display_name.localeCompare(right.display_name));
}

async function fetchLegalMemoryMcpDocuments(
  server: LegalMemoryServer,
  matterId: string,
  bearer?: string,
): Promise<z.infer<typeof legalMemoryMcpDocumentSchema>[]> {
  const payload = await callLegalMemoryTool(server, "list_matter_documents", { matter_id: matterId }, bearer);
  const body = z.object({ results: z.array(legalMemoryMcpDocumentSchema) }).parse(payload);
  return body.results;
}

async function fetchLegalMemoryMcpChildren(
  server: LegalMemoryServer,
  input: { sourceId: string; path?: string; offset: number; limit: number },
  bearer?: string,
): Promise<LegalMemoryTreePage> {
  const path = input.path ?? "";
  const treeSourceId = input.sourceId;
  if (!path) {
    const matters = await fetchLegalMemoryMcpMatters(server, bearer);
    return {
      source_id: treeSourceId,
      path,
      folders: matters.map((matter) => ({
        name: matter.title?.trim() || matter.id,
        path: mcpMatterPath(matter.id),
        files: matter.visible_versions ?? 0,
      })),
      files: [],
      pagination: { total: 0, offset: input.offset, limit: input.limit, returned: 0, has_more: false },
    };
  }

  const location = parseMcpMatterPath(path);
  const documents = await fetchLegalMemoryMcpDocuments(server, location.matterId, bearer);
  const rawPaths = documents.map((document) => normalizedSourcePath(document.source_path));
  const matterPrefix = rawPaths[0]?.split("/")[0] ?? "";
  const folderCounts = new Map<string, number>();
  const filesById = new Map<string, LegalMemoryTreeFile>();
  for (const [index, document] of documents.entries()) {
    const rawPath = rawPaths[index] ?? "";
    const sourcePath = matterPrefix && rawPath.startsWith(`${matterPrefix}/`)
      ? rawPath.slice(matterPrefix.length + 1)
      : rawPath;
    const relativePath = location.sourcePath
      ? sourcePath.startsWith(`${location.sourcePath}/`)
        ? sourcePath.slice(location.sourcePath.length + 1)
        : ""
      : sourcePath;
    if (!relativePath) continue;
    const segments = relativePath.split("/");
    if (segments.length > 1) {
      const name = segments[0];
      if (name) folderCounts.set(name, (folderCounts.get(name) ?? 0) + 1);
      continue;
    }
    const name = segments[0] || document.title?.trim() || document.document_id;
    filesById.set(`${document.version_id}:${sourcePath}`, {
      source_object_id: `${document.version_id}:${sourcePath}`,
      source_id: treeSourceId,
      name,
      path: sourcePath,
      mime_type: null,
      size_bytes: null,
      mtime: document.doc_date ?? null,
      document_id: document.document_id,
    });
  }

  const folders = Array.from(folderCounts, ([name, files]) => ({
    name,
    path: mcpMatterPath(location.matterId, [location.sourcePath, name].filter(Boolean).join("/")),
    files,
  })).sort((left, right) => left.name.localeCompare(right.name));
  const allFiles = Array.from(filesById.values()).sort((left, right) => left.name.localeCompare(right.name));
  const files = allFiles.slice(input.offset, input.offset + input.limit);
  return {
    source_id: treeSourceId,
    path,
    folders,
    files,
    pagination: {
      total: allFiles.length,
      offset: input.offset,
      limit: input.limit,
      returned: files.length,
      has_more: input.offset + files.length < allFiles.length,
    },
  };
}

async function fetchLegalMemoryMcpSearch(
  server: LegalMemoryServer,
  input: { query: string; limit: number },
  bearer?: string,
): Promise<LegalMemoryTreeFile[]> {
  const payload = await callLegalMemoryTool(server, "search_semantic", {
    query: input.query,
    limit: input.limit,
    offset: 0,
  }, bearer);
  const body = z.object({ results: z.array(legalMemoryMcpSearchResultSchema) }).parse(payload);
  return body.results.flatMap((result) => {
    const sourcePath = normalizedSourcePath(result.source_paths?.[0] ?? result.title ?? "");
    if (!sourcePath) return [];
    return [{
      source_object_id: `${result.version_id}:${sourcePath}`,
      source_id: mcpTreeSourceId("search"),
      name: sourcePath.split("/").pop() ?? result.title?.trim() ?? result.document_id,
      path: sourcePath,
      mime_type: null,
      size_bytes: null,
      mtime: result.doc_date ?? null,
      document_id: result.document_id,
    }];
  });
}

/** Walk a tool result for the first base64 resource blob. */
function findBlob(value: unknown, depth = 0): { blob: string; mimeType?: string; name?: string } | null {
  if (depth > 6) return null;
  const record = asRecord(value);
  if (record) {
    if (typeof record.blob === "string" && record.blob.length > 0) {
      return {
        blob: record.blob,
        mimeType: typeof record.mimeType === "string" ? record.mimeType : undefined,
        name: typeof record.name === "string" ? record.name : undefined,
      };
    }
    for (const nested of Object.values(record)) {
      const found = findBlob(nested, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findBlob(entry, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Look for a filename in the structured metadata, which is more reliable than
 * the resource's own name. */
function findFilename(value: unknown, depth = 0): string | null {
  if (depth > 6) return null;
  const record = asRecord(value);
  if (record) {
    if (typeof record.filename === "string" && record.filename.trim()) return record.filename.trim();
    for (const nested of Object.values(record)) {
      const found = findFilename(nested, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findFilename(entry, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Call `download_document` with `inline_blob` and return the original bytes.
 *
 * `bearer` is the engine's stored access token for this server when it has one;
 * an appliance behind Keycloak needs it, an open deployment does not.
 */
export async function fetchLegalMemoryDocument(
  server: LegalMemoryServer,
  documentId: string,
  bearer?: string,
): Promise<FetchedDocument> {
  const session: Session = {
    url: server.url,
    headers: {
      ...JSON_RPC_HEADERS,
      ...(server.headers ?? {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
  };

  await rpc(session, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "LegalWork", version: "1" },
  }, 1);
  // Required by the lifecycle before any tool call; carries no id.
  await rpc(session, "notifications/initialized", {});

  const result = await rpc(session, "tools/call", {
    name: "download_document",
    arguments: { document_id: documentId, inline_blob: true },
  }, 2);

  const envelope = asRecord(result);
  const error = asRecord(envelope?.error);
  if (error) throw new Error(String(error.message ?? "LegalMemory refused the download"));

  const found = findBlob(envelope?.result ?? envelope);
  if (!found) throw new Error("LegalMemory returned no document content");

  const bytes = Uint8Array.from(Buffer.from(found.blob, "base64"));
  if (bytes.byteLength === 0) throw new Error("LegalMemory returned an empty document");
  if (bytes.byteLength > MAX_INLINE_BYTES) {
    throw new Error(`Document is larger than the ${Math.round(MAX_INLINE_BYTES / (1024 * 1024))} MB limit`);
  }

  const filename = findFilename(envelope?.result ?? envelope) ?? found.name ?? `${documentId}.bin`;
  return {
    filename,
    mimeType: found.mimeType ?? "application/octet-stream",
    bytes,
  };
}

/**
 * The access token the engine already holds for this server, if any.
 *
 * An appliance behind Keycloak needs one; an open deployment does not. We read
 * the engine's own store rather than running a second OAuth flow, so there is
 * exactly one sign-in and one place tokens live. A missing or expired entry is
 * not an error here: the call is attempted without a token and the server says
 * what it thinks.
 */
export async function engineAccessToken(serverName: string): Promise<string | undefined> {
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  try {
    const raw = await readFile(join(dataHome, "opencode", "mcp-auth.json"), "utf8");
    const entry = asRecord(asRecord(JSON.parse(raw))?.[serverName]);
    const tokens = asRecord(entry?.tokens);
    const token = tokens?.accessToken;
    return typeof token === "string" && token.trim() ? token.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The stored relations around a document: what supersedes it, annexes it,
 * references it.
 *
 * Called by the app, not by the agent. The instruction to traverse is in the
 * agent's prompt and models simply do not follow it — measured on a real run,
 * six searches and not one traversal — and the engine exposes no way to force a
 * tool call. Since the graph is the part of this index a search cannot
 * reproduce, waiting for the model to ask for it means it never appears. So the
 * app asks, for the document the answer actually cited.
 */
export async function fetchLegalMemoryGraph(
  server: LegalMemoryServer,
  documentId: string,
  bearer?: string,
): Promise<unknown> {
  const session: Session = {
    url: server.url,
    headers: {
      ...JSON_RPC_HEADERS,
      ...(server.headers ?? {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
  };
  await rpc(session, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "LegalWork", version: "1" },
  }, 1);
  await rpc(session, "notifications/initialized", {});
  const result = await rpc(session, "tools/call", {
    name: "find_related_documents",
    arguments: { document_id: documentId },
  }, 2);
  const envelope = asRecord(result);
  const error = asRecord(envelope?.error);
  if (error) throw new Error(String(error.message ?? "LegalMemory refused the traversal"));
  // The tool result carries the graph as JSON text; hand back whatever shape it
  // used and let the client's parser decide.
  return findStructured(envelope?.result ?? envelope);
}

/**
 * Pull the graph payload out of an MCP tool result.
 *
 * The appliance returns it twice: as JSON inside a text content item and as
 * structuredContent. The text item is the one that reliably carries
 * root_document, so it is tried first and the result is only accepted once it
 * looks like the graph rather than some other object that happened to parse.
 */
function findStructured(value: unknown): unknown {
  const envelope = asRecord(value);
  const content = envelope && Array.isArray(envelope.content) ? envelope.content : [];
  for (const item of content) {
    const record = asRecord(item);
    if (typeof record?.text !== "string") continue;
    try {
      const parsed = asRecord(JSON.parse(record.text));
      if (parsed && "root_document" in parsed) return parsed;
    } catch {
      // Not the payload; keep looking.
    }
  }
  const structured = asRecord(envelope?.structuredContent);
  return structured && "root_document" in structured ? structured : null;
}

/**
 * Matter id to matter title.
 *
 * A search hit names the matter only by id, and the connector name that used to
 * sit under a source title ("Index") says nothing a reader wants. The matter is
 * the useful context, so it is resolved once per turn and cached client-side.
 */
export async function fetchLegalMemoryMatters(
  server: LegalMemoryServer,
  bearer?: string,
): Promise<Record<string, string>> {
  const session: Session = {
    url: server.url,
    headers: {
      ...JSON_RPC_HEADERS,
      ...(server.headers ?? {}),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
  };
  await rpc(session, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "LegalWork", version: "1" },
  }, 1);
  await rpc(session, "notifications/initialized", {});
  const result = await rpc(session, "tools/call", {
    name: "list_matters",
    arguments: { limit: 250 },
  }, 2);

  const envelope = asRecord(result);
  const content = asRecord(envelope?.result)?.content;
  const matters: Record<string, string> = {};
  if (!Array.isArray(content)) return matters;
  for (const item of content) {
    const text = asRecord(item)?.text;
    if (typeof text !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(text);
      // Every list-shaped appliance tool returns {results, page}; older builds
      // returned the bare array this was written against. Both are read, because
      // the firm's appliance version is not ours to choose.
      const rows = Array.isArray(parsed) ? parsed : asRecord(parsed)?.results;
      if (!Array.isArray(rows)) continue;
      for (const entry of rows) {
        const record = asRecord(entry);
        const id = record ? asString(record.id) : undefined;
        const title = record ? asString(record.title) : undefined;
        if (id && title) matters[id] = title;
      }
      if (Object.keys(matters).length) return matters;
    } catch {
      // Not the payload; keep looking.
    }
  }
  return matters;
}
