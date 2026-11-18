import { t } from "@/i18n";
import { backOfficeMajorAmount, backOfficeMoneyFromMajor, type BackOfficeField, type BackOfficeMoney, type BackOfficeValue } from "@legalwork/types/back-office";

function isCurrency(value: BackOfficeValue | undefined): value is BackOfficeMoney {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cellInputText(value: BackOfficeValue | undefined) {
  if (isCurrency(value)) return String(backOfficeMajorAmount(value));
  if (Array.isArray(value)) return value.join(", ");
  return String(value ?? "");
}

export function parseCellInput(type: BackOfficeField["type"], text: string, previous: BackOfficeValue | undefined): BackOfficeValue {
  if (!text) return null;
  if (type === "datetime") {
    const date = new Date(text);
    if (!Number.isFinite(date.getTime())) throw new Error(t("back_office.invalid_value"));
    return date.toISOString();
  }
  if (type === "boolean") return text === "true";
  if (type === "multiselect") return text.split(",").map(item => item.trim()).filter(Boolean);
  if (type !== "number" && type !== "currency") return text;

  const number = Number(text);
  if (!Number.isFinite(number)) throw new Error(t("back_office.enter_number"));
  if (type === "number") return number;
  if (isCurrency(previous) && number === backOfficeMajorAmount(previous)) return previous;
  return backOfficeMoneyFromMajor(number, isCurrency(previous) ? previous.currency : "EUR");
}
