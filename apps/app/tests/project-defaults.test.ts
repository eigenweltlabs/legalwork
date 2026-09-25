import { expect, test } from "bun:test";
import type { ProjectDetails, ProjectField } from "@legalwork/types/workspace";
import { defaultAkteFields, emptyProjectFields, localizedProjectFields, projectFieldLabel, useProjectDefaultsStore, withInitialProjectFields } from "../src/react-app/domains/workspace/project-defaults-store";

test("untouched projects inherit optional defaults while saved schemas, values and removals are preserved", () => {
  const defaults: ProjectField[] = [{ id: "client", label: "Client", type: "text", value: "Never copy a value" }];
  const untouched: ProjectDetails = { version: 1, revision: 0, fields: [] };
  expect(withInitialProjectFields(untouched, defaults)).toEqual({
    ...untouched, fields: [{ ...defaults[0], value: null }],
  });
  expect(untouched.fields).toEqual([]);
  expect(withInitialProjectFields(untouched, []).fields).toEqual([]);
  const configured: ProjectDetails = { version: 1, revision: 2, fields: [{ ...defaults[0], label: "My client", value: "Acme" }] };
  expect(withInitialProjectFields(configured, defaults)).toBe(configured);
  const cleared: ProjectDetails = { version: 1, revision: 3, fields: [] };
  expect(withInitialProjectFields(cleared, defaults)).toBe(cleared);
  const existing: ProjectDetails = { ...configured, revision: 0 };
  expect(withInitialProjectFields(existing, defaults)).toBe(existing);
});

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

test("suggested labels map between English and German without changing values or options", () => {
  const german: ProjectField = { id: "client", label: "Mandant", labelSource: "suggested", type: "text", value: "Acme" };
  expect(projectFieldLabel(german, "en")).toBe("Client");
  expect(projectFieldLabel(german, "de")).toBe("Mandant");
  const localized = localizedProjectFields([german], "en");
  expect(localized[0]).toEqual({ ...german, label: "Client" });
  expect(localizedProjectFields(localized, "de")[0]).toEqual(german);
  expect(german.label).toBe("Mandant");
});

test("legacy saved presets map only when their id and original label match", () => {
  const legacy: ProjectField = { id: "client", label: "Mandant", type: "text", value: null };
  expect(projectFieldLabel(legacy, "en")).toBe("Client");
  expect(localizedProjectFields([legacy], "en")[0].labelSource).toBe("suggested");
  expect(projectFieldLabel({ ...legacy, id: "custom-client" }, "en")).toBe("Mandant");
  expect(projectFieldLabel({ ...legacy, label: "My client" }, "de")).toBe("My client");
  expect(projectFieldLabel({ ...legacy, labelSource: "custom" }, "en")).toBe("Mandant");
  expect(localizedProjectFields([{ ...legacy, labelSource: "custom" }], "en")[0].label).toBe("Mandant");
});
