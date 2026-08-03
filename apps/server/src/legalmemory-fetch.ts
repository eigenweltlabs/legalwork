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

const LEGALMEMORY_SERVER_NAME = /^(?:legal[_-]?memory|knowledge[_-]?index)$/i;

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
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
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
