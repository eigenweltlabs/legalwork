/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OcrDownloadProgress } from "../src/react-app/domains/settings/pages/ocr-settings-section";

test("OCR progress shows the current file's transferred bytes and an accessible progress bar", () => {
  const html = renderToStaticMarkup(<OcrDownloadProgress download={{ received: 500_000_000, total: 1_000_000_000 }} />);
  expect(html).toContain("Current file: 500 MB of 1 GB");
  expect(html).toContain('role="progressbar"');
  expect(html).toContain('aria-valuenow="50"');
  expect(html).toContain('aria-label="Downloading model files…"');
});
