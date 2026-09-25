// Opt-in end-to-end download into a fresh root. Retain it for native/packaging smoke tests.
import { mkdtemp, access, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OcrManager } from "../src/ocr/manager.ts";
import { ocrTestPage } from "../src/ocr/runtime.ts";

const root = await mkdtemp(join(tmpdir(), "legalwork-native-ocr-"));
console.log({ root });
process.env.LEGALWORK_OCR_UV_BIN = "/must-not-use-python-or-uv";
const manager = new OcrManager(root);
try {
  await manager.downloadDefaultIfNeeded();
  let previous = "";
  const deadline = Date.now() + 600000;
  while (manager.runtime.busy) {
    if (Date.now() > deadline) throw new Error("Setup timed out");
    const stage = manager.runtime.installation?.stage;
    if (stage !== previous) { console.log({ stage }); previous = stage ?? ""; }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  console.log(manager.runtime.installation);
  if (!await manager.runtime.ready("pp-ocrv6-small")) throw new Error("Model not ready");
  for (const name of ["venv", "installer"]) {
    if (await access(join(root, name)).then(() => true, () => false)) throw new Error("Unexpected Python installation");
  }
  const result = await (await manager.service()).extract({ sourceId: "native-smoke", pages: [await ocrTestPage()], languages: [] });
  const page = result.pages[0];
  if (!page?.text.includes("Agreement") || !page.text.includes("fällig") || !page.regions.length) throw new Error("Recognition mismatch");
  console.log({ text: page.text, regions: page.regions.length });
  const marker = join(root, "pp-ocrv6-small.ready"), before = (await stat(marker)).mtimeMs;
  await new OcrManager(root).downloadDefaultIfNeeded();
  if ((await stat(marker)).mtimeMs !== before) throw new Error("Reinstalled");
  console.log("Native setup, recognition, restart: passed");
} finally { manager.stop(); }
