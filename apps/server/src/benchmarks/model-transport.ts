import { createHash } from "node:crypto";

/** Host-only benchmark evidence: never return the effective transport secrets. */
export function benchmarkModelTransportFingerprint(baseURL: string, apiKey: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["legalwork-benchmark-model-transport-v1", baseURL, apiKey]))
    .digest("hex");
}
