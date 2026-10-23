/** Resource invalidations for successful writes; execution and read-like POSTs stay quiet. */
export function requestResourceChange(method: string, path: string): "reviews" | "suggestions" | "sandbox" | "views" | null {
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return null;
  if (/\/reviews(?:\/|$)/.test(path)) {
    if (method === "POST" && /\/reviews\/(?:wait|[^/]+\/(?:rows|results)\/query)$/.test(path)) return null;
    return "reviews";
  }
  if (/\/wiki-suggestions(?:\/|$)/.test(path)) return "suggestions";
  if (/\/ui-views(?:\/|$)/.test(path)) return "views";
  if (method === "PATCH" && (/^\/sandbox\/(settings|network)$/.test(path) || /\/sandbox\/session\/[^/]+$/.test(path))) return "sandbox";
  return null;
}
