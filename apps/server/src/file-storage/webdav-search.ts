import { parseXML, type WebDAVClient } from "webdav";
import type { StorageCapabilities, StorageSearch, StorageSearchMode } from "@legalwork/types/file-storage";
import { ApiError } from "../errors.js";
import { STORAGE_PAGE_SIZE } from "./schema.js";
import { entry, storagePath, unsupportedSearch } from "./common.js";

const xml = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
const array = (value: unknown): unknown[] => (value == null ? [] : Array.isArray(value) ? value : [value]);
const successful = (status: unknown) => typeof status === "string" && /^HTTP\/\S+ 2\d\d(?: |$)/.test(status);

/** RFC 5323 discovery and queries. No recursive PROPFIND or downloaded-file scan. */
export function webdavSearch(client: WebDAVClient, endpoint: string) {
  const root = new URL(endpoint.endsWith("/") ? endpoint : `${endpoint}/`);
  const decodedRoot = decodeURIComponent(root.pathname);
  const scope = (path: string) =>
    new URL(path ? `${path.split("/").map(encodeURIComponent).join("/")}/` : "", root).href;
  const from = (path: string) =>
    `<d:from><d:scope><d:href>${xml(scope(path))}</d:href><d:depth>infinity</d:depth></d:scope></d:from>`;
  async function request(method: string, data?: string) {
    try {
      return await client.customRequest("/", {
        method,
        data,
        headers: { "Content-Type": "application/xml; charset=utf-8" },
        signal: AbortSignal.timeout(15_000),
        maxRedirects: 0,
      });
    } catch (error) {
      const status = record(error).status;
      if (typeof status === "number" && [400, 403, 405, 422, 501].includes(status))
        return new Response(null, { status });
      throw error;
    }
  }
  async function readXml(response: Awaited<ReturnType<typeof request>>) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      const data = Buffer.from(chunk);
      size += data.length;
      if (size > 2 * 1024 * 1024)
        throw new ApiError(
          502,
          "storage_search_invalid_response",
          "The storage returned an oversized search response.",
        );
      chunks.push(data);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (/<!DOCTYPE|<!ENTITY/i.test(text))
      throw new ApiError(
        502,
        "storage_search_invalid_response",
        "The storage returned an invalid or oversized search response.",
      );
    return parseXML(text);
  }
  const queryBody = (path: string, condition: string, limit: number) =>
    `<d:searchrequest xmlns:d="DAV:"><d:basicsearch><d:select><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:select>${from(path)}<d:where>${condition}</d:where><d:limit><d:nresults>${limit}</d:nresults></d:limit></d:basicsearch></d:searchrequest>`;
  const empty = (): StorageCapabilities["search"] => ({ modes: [], pagination: false });
  async function searchCapabilities(): Promise<StorageCapabilities["search"]> {
    const response = await request("OPTIONS");
    if ([405, 501].includes(response.status)) return empty();
    if (!response.ok)
      throw new ApiError(
        502,
        "storage_search_discovery_failed",
        "Could not determine this connection's search capabilities.",
      );
    if (!response.headers.get("dasl")?.toLowerCase().includes("<dav:basicsearch>")) return empty();
    const qsd = await request(
      "SEARCH",
      `<d:query-schema-discovery xmlns:d="DAV:"><d:basicsearch>${from("")}</d:basicsearch></d:query-schema-discovery>`,
    );
    // Query schema discovery is optional in RFC 5323. When unavailable, verify
    // each operator with a bounded native query before advertising it.
    if ([400, 403, 405, 422, 501].includes(qsd.status)) {
      const modes: StorageSearchMode[] = [];
      const needle = `legalwork-capability-${crypto.randomUUID()}`;
      for (const mode of ["name", "content"] satisfies StorageSearchMode[]) {
        const condition =
          mode === "name"
            ? `<d:like><d:prop><d:displayname/></d:prop><d:literal>${needle}</d:literal></d:like>`
            : `<d:contains>${needle}</d:contains>`;
        const probe = await request("SEARCH", queryBody("", condition, 1));
        if (probe.status !== 207) continue;
        const result = await readXml(probe);
        if (result.multistatus.response.every((item) => successful(item.status ?? item.propstat?.status ?? "")))
          modes.push(mode);
      }
      return { modes, pagination: false };
    }
    if (!qsd.ok)
      throw new ApiError(
        502,
        "storage_search_discovery_failed",
        "Could not determine this connection's search capabilities.",
      );
    const parsed = await readXml(qsd);
    const modes = new Set<StorageSearchMode>();
    for (const response of parsed.multistatus.response) {
      if (!successful(response.status)) continue;
      const schema = record(record(record(response)["query-schema"]).basicsearchschema);
      const descriptions = array(record(schema.properties).propdesc).map(record);
      const operators = array(record(schema.operators).opdesc).map(record);
      if (
        operators.some((op) => "like" in op) &&
        descriptions.some((desc) => "searchable" in desc && "displayname" in record(desc.prop))
      )
        modes.add("name");
      if (operators.some((op) => "contains" in op)) modes.add("content");
    }
    return { modes: [...modes], pagination: false };
  }
  return {
    searchCapabilities,
    async search(input: StorageSearch) {
      const capabilities = await searchCapabilities();
      if (!capabilities.modes.includes(input.mode)) unsupportedSearch();
      if (input.cursor)
        throw new ApiError(
          400,
          "storage_search_cursor_unsupported",
          "This search does not support continuation pages. Narrow the query or folder.",
        );
      // DAV:like uses %, _ and backslash as pattern syntax. The tool accepts literal text.
      const literal = xml(input.query.replace(/[\\%_]/g, "\\$&"));
      const condition =
        input.mode === "name"
          ? `<d:like><d:prop><d:displayname/></d:prop><d:literal>%${literal}%</d:literal></d:like>`
          : `<d:contains>${xml(input.query)}</d:contains>`;
      const data = queryBody(input.path, condition, STORAGE_PAGE_SIZE);
      const response = await request("SEARCH", data);
      if ([400, 405, 422, 501].includes(response.status)) unsupportedSearch();
      if (!response.ok) throw new ApiError(502, "storage_search_failed", "The storage could not complete this search.");
      const parsed = await readXml(response);
      const entries = [];
      let truncated = false;
      const selectedRoot = decodeURIComponent(new URL(scope(input.path)).pathname);
      for (const item of parsed.multistatus.response) {
        // A multistatus can contain failed subrequests even when HTTP is 207.
        // Do not describe the remaining matches as a complete successful search.
        if (!successful(item.status ?? item.propstat?.status ?? "")) truncated = true;
        if (!item.propstat || !successful(item.propstat.status)) continue;
        // Never return an external URL or a sibling connection's files, even if the provider does.
        const target = new URL(item.href, root);
        const decoded = decodeURIComponent(target.pathname);
        if (target.origin !== root.origin || !decoded.startsWith(selectedRoot) || !decoded.startsWith(decodedRoot))
          continue;
        const path = decoded.slice(decodedRoot.length).replace(/\/$/, "");
        if (!path) continue;
        storagePath(path, false);
        const props = item.propstat.prop;
        const folder =
          typeof props.resourcetype === "object" && props.resourcetype !== null && "collection" in props.resourcetype;
        const size = Number(props.getcontentlength);
        entries.push(
          entry(
            path,
            folder ? "folder" : "file",
            !folder && Number.isFinite(size) ? size : null,
            typeof props.getlastmodified === "string" ? props.getlastmodified : null,
          ),
        );
      }
      return {
        entries: entries.slice(0, STORAGE_PAGE_SIZE),
        truncated: truncated || entries.length >= STORAGE_PAGE_SIZE,
      };
    },
  };
}
