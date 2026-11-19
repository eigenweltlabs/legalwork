import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { defaultBackOfficeModel } from "@legalwork/types/back-office";
import { setLocale, t } from "../src/i18n";
import { backOfficeOptionLabel, displayBackOfficeObject } from "../src/react-app/domains/back-office/labels";

afterEach(() => setLocale("en"));

test("shipped German matter names follow the selected language in create actions", () => {
  const matter = { ...defaultBackOfficeModel().objects[0], label: "Akte", plural: "Akten" };
  setLocale("en");
  expect(t("back_office.create.title", { name: displayBackOfficeObject(matter).label })).toBe("Create Matter");
  setLocale("de");
  expect(t("back_office.create.title", { name: displayBackOfficeObject(matter).label })).toBe("Akte erstellen");
  expect(matter.label).toBe("Akte");
});

test("matter fields translate for display without changing stored choices or firm customizations", () => {
  const matter = defaultBackOfficeModel().objects[0];
  const before = structuredClone(matter);
  setLocale("de");
  const displayed = displayBackOfficeObject(matter);
  expect(displayed.fields.find(field => field.id === "fileNumber")?.label).toBe("Aktenzeichen");
  expect(displayed.fields.find(field => field.id === "clients")?.label).toBe("Mandanten");
  expect(displayed.fields.find(field => field.id === "status")?.options).toEqual(["Intake", "Active", "On hold", "Closed"]);
  expect(matter).toEqual(before);
  const customized = { ...matter, label: "Our case", plural: "Our cases", fields: matter.fields.map(field => field.id === "fileNumber" ? { ...field, label: "Our reference" } : field) };
  const customDisplay = displayBackOfficeObject(customized);
  expect(customDisplay.label).toBe("Our case");
  expect(customDisplay.plural).toBe("Our cases");
  expect(customDisplay.fields.find(field => field.id === "fileNumber")?.label).toBe("Our reference");
  const customObject = { ...customized, id: "custom_cases", label: "Akte" };
  setLocale("en");
  expect(displayBackOfficeObject(customObject)).toBe(customObject);
});

test("default choices translate while saved keys and customized choice lists stay literal", () => {
  const matter = defaultBackOfficeModel().objects[0];
  setLocale("de");
  const status = displayBackOfficeObject(matter).fields.find(field => field.id === "status")!;
  expect(backOfficeOptionLabel(status, "Active")).toBe("Aktiv");
  expect(backOfficeOptionLabel(status, "On hold")).toBe("Pausiert");
  expect(backOfficeOptionLabel({ ...status, options: ["Our status", "Active"] }, "Active")).toBe("Active");
  expect(backOfficeOptionLabel({ ...status, label: "Our workflow" }, "Active")).toBe("Active");
  setLocale("en");
  expect(backOfficeOptionLabel(status, "Active")).toBe("Active");
});

test("matter screens switch language and save canonical values without rewriting model labels", () => {
  const result = Bun.spawnSync([process.execPath, fileURLToPath(new URL("./fixtures/back-office-translations.tsx", import.meta.url))], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  expect(new TextDecoder().decode(result.stdout)).toContain("Bilingual matter flow passed");
}, 30_000);
