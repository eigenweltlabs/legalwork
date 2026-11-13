import type { ViewInput, WikiDataResult } from "@legalwork/types/views";

export function viewDataStatus(view: Pick<ViewInput, "mode" | "queries" | "datasets">) {
  const live = view.mode === "dashboard" && Object.keys(view.queries).length > 0;
  const timestamps = Object.values(view.datasets ?? {}).map(data => data.asOf).filter(time => time > 0);
  return { live, asOf: timestamps.length ? Math.min(...timestamps) : null };
}
export const viewSourceAvailable = (data: Pick<WikiDataResult, "sourceServerUrl">, serverUrl: string) => data.sourceServerUrl === undefined || data.sourceServerUrl === serverUrl;
