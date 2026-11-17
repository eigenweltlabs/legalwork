import { appendFile, mkdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { CostTokens } from "@legalwork/types/session-cost";

const count = z.number().int().nonnegative().safe();
export const gatewayTokensSchema = z.object({ input: count, output: count, reasoning: count,
  cache: z.object({ read: count, write: count }) });
const requestSchema = z.object({
  requestId: z.string().uuid(), sessionId: z.string().min(1).max(200), modelId: z.string().min(1).max(500),
  kind: z.enum(["primary", "title", "compaction", "generate"]), createdAt: count,
  responseId: z.string().min(1).max(200).regex(/^[a-zA-Z0-9_.:-]+$/).optional(), costEur: z.number().finite().nonnegative().optional(), tokens: gatewayTokensSchema.optional(), completedAt: count.optional(),
});
export type GatewayCostRequest = z.infer<typeof requestSchema>;
export const gatewayReceiptSchema = z.object({ requestId: z.string().min(1).max(200),
  status: z.enum(["settled", "pending", "missing"]), costEur: z.number().finite().nonnegative().nullable(), source: z.enum(["gateway", "estimate"]) });
export type GatewayCostReceipt = z.infer<typeof gatewayReceiptSchema>;

function file(directory: string, sessionId: string, suffix: string) {
  return join(directory, `${createHash("sha256").update(sessionId).digest("hex")}.${suffix}.jsonl`);
}

async function append(path: string, directory: string, value: unknown) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Each small record is one O_APPEND write. The engine and HTTP server do
  // not replace each other's files or share a process-local write lock.
  await appendFile(path, JSON.stringify(value) + "\n", { mode: 0o600 });
}

async function lines(path: string) {
  try { return (await readFile(path, "utf8")).split("\n"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

/** No messages, credentials, headers or model output enter these files. */
export async function recordGatewayCostRequest(directory: string, request: GatewayCostRequest) {
  const parsed = requestSchema.parse(request);
  await append(file(directory, parsed.sessionId, "requests"), directory, parsed);
}

export async function readGatewayCostRequests(directory: string, sessionId: string) {
  const requests = new Map<string, GatewayCostRequest>();
  for (const line of await lines(file(directory, sessionId, "requests"))) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success || parsed.data.sessionId !== sessionId) continue;
    const previous = requests.get(parsed.data.requestId);
    if (previous && (previous.modelId !== parsed.data.modelId || previous.kind !== parsed.data.kind || previous.createdAt !== parsed.data.createdAt)) continue;
    requests.set(parsed.data.requestId, { ...previous, ...parsed.data });
  }
  return [...requests.values()];
}

export async function readSettledGatewayCosts(directory: string, sessionId: string) {
  const receipts = new Map<string, GatewayCostReceipt>();
  for (const line of await lines(file(directory, sessionId, "settled"))) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    const parsed = gatewayReceiptSchema.safeParse(value);
    if (parsed.success && parsed.data.status === "settled" && parsed.data.costEur !== null)
      receipts.set(parsed.data.requestId, parsed.data);
  }
  return receipts;
}

export async function saveSettledGatewayCost(directory: string, sessionId: string, receipt: GatewayCostReceipt) {
  const parsed = gatewayReceiptSchema.parse(receipt);
  if (parsed.status !== "settled" || parsed.costEur === null) throw new Error("Only settled gateway costs can be persisted.");
  await append(file(directory, sessionId, "settled"), directory, parsed);
}

/** OpenAI-compatible usage totals include cached input and reasoning output. */
export function gatewayWireTokens(value: unknown): CostTokens | undefined {
  const wire = z.object({ prompt_tokens: count, completion_tokens: count,
    prompt_tokens_details: z.object({ cached_tokens: count.optional(), cache_write_tokens: count.optional(), cache_creation_tokens: count.optional() }).optional(),
    completion_tokens_details: z.object({ reasoning_tokens: count.optional() }).optional() }).safeParse(value);
  if (!wire.success) return undefined;
  const usage = wire.data, read = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const write = usage.prompt_tokens_details?.cache_write_tokens ?? usage.prompt_tokens_details?.cache_creation_tokens ?? 0;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? 0;
  if (read + write > usage.prompt_tokens || reasoning > usage.completion_tokens) return undefined;
  return { input: usage.prompt_tokens - read - write, output: usage.completion_tokens - reasoning,
    reasoning, cache: { read, write } };
}
