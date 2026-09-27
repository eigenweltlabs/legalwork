import type { ProjectField } from "@legalwork/types/workspace";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { localizedProjectFields, projectFieldLabel } from "./project-defaults-store";

export type FilterOperator = "contains" | "not_contains" | "is" | "is_not" | "starts_with" | "gt" | "gte" | "lt" | "lte" | "between" | "before" | "after" | "today" | "past_7" | "past_30" | "next_7" | "next_30" | "empty" | "not_empty";
export type ProjectFilterField = {
  key: string;
  label: string;
  type: ProjectField["type"];
  options: Array<{ value: string; count: number }>;
};
export type ProjectFilter = {
  id: string;
  field: Pick<ProjectFilterField, "key" | "label" | "type">;
  operator: FilterOperator;
  values: string[];
};
export type ProjectFilterMode = "all" | "any";

const normalize = (value: string) => value.normalize("NFC").trim().toLowerCase();

/** Presets have stable identities across languages; custom fields with the same
 * name and type can be filtered together even when created independently. */
export function projectFilterFieldKey(field: ProjectField) {
  const source = field.labelSource ?? localizedProjectFields([field])[0].labelSource;
  return JSON.stringify([source === "suggested" ? "suggested" : "custom", source === "suggested" ? field.id : normalize(field.label), field.type]);
}

export function collectProjectFilterFields(projects: ProjectField[][]): ProjectFilterField[] {
  const fields = new Map<string, ProjectFilterField>();
  for (const project of projects) {
    const seen = new Set<string>();
    for (const field of project) {
      const key = projectFilterFieldKey(field);
      let entry = fields.get(key);
      if (!entry) {
        entry = { key, label: projectFieldLabel(field), type: field.type, options: [] };
        fields.set(key, entry);
      }
      if (field.type !== "select" && field.type !== "text") continue;
      for (const value of [...(field.options ?? []), ...(typeof field.value === "string" && field.value.trim() ? [field.value] : [])]) {
        let option = entry.options.find(option => option.value === value);
        if (!option) { option = { value, count: 0 }; entry.options.push(option); }
        const seenKey = JSON.stringify([key, value]);
        if (field.value === value && !seen.has(seenKey)) { option.count++; seen.add(seenKey); }
      }
    }
  }
  return [...fields.values()].map(field => ({ ...field, options: field.options.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)) }));
}

export function filterOperators(type: ProjectField["type"]): FilterOperator[] {
  const empty: FilterOperator[] = ["empty", "not_empty"];
  if (type === "text") return ["contains", "not_contains", "is", "is_not", "starts_with", ...empty];
  if (type === "number") return ["is", "is_not", "gt", "gte", "lt", "lte", "between", ...empty];
  if (type === "date") return ["is", "before", "after", "between", "today", "past_7", "past_30", "next_7", "next_30", ...empty];
  return ["is", "is_not", ...empty];
}

