import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { defaultProjectTemplates, projectFieldsSchema, projectMatterField, withProjectMatters } from "@legalwork/types/workspace";

test("initial matter selection reuses template fields and leaves the template unchanged", () => {
  const fields = defaultProjectTemplates()[0].fields;
  const value = { directoryId: "local:fixture", recordIds: [crypto.randomUUID(), crypto.randomUUID()] };
  const initialized = projectFieldsSchema.parse(withProjectMatters(fields, value));
  expect(initialized).toHaveLength(fields.length);
  expect(initialized[0].value).toEqual(value);
  expect(fields[0].value).toBeNull();
});

test("a missing matter field is added without replacing a custom field named matter", () => {
  const fields = projectFieldsSchema.parse([{ id: "matter", label: "Internal reference", type: "text", value: "Keep me" }]);
  const value = { directoryId: "local:fixture", recordIds: [crypto.randomUUID()] };
  const initialized = projectFieldsSchema.parse(withProjectMatters(fields, value, "de"));
  expect(initialized[0]).toEqual(fields[0]);
  expect(initialized[1]).toMatchObject({ id: "matter_2", objectId: "matters", multiple: true, value });
  expect(projectMatterField([], "en").label).not.toBe(projectMatterField([], "de").label);
});

test("custom selection rules and single-record constraints stay in effect", () => {
  const fields = projectFieldsSchema.parse([{ id: "case", label: "Approved matter", type: "backoffice", objectId: "matters", multiple: false,
    filters: { mode: "all", conditions: [{ fieldId: "status", operator: "is", values: ["Active"] }] }, value: null }]);
  const value = { directoryId: "local:fixture", recordIds: [crypto.randomUUID(), crypto.randomUUID()] };
  expect(projectMatterField(fields)).toEqual(fields[0]);
  expect(() => projectFieldsSchema.parse(withProjectMatters(fields, value))).toThrow("Choose one record");
});

test("new-project matter search, multi-selection and inline creation preserve the project draft", () => {
  const result = Bun.spawnSync([process.execPath, fileURLToPath(new URL("./fixtures/project-create-matters.tsx", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  expect(new TextDecoder().decode(result.stdout)).toContain("Project matter flow passed");
}, 30_000);
