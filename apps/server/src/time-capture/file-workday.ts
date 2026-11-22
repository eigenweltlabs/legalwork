import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CaptureAccount } from "@legalwork/types/time-capture";
import { addDays, dayInZone, zonedInstant } from "../calendar/dates.js";
import type { ConnectorRequest } from "../connectors/request.js";
import { ApiError } from "../errors.js";
import { digest, type WorkdayEvidence } from "./private-workday.js";

const drivePage = z.object({
  files: z.array(z.object({ id: z.string(), name: z.string(), modifiedByMeTime: z.string().optional(), mimeType: z.string() })),
  nextPageToken: z.string().optional(),
  incompleteSearch: z.boolean().optional(),
});
const graphItem = z.object({
  id: z.string(), name: z.string().optional(), file: z.object({}).optional(),
  parentReference: z.object({ driveId: z.string().optional() }).optional(), webUrl: z.string().optional(),
  lastModifiedDateTime: z.string().optional(), lastModifiedBy: z.object({
    user: z.object({ id: z.string().optional() }).optional(), application: z.unknown().optional(),
  }).optional(),
});
const searchPage = z.object({ value: z.array(z.object({ hitsContainers: z.array(z.object({
  hits: z.array(z.object({ resource: graphItem })).default([]), moreResultsAvailable: z.boolean().optional(),
})) })) });
const pageLimit = () => new ApiError(409, "workday_connection_page_limit", "This file source has more changes than could be checked for this day.");

function fileEdit(account: CaptureAccount, date: string, file: string[], name: string, observedAt: string): WorkdayEvidence {
  const documentId = digest([account.provider, account.account, ...file]);
  const eventKey = digest([documentId, observedAt]);
  const facts = { date, source: account.provider, account: account.account, projectId: null, documentId, activity: "MOD",
    narrative: name.trim().slice(0, 240), observedAt, startAt: null, endAt: null, workedMinutes: null };
  return { eventKey, proposal: { ...facts, key: randomUUID(), digest: digest([eventKey, facts]), dismissed: false } };
}

/** Read provider metadata only. File ownership, access and download times do not identify an edit. */
export async function fileWorkdayEvidence(
  account: CaptureAccount, date: string, zone: string, request: ConnectorRequest, signal: AbortSignal, onName?: (name: string) => void,
): Promise<WorkdayEvidence[]> {
  const start = zonedInstant(date, zone), end = zonedInstant(addDays(date, 1), zone);
  const rows = new Map<string, WorkdayEvidence>();
  function observe(file: string[], name: string | undefined, modified: string | undefined) {
    if (!name?.trim() || !modified) return;
    const time = Date.parse(modified);
    if (!(time >= Date.parse(start) && time < Date.parse(end))) return;
    const item = fileEdit(account, date, file, name, new Date(time).toISOString());
    rows.set(item.eventKey, item);
  }
  if (account.provider === "google-drive") {
    if (onName) {
      const who = z.object({ user: z.object({ displayName: z.string().optional(), emailAddress: z.string().optional() }) })
        .safeParse(await request("/drive/v3/about?fields=user(displayName,emailAddress)", { signal }).catch(() => undefined));
      const name = who.data?.user.emailAddress ?? who.data?.user.displayName;
      if (name) onName(name);
    }
    const seen = new Set<string>();
    let token = "";
    do {
      signal.throwIfAborted();
      if (seen.has(token) || seen.size >= 10) throw pageLimit();
      seen.add(token);
      const params = new URLSearchParams({
        q: `trashed = false and modifiedTime >= '${start}' and mimeType != 'application/vnd.google-apps.folder'`,
        orderBy: "modifiedByMeTime desc", fields: "nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedByMeTime)",
        spaces: "drive", includeItemsFromAllDrives: "true", supportsAllDrives: "true", pageSize: "100",
      });
      if (token) params.set("pageToken", token);
      const page = drivePage.parse(await request("/drive/v3/files?" + params, { signal }));
      if (page.incompleteSearch) throw pageLimit();
      for (const item of page.files) {
        if (!["application/vnd.google-apps.folder", "application/vnd.google-apps.shortcut"].includes(item.mimeType))
          observe([item.id], item.name, item.modifiedByMeTime);
      }
      if (page.files.some(file => file.modifiedByMeTime && Date.parse(file.modifiedByMeTime) < Date.parse(start))) break;
      token = page.nextPageToken ?? "";
    } while (token);
  } else if (account.provider === "onedrive" || account.provider === "sharepoint-files") {
    // This is the signed-in person's OneDrive, retrieved with the existing Files.Read permission.
    // A SharePoint site's owner cannot identify the person making a change.
    const mine = z.object({ id: z.string(), owner: z.object({ user: z.object({ id: z.string().min(1), displayName: z.string().optional(), email: z.string().optional() }) }) })
      .parse(await request("/v1.0/me/drive?$select=id,owner", { signal }));
    const name = mine.owner.user.email ?? mine.owner.user.displayName;
    if (name) onName?.(name);
    for (let from = 0; ; from += 100) {
      signal.throwIfAborted();
      if (from >= 1000) throw pageLimit();
      const body = { requests: [{ entityTypes: ["driveItem"], from, size: 100,
        query: { queryString: `IsDocument:true AND LastModifiedTime>=${start} AND LastModifiedTime<${end}` },
        fields: ["id", "name", "webUrl", "parentReference", "file", "lastModifiedDateTime", "lastModifiedBy"] }] };
      const page = searchPage.parse(await request("/v1.0/search/query", { method: "POST", body, signal }));
      const containers = page.value.flatMap(value => value.hitsContainers);
      for (const { resource: hit } of containers.flatMap(container => container.hits)) {
        const drive = hit.parentReference?.driveId;
        if (!drive || !hit.webUrl) continue;
        const site = URL.parse(hit.webUrl);
        if (!site || site.protocol !== "https:") continue;
        if (account.provider === "onedrive" ? drive !== mine.id :
          drive === mine.id || site.hostname.split(".")[0].endsWith("-my") || site.pathname.toLowerCase().startsWith("/personal/")) continue;
        // Search projections can omit identity or expose a display name. Read the current item metadata when necessary.
        const item = hit.file && hit.lastModifiedBy?.user?.id ? hit : graphItem.parse(await request(
          "/v1.0/drives/" + encodeURIComponent(drive) + "/items/" + encodeURIComponent(hit.id) +
          "?$select=id,name,file,lastModifiedBy,lastModifiedDateTime", { signal }));
        if (item.file && !item.lastModifiedBy?.application && item.lastModifiedBy?.user?.id === mine.owner.user.id)
          observe([drive, item.id], item.name, item.lastModifiedDateTime);
      }
      if (!containers.some(container => container.moreResultsAvailable)) break;
    }
  }
  return [...rows.values()];
}

