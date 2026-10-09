import { createHash } from "node:crypto";
import { createFullErrorDetails, type FullErrorDetails } from "@legalwork/types/error-details";

/** Bind diagnostic retrieval to the exact credentials of the failed request. */
export function errorDetailsOwner(request: Request): string | null {
  const auth = request.headers.get("authorization");
  const host = request.headers.get("x-legalwork-host-token");
  return auth || host ? createHash("sha256").update(JSON.stringify([auth, host])).digest("hex") : null;
}

export function createServerErrorDetailsStore() {
  const records = new Map<string, { owner: string; at: number; details: FullErrorDetails }>();
  function prune() {
    for (const [id, record] of records) if (record.at < Date.now() - 86_400_000) records.delete(id);
    while (records.size > 50) {
      const oldest = records.keys().next().value;
      if (oldest) records.delete(oldest);
    }
  }
  return {
    record(id: string, error: unknown, request: Request): void {
      const owner = errorDetailsOwner(request);
      if (!owner) return;
      records.set(id, { owner, at: Date.now(), details: createFullErrorDetails(error, {
        method: request.method, url: request.url, headers: Object.fromEntries(request.headers),
      }) });
      prune();
    },
    get(id: string, request: Request): FullErrorDetails | null {
      prune();
      const record = records.get(id);
      return record && record.owner === errorDetailsOwner(request) ? structuredClone(record.details) : null;
    },
  };
}
