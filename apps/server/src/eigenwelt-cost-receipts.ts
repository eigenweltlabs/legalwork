import { join } from "node:path";
import { z } from "zod";
import { eigenweltPlatformUrl } from "./eigenwelt-auth.js";
import { ensureFreshPlatformToken } from "./eigenwelt-refresh.js";
import { readCachedEigenweltPaidManifest } from "./eigenwelt-paid-manifest.js";
import { runtimeStorageDir } from "./runtime-opencode-config-store.js";
import { gatewayReceiptSchema, readSettledGatewayCosts, saveSettledGatewayCost, type GatewayCostReceipt } from "./gateway-cost-store.js";
import type { ServerConfig } from "./types.js";

export const gatewayCostsDirectory = (config: ServerConfig) => join(runtimeStorageDir(config), "gateway-costs");
export type GatewayReceiptLookup = { requestId: string; responseId?: string };
const responseSchema = z.object({ currency: z.literal("EUR"), receipts: z.array(gatewayReceiptSchema).max(20) });

/** Only IDs leave the machine. Credentials remain in the host process. An
 * older/offline platform must never prevent reading direct-provider costs. */
export async function readGatewayReceipts(config: ServerConfig, sessionId: string, requests: GatewayReceiptLookup[], signal?: AbortSignal) {
  const directory = gatewayCostsDirectory(config);
  const settled = await readSettledGatewayCosts(directory, sessionId);
  const ids = new Map(requests.map(request => [request.requestId, request]));
  const receipts = new Map<string, GatewayCostReceipt>();
  for (const [id, receipt] of settled) if (ids.has(id)) receipts.set(id, receipt);
  const outstanding = [...ids.values()].filter(request => !receipts.has(request.requestId));
  if (!outstanding.length) return receipts;
  try {
    const token = await ensureFreshPlatformToken(config) ?? (await readCachedEigenweltPaidManifest(config))?.apiKey;
    if (!token) return receipts;
    for (let offset = 0; offset < outstanding.length; offset += 20) {
      const batch = outstanding.slice(offset, offset + 20);
      const response = await fetch(`${eigenweltPlatformUrl()}/api/desktop/usage-receipts`, {
        method: "POST", redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requests: batch }),
      });
      if (!response.ok) break;
      const data = responseSchema.parse(await response.json());
      const expected = new Set(batch.map(request => request.requestId));
      const seen = new Set<string>();
      for (const receipt of data.receipts) {
        if (!expected.has(receipt.requestId) || seen.has(receipt.requestId) ||
          (receipt.status === "settled") !== (receipt.costEur !== null)) throw new Error("Invalid gateway receipt batch");
        seen.add(receipt.requestId);
      }
      if (seen.size !== expected.size) throw new Error("Incomplete gateway receipt batch");
      for (const receipt of data.receipts) {
        receipts.set(receipt.requestId, receipt);
        if (receipt.status === "settled") await saveSettledGatewayCost(directory, sessionId, receipt);
      }
    }
  } catch { signal?.throwIfAborted(); }
  return receipts;
}
