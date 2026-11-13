import { expect, test } from "bun:test";
import { z } from "zod";
import { toolValidationFeedback } from "./tool-validation-feedback.js";

const invalidView = JSON.stringify([{ code: "invalid_value", path: ["view"], message: "Invalid option" }]);
test("uses the actual Word schema without an allowlist and rejects response-validation errors", async () => {
  const feedback = toolValidationFeedback();
  await feedback.definition({ toolID: "inapp_docx_read_document" }, {
    description: "Read the current Word draft. Choose a view and page through paragraphs.",
    jsonSchema: { type: "object", properties: { path: { type: "string" }, view: { enum: ["all", "text", "structure", "formatting"] }, fromIndex: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1 } }, required: ["path"] },
  });
  const hint = feedback.failure("inapp_docx_read_document", { path: "test.docx", view: "wrong" }, invalidView);
  expect(hint).toContain("view"); expect(hint).toContain("formatting"); expect(hint).toContain("current Word draft");
  expect(feedback.failure("inapp_docx_read_document", { path: "test.docx", view: "text" }, invalidView)).toBeUndefined();
  expect(feedback.failure("inapp_docx_read_document", { path: "test.docx", view: "wrong" }, "HTTP 503: service unavailable")).toBeUndefined();
});
test("native engine validation qualifies even when schema features cannot be converted", async () => {
  const feedback = toolValidationFeedback();
  const error = "The read tool was called with invalid arguments: filePath must be a string.\nPlease rewrite the input so it satisfies the expected schema.";
  expect(feedback.failure("read", { filePath: 42 }, error)).toContain("filePath must be a string");
  expect(feedback.failure("other", { filePath: 42 }, error)).toBeUndefined();
  expect(feedback.failure("read", {}, "Permission denied")).toBeUndefined();
});
test("MCP Invalid params becomes a validation failure while remote errors retain their behavior", async () => {
  const feedback = toolValidationFeedback();
  const invalid = { isError: true, content: [{ type: "text", text: 'MCP error -32602: limit must be at least 1' }] };
  await expect(feedback.result({ tool: "external_search" }, invalid)).rejects.toThrow("called with invalid arguments");
  await expect(feedback.result({ tool: "external_search" }, { isError: true, content: [{ type: "text", text: "HTTP 503: unavailable" }] })).resolves.toBeUndefined();
  await expect(feedback.result({ tool: "external_search" }, { isError: false, content: invalid.content })).resolves.toBeUndefined();
  expect(feedback.failure("external_search", {}, 'MCP error -32602: limit must be at least 1')).toContain("limit must be at least 1");
  const bounds = { isError: true, content: [{ type: "text", text: JSON.stringify([{ code: "too_small", path: ["limit"], minimum: 1, message: "limit must be at least 1" }]) }] };
  await expect(feedback.result({ tool: "external_search", args: { limit: 0 } }, bounds)).rejects.toThrow("limit must be at least 1");
  await expect(feedback.result({ tool: "external_search", args: { limit: 2 } }, bounds)).resolves.toBeUndefined();
});
test("bare validation-looking text from an unknown tool is not sufficient to stop a run", () => {
  const feedback = toolValidationFeedback();
  expect(feedback.failure("unknown", {}, invalidView)).toBeUndefined();
  expect(feedback.failure("unknown", {}, "Invalid input while parsing the service response")).toBeUndefined();
});

test("runtime bounds still guide all tools when the engine omits them from JSON Schema", async () => {
  const feedback = toolValidationFeedback();
  await feedback.definition({ toolID: "another_reader" }, { description: "Read from a nonnegative index.", jsonSchema: { type: "object", properties: { fromIndex: { type: "number" } } } });
  const error = JSON.stringify([{ code: "too_small", minimum: 0, inclusive: true, path: ["fromIndex"], message: "fromIndex must be at least 0" }]);
  expect(feedback.failure("another_reader", { fromIndex: -1 }, error)).toContain("at least 0");
  expect(feedback.failure("another_reader", { fromIndex: 1 }, error)).toBeUndefined();
});

test("uses runtime Zod schemas directly, including constraints absent from JSON Schema", async () => {
  const feedback = toolValidationFeedback();
  await feedback.definition({ toolID: "custom_tool" }, { description: "Use an even count.", parameters: z.object({ count: z.number().refine(value => value % 2 === 0, "count must be even") }) });
  const error = JSON.stringify([{ code: "custom", path: ["count"], message: "count must be even" }]);
  expect(feedback.failure("custom_tool", { count: 3 }, error)).toContain("count must be even");
  expect(feedback.failure("custom_tool", { count: 4 }, error)).toBeUndefined();
});