export function filterNeedsValue(operator: FilterOperator) {
  return !["empty", "not_empty", "today", "past_7", "past_30", "next_7", "next_30"].includes(operator);
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function validProjectFilter(filter: ProjectFilter) {
  if (!filterOperators(filter.field.type).includes(filter.operator)) return false;
  if (!filterNeedsValue(filter.operator)) return true;
  const values = filter.values;
  if (!values.length || values.some(value => !value.trim())) return false;
  if (filter.operator === "between" && values.length !== 2) return false;
  if (filter.operator !== "between" && filter.field.type !== "select" && values.length !== 1) return false;
  if (filter.field.type === "number" && values.some(value => !Number.isFinite(Number(value)))) return false;
  if (filter.field.type === "date" && values.some(value => !validDate(value))) return false;
  if (filter.operator === "between") return filter.field.type === "number" ? Number(values[0]) <= Number(values[1]) : values[0] <= values[1];
  return true;
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function valueMatches(value: string | number, filter: ProjectFilter, now: Date): boolean {
  const [first, last] = filter.values;
  const text = normalize(String(value));
  switch (filter.operator) {
    case "empty": return false;
    case "not_empty": return true;
    case "contains": return text.includes(normalize(first));
    case "not_contains": return !text.includes(normalize(first));
    case "starts_with": return text.startsWith(normalize(first));
    case "is": case "is_not": {
      const matches = filter.values.some(expected => filter.field.type === "number" ? value === Number(expected) : text === normalize(expected));
      return filter.operator === "is" ? matches : !matches;
    }
    case "gt": return typeof value === "number" && value > Number(first);
    case "gte": return typeof value === "number" && value >= Number(first);
    case "lt": return typeof value === "number" && value < Number(first);
    case "lte": return typeof value === "number" && value <= Number(first);
    case "before": return String(value) < first;
    case "after": return String(value) > first;
    case "between": return filter.field.type === "number"
      ? typeof value === "number" && value >= Number(first) && value <= Number(last)
      : String(value) >= first && String(value) <= last;
    default: {
      const today = dateKey(now);
      if (filter.operator === "today") return value === today;
      const days = filter.operator.endsWith("7") ? 7 : 30;
      const past = filter.operator.startsWith("past");
      const boundary = new Date(now);
      boundary.setDate(boundary.getDate() + (past ? -(days - 1) : days));
      // Past windows include today. Next windows start tomorrow.
      return past ? String(value) >= dateKey(boundary) && String(value) <= today : String(value) > today && String(value) <= dateKey(boundary);
    }
  }
}

export function matchesProjectFilters(fields: ProjectField[], filters: ProjectFilter[], mode: ProjectFilterMode, now = new Date()) {
  if (!filters.length) return true;
  const valuesByField = new Map<string, Array<string | number>>();
  for (const field of fields) {
    if (field.value === null || (typeof field.value === "string" && !field.value.trim())) continue;
    const key = projectFilterFieldKey(field);
    const values = valuesByField.get(key) ?? [];
    values.push(field.value);
    valuesByField.set(key, values);
  }
  const match = (filter: ProjectFilter) => {
    if (!validProjectFilter(filter)) return false;
    const values = valuesByField.get(filter.field.key) ?? [];
    if (filter.operator === "empty") return !values.length;
    // Missing metadata is not an explicit negative value.
    if (!values.length) return false;
    return filter.operator === "is_not" || filter.operator === "not_contains"
      ? values.every(value => valueMatches(value, filter, now))
      : values.some(value => valueMatches(value, filter, now));
  };
  return mode === "all" ? filters.every(match) : filters.some(match);
}

type FilterStore = {
  filters: ProjectFilter[];
  mode: ProjectFilterMode;
  descending: boolean;
  views: ProjectView[];
  activeViewId: string | null;
  setFilters: (filters: ProjectFilter[]) => void;
  setMode: (mode: ProjectFilterMode) => void;
  setDescending: (descending: boolean) => void;
  selectView: (id: string | null) => void;
  saveView: (name: string) => void;
  updateView: () => void;
  renameView: (id: string, name: string) => void;
  deleteView: (id: string) => void;
  clear: () => void;
};

export type ProjectView = {
  id: string;
  name: string;
  filters: ProjectFilter[];
  mode: ProjectFilterMode;
  descending: boolean;
};

export function projectViewHasChanges(view: ProjectView, state: Pick<FilterStore, "filters" | "mode" | "descending">) {
  const conditions = (filters: ProjectFilter[]) => JSON.stringify(filters.map(({ field, operator, values }) => ({ key: field.key, operator, values })));
  return view.mode !== state.mode || view.descending !== state.descending || conditions(view.filters) !== conditions(state.filters);
}

export const useProjectFilterStore = create<FilterStore>()(persist((set, get) => ({
  filters: [], mode: "all", descending: true, views: [], activeViewId: null,
  setFilters: filters => set({ filters }),
  setMode: mode => set({ mode }),
  setDescending: descending => set({ descending }),
  selectView: id => {
    const view = get().views.find(view => view.id === id);
    if (id && !view) return;
    set(view ? { filters: view.filters, mode: view.mode, descending: view.descending, activeViewId: view.id } : { filters: [], mode: "all", descending: true, activeViewId: null });
  },
  saveView: name => {
    const state = get();
    const trimmed = name.trim();
    if (!trimmed || state.views.some(view => normalize(view.name) === normalize(trimmed))) return;
    const view = { id: crypto.randomUUID(), name: trimmed, filters: state.filters, mode: state.mode, descending: state.descending };
    set({ views: [...state.views, view], activeViewId: view.id });
  },
  updateView: () => set(state => ({ views: state.views.map(view => view.id === state.activeViewId ? { ...view, filters: state.filters, mode: state.mode, descending: state.descending } : view) })),
  renameView: (id, name) => set(state => {
    const trimmed = name.trim();
    if (!trimmed || state.views.some(view => view.id !== id && normalize(view.name) === normalize(trimmed))) return state;
    return { views: state.views.map(view => view.id === id ? { ...view, name: trimmed } : view) };
  }),
  deleteView: id => set(state => ({ views: state.views.filter(view => view.id !== id), activeViewId: state.activeViewId === id ? null : state.activeViewId })),
  clear: () => set({ filters: [], mode: "all" }),
}), { name: "legalwork.projectFilters.v1", partialize: ({ filters, mode, descending, views, activeViewId }) => ({ filters, mode, descending, views, activeViewId }) }));