const deltaPage = z.object({ value: z.array(graphItem.extend({ deleted: z.unknown().optional() })),
  "@odata.nextLink": z.string().optional(), "@odata.deltaLink": z.string().optional() });

/** Personal drives have no date-based changes query. Start at the current cursor and only record subsequent edits. */
export async function personalDriveChanges(account: CaptureAccount, cursor: string | undefined, zone: string,
  request: ConnectorRequest, signal: AbortSignal, onName?: (name: string) => void) {
  const origin = request.apiOrigin ?? "https://graph.microsoft.com";
  const base = origin === "https://api.onedrive.com" ? "/v1.0/drive" : "/v1.0/me/drive";
  const owner = z.object({ id: z.string(), owner: z.object({ user: z.object({ id: z.string(), displayName: z.string().optional() }) }) })
    .parse(await request(base + "?$select=id,owner", { signal }));
  if (owner.owner.user.displayName) onName?.(owner.owner.user.displayName);
  const canonical = "/v1.0/drives/" + encodeURIComponent(owner.id);
  const delta = canonical + "/root/delta";
  function continuation(link: string) {
    const url = new URL(link, origin);
    const root = [canonical, base].find(path => url.pathname.startsWith(path + "/"));
    const subpath = root && url.pathname.slice(root.length);
    if (url.origin !== origin || url.username || url.password || url.hash || !subpath ||
        !/^\/(?:root|items\/[^/]+)\/(?:view\.)?delta(?:\(token='[^/]*'\))?$/.test(subpath))
      throw new ApiError(502, "connector_api_invalid", "OneDrive returned an invalid change cursor.");
    return url.pathname + url.search;
  }
  let path = cursor ? continuation(cursor) : delta + "?token=latest";
  const seen = new Set<string>(), rows = new Map<string, WorkdayEvidence>();
  for (;;) {
    signal.throwIfAborted();
    if (seen.has(path) || seen.size >= 20) throw pageLimit();
    seen.add(path);
    const page = deltaPage.parse(await request(path, { signal }));
    for (const changed of page.value) {
      if (!cursor || changed.deleted || !changed.file) continue;
      const file = changed.lastModifiedBy && changed.lastModifiedDateTime ? changed :
        graphItem.parse(await request(canonical + "/items/" + encodeURIComponent(changed.id) +
          "?$select=id,name,file,lastModifiedBy,lastModifiedDateTime", { signal }));
      if (!file.file || !file.name || file.lastModifiedBy?.application ||
          file.lastModifiedBy?.user?.id !== owner.owner.user.id || !file.lastModifiedDateTime) continue;
      const time = Date.parse(file.lastModifiedDateTime);
      if (!Number.isFinite(time)) continue;
      const at = new Date(time).toISOString(), row = fileEdit(account, dayInZone(at, zone), [owner.id, file.id], file.name, at);
      rows.set(row.eventKey, row);
    }
    if (page["@odata.nextLink"]) path = continuation(page["@odata.nextLink"]);
    else if (page["@odata.deltaLink"]) return { cursor: continuation(page["@odata.deltaLink"]), rows: [...rows.values()] };
    else throw new ApiError(502, "connector_api_invalid", "OneDrive returned an incomplete change feed.");
  }
}
