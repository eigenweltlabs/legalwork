import { setTimeout } from "node:timers/promises";
import { z } from "zod";
import { ApiError } from "../errors.js";
import type { StreamingConnectorRequest } from "../connectors/request.js";
import { parseNative } from "../connectors/native.js";
import { conflict } from "./common.js";

const invalid = () => new ApiError(502, "storage_invalid_response", "Microsoft returned an invalid copy-operation response. Refresh the destination before retrying.");
function providerUrl(value: string | null, origin: string) {
  if (!value) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
      (url.origin !== origin && url.hostname !== "api.onedrive.com" && !url.hostname.endsWith(".sharepoint.com") && !url.hostname.endsWith(".onedrive.com"))) throw invalid();
  return url;
}
const operation = z.object({ status: z.string(), resourceId: z.string().min(1).optional(),
  error: z.object({ code: z.string().optional() }).optional() });

/** Monitor URLs are short-lived provider capabilities. Never attach OAuth tokens or follow redirects. */
export async function microsoftCopy(request: StreamingConnectorRequest, endpoint: string, parentId: string, driveId: string, name: string, origin: string, consumer: boolean) {
  const query = new URLSearchParams(consumer ? {} : { "@microsoft.graph.conflictBehavior": "fail" });
  const response = await request.response(`${endpoint}?${query}`, {
    method: "POST", body: { name, parentReference: { id: parentId, driveId } },
  });
  if (response.status === 200 || response.status === 201) return parseNative(z.object({ id: z.string().min(1) }), await response.json()).id;
  if (response.status !== 202) { await response.body?.cancel(); throw invalid(); }
  const monitor = providerUrl(response.headers.get("location"), origin);
  await response.body?.cancel();
  if (!/\/(?:monitor|operations)\//.test(monitor.pathname)) throw invalid();
  const deadline = performance.now() + 14 * 60_000;
  while (performance.now() < deadline) {
    await request.assertWrite();
    let result: Response;
    try { result = await fetch(monitor, { redirect: "manual", signal: AbortSignal.timeout(30_000) }); }
    catch { throw new ApiError(502, "storage_copy_unavailable", "Could not check Microsoft copy progress. The copy may still be processing. Refresh the destination before retrying."); }
    if (result.status === 303 || result.status === 302) {
      const resource = providerUrl(result.headers.get("location"), origin);
      await result.body?.cancel();
      const id = /\/items\/([^/]+)\/?$/.exec(resource.pathname)?.[1];
      if (!id) throw invalid();
      return decodeURIComponent(id);
    }
    if (!result.ok) { await result.body?.cancel(); throw new ApiError(502, "storage_copy_unavailable", "Microsoft could not report copy progress. Refresh the destination before retrying."); }
    const status = parseNative(operation, await result.json());
    if (status.status === "completed") {
      if (!status.resourceId) throw invalid();
      return status.resourceId;
    }
    if (status.status === "failed" || status.status === "cancelled") {
      if (status.error?.code === "nameAlreadyExists") conflict();
      throw new ApiError(502, "storage_copy_failed", "Microsoft did not complete the copy. Refresh both folders before retrying.");
    }
    if (!["notStarted", "inProgress", "waiting", "updating"].includes(status.status)) throw invalid();
    const retry = Number(result.headers.get("retry-after"));
    await setTimeout(Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 5000) : 1000);
  }
  throw new ApiError(504, "storage_copy_timeout", "Microsoft has not finished the copy. It may still be processing. Refresh the destination before retrying.");
}
