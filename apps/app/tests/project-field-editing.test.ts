import { expect, test } from "bun:test";
import type { ProjectField } from "@legalwork/types/workspace";
import { changeProjectFieldType, parseProjectOptions } from "../src/react-app/domains/workspace/project-field-editing";

const field: ProjectField = { id: "reference", label: "Reference", type: "text", value: "Acme" };

test("changing metadata types keeps compatible values and refuses data loss", () => {
  expect(changeProjectFieldType(field, "number")).toBeNull();
  expect(changeProjectFieldType(field, "date")).toBeNull();
  expect(field.value).toBe("Acme");
  expect(changeProjectFieldType(field, "select")).toEqual({ ...field, type: "select", options: ["Acme"] });
  expect(changeProjectFieldType({ ...field, value: "125.50" }, "number")?.value).toBe(125.5);
  expect(changeProjectFieldType({ ...field, type: "number", value: 125.5 }, "text")?.value).toBe("125.5");
  expect(changeProjectFieldType({ ...field, value: "2026-02-30" }, "date")).toBeNull();
  expect(changeProjectFieldType({ ...field, value: "2026-09-24" }, "date")?.value).toBe("2026-09-24");
  expect(changeProjectFieldType({ ...field, value: null }, "number")?.value).toBeNull();
});

test("selection choices normalize complete input without losing a trailing new choice", () => {
  expect(parseProjectOptions(" Open, Closed, Open , Pending")).toEqual(["Open", "Closed", "Pending"]);
  expect(parseProjectOptions(" , ")).toEqual([]);
});
