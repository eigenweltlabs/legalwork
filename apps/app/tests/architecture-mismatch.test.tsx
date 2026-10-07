/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ArchitectureMismatchGate } from "../src/react-app/shell/architecture-mismatch-gate";
import { t } from "../src/i18n";

test("the workspace renders before the architecture check has completed", () => {
  const html = renderToStaticMarkup(<ArchitectureMismatchGate><main>Workspace ready</main></ArchitectureMismatchGate>);
  expect(html).toContain("<main>Workspace ready</main>");
});

test("architecture advice interpolates human-readable platform labels", () => {
  const body = t("architecture.performance_body", { appArch: "x64", systemArch: "ARM64", platform: "Windows" });
  expect(body).toContain("x64");
  expect(body).toContain("ARM64 Windows");
  expect(body).not.toContain("{");
});
