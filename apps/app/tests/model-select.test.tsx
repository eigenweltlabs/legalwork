import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelRef } from "../src/app/types";
import { ModelSelect } from "../src/components/model-select";

function render(value: ModelRef | null, locked = false) {
  return renderToStaticMarkup(createElement(ModelSelect, {
    value, locked, open: false, modelOptions: [], onOpenChange: () => {}, onChange: () => {},
  }));
}

test("a connected provider without a selected model has a model-picker button", () => {
  const html = render(null);
  expect(html).toContain('aria-label="Select model"');
  expect(html).toContain("<button");
  expect(html).not.toContain("Connect a model provider");
});

test("a single-model setup cannot lock an empty selection into an unclickable label", () => {
  expect(render(null, true)).toContain('aria-label="Select model"');
});

test("a selected model keeps its existing change action and locked presentation", () => {
  const model = { providerID: "azure", modelID: "deployment" };
  expect(render(model)).toContain('aria-label="Change model"');
  expect(render(model, true)).not.toContain("<button");
  expect(render(model, true)).toContain("deployment");
});
