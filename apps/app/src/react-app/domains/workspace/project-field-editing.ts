import type { ProjectField } from "@legalwork/types/workspace";

export function parseProjectOptions(value: string): string[] {
  return [...new Set(value.split(",").map((option) => option.trim()).filter(Boolean))];
}

/** Preserve compatible values and clear incompatible ones in the draft. The editor notifies before saving. */
export function changeProjectFieldType(field: ProjectField, type: ProjectField["type"], objectId?: string): ProjectField | null {
  if (type === "backoffice") {
    if (!objectId) return null;
    if (field.type === type && field.objectId === objectId) return field;
    return { id: field.id, label: field.label, labelSource: field.labelSource, type, objectId, multiple: true, value: null };
  }
  if (field.type === type) return field;
  if (field.type === "backoffice") {
    return { id: field.id, label: field.label, labelSource: field.labelSource, type, value: null, ...(type === "select" ? { options: [] } : {}) };
  }
  let value = field.value;
  if (value !== null && value !== "") {
    if (type === "number") {
      value = String(value).trim() && Number.isFinite(Number(value)) ? Number(value) : null;
    } else {
      value = String(value);
      if (type === "date") {
        const date = new Date(`${value}T00:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) value = null;
      }
    }
  }
  return { ...field, type, value, options: type === "select" ? (value === null || value === "" ? [] : [String(value)]) : undefined };
}
