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

import { z } from "zod";
import { canFallbackLegalMemoryTree } from "./legalmemory-rpc.js";

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
    if (config?.disabled === true || config?.enabled === false) continue;
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

export type LegalMemoryClient = {
  /** Both operations run inside OpenCode. Credentials never cross this boundary. */
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
  tree(operation: "roots" | "children" | "search", params: Record<string, string | number | undefined>): Promise<unknown>;
};

export async function fetchLegalMemoryTreeRoots(
  client: LegalMemoryClient,
): Promise<{ roots: LegalMemoryTreeRoot[] }> {
  try {
    const body = await client.tree("roots", {});
    return z.object({ roots: z.array(legalMemoryTreeRootSchema) }).parse(body);
  } catch (error) {
    if (!canFallbackLegalMemoryTree(error)) throw error;
    return { roots: await fetchLegalMemoryMcpRoots(client) };
  }
}

export async function fetchLegalMemoryTreeChildren(
  client: LegalMemoryClient,
  input: { sourceId: string; path?: string; offset: number; limit: number },
): Promise<LegalMemoryTreePage> {
  if (input.sourceId.startsWith(LEGALMEMORY_MCP_TREE_SOURCE_PREFIX)) {
    return fetchLegalMemoryMcpChildren(client, input);
  }
  const body = await client.tree("children", {
    source_id: input.sourceId,
    path: input.path,
    offset: input.offset,
    limit: input.limit,
  });
  return legalMemoryTreePageSchema.parse(body);
}

/**
 * How much of a folder one drag can pull in.
 *
 * A drop is a gesture, not a sync: without a ceiling, dragging a matter with a
 * decade of correspondence in it would buffer the whole thing through this
 * process. The caller is told when a folder was cut short so the user sees it
 * rather than silently working from a partial copy.
 */
export const FOLDER_EXPORT_LIMITS = { files: 200, depth: 12 } as const;
const FOLDER_PAGE_SIZE = 200;

export type LegalMemoryFolderEntry = {
  file: LegalMemoryTreeFile;
  /** Where the file sits inside the dragged folder, e.g. `Pleadings/Answer.docx`. */
  relativePath: string;
};

/**
 * Every file under a folder, with the folder's own shape preserved.
 *
 * The relative path is accumulated from the folder names walked into rather
 * than sliced off `file.path`: the two tree backends disagree about what a
 * folder path looks like (the appliance uses the source path, the MCP fallback
 * uses `matter/<id>/…`), and the names are the part they agree on.
 */
export async function collectLegalMemoryFolderFiles(
  client: LegalMemoryClient,
  input: { sourceId: string; path: string },
): Promise<{ entries: LegalMemoryFolderEntry[]; truncated: boolean }> {
  const entries: LegalMemoryFolderEntry[] = [];
  let truncated = false;

  const walk = async (path: string, prefix: string, depth: number): Promise<void> => {
    const subfolders: { name: string; path: string }[] = [];
    for (let offset = 0; ; ) {
      const page = await fetchLegalMemoryTreeChildren(
        client,
        { sourceId: input.sourceId, path: path || undefined, offset, limit: FOLDER_PAGE_SIZE },
      );
      // Both backends repeat the full folder list on every page of files.
      if (offset === 0) subfolders.push(...page.folders.map((folder) => ({ name: folder.name, path: folder.path })));
      for (const file of page.files) {
        if (entries.length >= FOLDER_EXPORT_LIMITS.files) {
          truncated = true;
          return;
        }
        entries.push({ file, relativePath: `${prefix}${file.name}` });
      }
      if (!page.pagination.has_more || page.pagination.returned === 0) break;
      offset += page.pagination.returned;
    }
    if (depth >= FOLDER_EXPORT_LIMITS.depth) {
      if (subfolders.length) truncated = true;
      return;
    }
    for (const folder of subfolders) {
      await walk(folder.path, `${prefix}${folder.name}/`, depth + 1);
      if (truncated) return;
    }
  };

  await walk(input.path, "", 0);
  return { entries, truncated };
}

