import type { UsageControlAction, UsageControlView } from "@legalwork/types/usage-control";
import type en from "@/i18n/locales/en";

export type UsageTransport = { read: () => Promise<UsageControlView>; write: (action: UsageControlAction) => Promise<unknown>; open: (url: string) => void | Promise<void> };
export type Run = (action: UsageControlAction) => Promise<unknown>;
export type UsageTextKey = Extract<keyof typeof en, `limits.${string}`>;
export type Text = (key: UsageTextKey) => string;

export function parseUsageAmount(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(raw)) throw new Error("amount");
  const result = Math.round(Number(raw.replace(",", ".")) * 100);
  if (!Number.isSafeInteger(result) || result < 0 || result > 5_000_000) throw new Error("amount");
  return result;
}

export function responseUrl(value: unknown) {
  if (typeof value !== "object" || value === null || !("url" in value) || typeof value.url !== "string") throw new Error("response");
  const url = new URL(value.url);
  if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com") throw new Error("checkout");
  return url.toString();
}
