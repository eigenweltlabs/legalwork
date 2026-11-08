import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MigrationProgressView } from "../src/react-app/shell/migration-progress";

test("migration screen shows measured step progress and an explicit keep-open instruction", () => {
  const html = renderToStaticMarkup(createElement(MigrationProgressView, { progress: {
    status: "running", phase: "copying", project: { name: "Acme", index: 2, total: 5 },
    work: { completed: 3, total: 12, unit: "files" }, deferredProjects: 0,
  } }));
  expect(html).toContain('role="progressbar"');
  expect(html).toContain('aria-valuenow="25"');
  expect(html).toContain("Project 2 of 5");
  expect(html).toContain("3 of 12 files");
  expect(html).toContain("25% of this step");
  expect(html).toContain("Do not quit the app until migration finishes.");
});

test("an unknown total shows actual processed work without an invented percentage", () => {
  const html = renderToStaticMarkup(createElement(MigrationProgressView, { progress: {
    status: "running", phase: "inspecting", work: { completed: 1024, unit: "bytes" }, deferredProjects: 0,
  } }));
  expect(html).toContain('role="progressbar"');
  expect(html).not.toContain("aria-valuenow");
  expect(html).toContain("1 KB checked");
});
