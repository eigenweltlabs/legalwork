import { expect, test } from "bun:test";
import { defaultAkteFields, emptyProjectFields, useProjectDefaultsStore } from "../src/react-app/domains/workspace/project-defaults-store";

test("Akte defaults start empty and every new project's values and options are independent", () => {
  const template = defaultAkteFields();
  expect(template.length).toBe(10);
  expect(new Set(template.map((field) => field.id)).size).toBe(template.length);
  expect(template.every((field) => field.value === null)).toBe(true);
  const customized = template.map((field) => ({ ...field, value: "old value" }));
  const first = emptyProjectFields(customized);
  const second = emptyProjectFields(customized);
  first[0].value = "Client A";
  first.find((field) => field.options)?.options?.push("Custom state");
  expect(second.every((field) => field.value === null)).toBe(true);
  expect(second.find((field) => field.options)?.options).not.toContain("Custom state");
  expect(customized.every((field) => field.value === "old value")).toBe(true);
  expect(emptyProjectFields([])).toEqual([]);
});


test("saving a project field to defaults preserves the template and excludes project values", () => {
  const store = useProjectDefaultsStore.getState();
  store.setFields([{ id: "client", label: "Mandant", type: "text", value: null }]);
  store.addField({ id: "custom", label: "Priority", type: "select", options: ["High", "Low"], value: "High" });
  store.addField({ id: "custom", label: "Duplicate", type: "text", value: null });
  expect(useProjectDefaultsStore.getState().fields).toEqual([
    { id: "client", label: "Mandant", type: "text", value: null },
    { id: "custom", label: "Priority", type: "select", options: ["High", "Low"], value: null },
  ]);
  store.reset();
});
