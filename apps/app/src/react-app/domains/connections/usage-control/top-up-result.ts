import type { TopUpResult } from "@legalwork/types/usage-control";

export function parseTopUpResult(value: unknown): TopUpResult {
  if (typeof value !== "object" || value === null || !("operationId" in value) ||
      typeof value.operationId !== "string" || !("status" in value)) throw new Error("response");
  if (value.status === "requires_confirmation") {
    const balanceCents = "balanceCents" in value ? value.balanceCents : 0;
    if (!("amountCents" in value) || !("taxCents" in value) || !("totalCents" in value) ||
        typeof value.amountCents !== "number" || !Number.isSafeInteger(value.amountCents) || value.amountCents <= 0 ||
        typeof value.taxCents !== "number" || !Number.isSafeInteger(value.taxCents) || value.taxCents < 0 ||
        typeof value.totalCents !== "number" || !Number.isSafeInteger(value.totalCents) ||
        typeof balanceCents !== "number" || !Number.isSafeInteger(balanceCents) || value.totalCents < 0 ||
        value.totalCents !== value.amountCents + value.taxCents - balanceCents) throw new Error("response");
    return { status: value.status, operationId: value.operationId,
      amountCents: value.amountCents, taxCents: value.taxCents, totalCents: value.totalCents,
      ...(balanceCents ? { balanceCents } : {}) };
  }
  if (value.status === "paid" || value.status === "canceled" || value.status === "failed" || value.status === "processing")
    return { status: value.status, operationId: value.operationId };
  if (value.status === "requires_action" && "url" in value && typeof value.url === "string")
    return { status: value.status, operationId: value.operationId, url: value.url };
  throw new Error("response");
}