export async function fetchLegalMemoryTreeSearch(
  client: LegalMemoryClient,
  input: { query: string; limit: number },
): Promise<{ files: LegalMemoryTreeFile[] }> {
  try {
    const body = await client.tree("search", input);
    return z.object({ files: z.array(legalMemoryTreeFileSchema) }).parse(body);
  } catch (error) {
    if (!canFallbackLegalMemoryTree(error)) throw error;
    return { files: await fetchLegalMemoryMcpSearch(client, input) };
  }
}

function legalMemoryToolPayload(value: unknown): unknown {
  const envelope = asRecord(value);
  const result = asRecord(envelope?.result ?? envelope);
  if (!result || result.isError === true || envelope?.error) throw new Error("LegalMemory tool call failed");
  if (result.structuredContent !== undefined) return result.structuredContent;
  for (const part of Array.isArray(result.content) ? result.content : []) {
    const text = asRecord(part)?.text;
    if (typeof text !== "string") continue;
    try { return JSON.parse(text); } catch { /* Tool cards may precede the JSON payload. */ }
  }
  throw new Error("LegalMemory returned no structured tool content");
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
  client: LegalMemoryClient,
  input: { limit?: number; offset?: number } = {},
): Promise<z.infer<typeof legalMemoryMcpMatterSchema>[]> {
  const response = await client.callTool("list_matters", {
    limit: input.limit ?? 500,
    offset: input.offset ?? 0,
  });
  const payload = legalMemoryToolPayload(response);
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
  client: LegalMemoryClient,
): Promise<LegalMemoryTreeRoot[]> {
  const matters = await fetchLegalMemoryMcpMatters(client);
  const matter = matters[0];
  if (!matter) return [];
  const documents = await fetchLegalMemoryMcpDocuments(client, matter.id);
  const document = documents[0];
  if (!document) return [];
  const response = await client.callTool("download_document", {
    document_id: document.document_id,
    version_id: document.version_id,
    inline_blob: false,
  });
  return Array.from(findLegalMemoryMcpConnectors(legalMemoryToolPayload(response)).values(), (connector) => ({
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
  client: LegalMemoryClient,
  matterId: string,
): Promise<z.infer<typeof legalMemoryMcpDocumentSchema>[]> {
  const response = await client.callTool("list_matter_documents", { matter_id: matterId });
  const payload = legalMemoryToolPayload(response);
  const body = z.object({ results: z.array(legalMemoryMcpDocumentSchema) }).parse(payload);
  return body.results;
}

async function fetchLegalMemoryMcpChildren(
  client: LegalMemoryClient,
  input: { sourceId: string; path?: string; offset: number; limit: number },
): Promise<LegalMemoryTreePage> {
  const path = input.path ?? "";
  const treeSourceId = input.sourceId;
  if (!path) {
    const matters = await fetchLegalMemoryMcpMatters(client);
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
  const documents = await fetchLegalMemoryMcpDocuments(client, location.matterId);
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
  client: LegalMemoryClient,
  input: { query: string; limit: number },
): Promise<LegalMemoryTreeFile[]> {
  const response = await client.callTool("search_semantic", {
    query: input.query,
    limit: input.limit,
    offset: 0,
  });
  const payload = legalMemoryToolPayload(response);
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

/** Download original bytes using the native engine's already-authorized MCP connection. */
export async function fetchLegalMemoryDocument(
  client: LegalMemoryClient,
  documentId: string,
): Promise<FetchedDocument> {
  const result = await client.callTool("download_document", { document_id: documentId, inline_blob: true });
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
  client: LegalMemoryClient,
  documentId: string,
): Promise<unknown> {
  const result = await client.callTool("find_related_documents", { document_id: documentId });
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
