import type { ProjectField } from "@legalwork/types/workspace";

export function parseProjectOptions(value: string): string[] {
  return [...new Set(value.split(",").map((option) => option.trim()).filter(Boolean))];
}

/** Reject incompatible conversions instead of silently erasing a stored value. */
export function changeProjectFieldType(field: ProjectField, type: ProjectField["type"]): ProjectField | null {
  if (field.type === type) return field;
  let value = field.value;
  if (value !== null && value !== "") {
    if (type === "number") {
      if (!String(value).trim() || !Number.isFinite(Number(value))) return null;
      value = Number(value);
    } else {
      value = String(value);
      if (type === "date") {
        const date = new Date(`${value}T00:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
      }
    }
  }
  return { ...field, type, value, options: type === "select" ? (value === null || value === "" ? [] : [String(value)]) : undefined };
}
