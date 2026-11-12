import type { BackOfficeField, BackOfficeValue } from "@legalwork/types/back-office";

function isCurrency(value: BackOfficeValue | undefined): value is Extract<BackOfficeValue, { amountMinor: number }> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cellInputText(value: BackOfficeValue | undefined) {
  if (isCurrency(value)) return String(value.amountMinor / 100);
  if (Array.isArray(value)) return value.join(", ");
  return String(value ?? "");
}

export function parseCellInput(type: BackOfficeField["type"], text: string, previous: BackOfficeValue | undefined): BackOfficeValue {
  if (!text) return null;
  if (type === "boolean") return text === "true";
  if (type === "multiselect") return text.split(",").map(item => item.trim()).filter(Boolean);
  if (type !== "number" && type !== "currency") return text;

  const number = Number(text);
  if (!Number.isFinite(number)) throw new Error("Enter a number.");
  if (type === "number") return number;
  return { amountMinor: Math.round(number * 100), currency: isCurrency(previous) ? previous.currency : "EUR" };
}
