import { afterEach, expect, spyOn, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OcrManager } from "./manager.js";
import { resolveServerConfig } from "../config.js";
import { startServer } from "../server.js";

const roots: string[] = [];
const originalAuto = process.env.LEGALWORK_OCR_AUTO_DOWNLOAD;
const originalDb = process.env.LEGALWORK_RUNTIME_DB;
afterEach(async () => {
  for (const [key, value] of Object.entries({ LEGALWORK_OCR_AUTO_DOWNLOAD: originalAuto, LEGALWORK_RUNTIME_DB: originalDb })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "ocr-auto-")); roots.push(root);
  const manager = new OcrManager(root);
  const install = spyOn(manager.runtime, "install").mockImplementation(async engine => { manager.runtime.installation = { engineId: engine.id, stage: "complete" }; });
  return { root, manager, install };
}

test("automatically provisions only the small default, once per launch, preserving settings", async () => {
  const { manager, install } = await setup();
  const before = await manager.store.read();
  await Promise.all([manager.downloadDefaultIfNeeded(), manager.downloadDefaultIfNeeded()]);
  expect(install).toHaveBeenCalledTimes(1);
  expect(install.mock.calls[0]![0]).toMatchObject({ id: "local-fast", model: "pp-ocrv6-small" });
  expect(await manager.store.read()).toEqual(before);
  expect((await manager.view()).installation?.stage).toBe("complete");
});

test("does not redownload a ready model or install when another model is selected", async () => {
  for (const selected of ["ready", "local-quality", "custom"]) {
    const { manager, install } = await setup();
    if (selected === "ready") spyOn(manager.runtime, "ready").mockResolvedValue(true);
    else if (selected === "local-quality") await manager.store.write({ ...await manager.store.read(), defaultEngineId: selected });
    else {
      const id = await manager.saveServer({ label: "Custom", endpoint: "http://localhost:8000/ocr", kind: "paddleocr", authentication: "none", model: "OCR", languages: null });
      await manager.setDefault(id);
    }
    await manager.downloadDefaultIfNeeded(); expect(install).not.toHaveBeenCalled();
  }
});

test("cancelling preflight persists across launches, while explicit download retries clear cancellation", async () => {
  const { root, manager, install } = await setup();
  let release!: (ready: boolean) => void;
  const pendingReady = new Promise<boolean>(resolve => { release = resolve; });
  spyOn(manager.runtime, "ready").mockImplementation(() => pendingReady);
  const automatic = manager.downloadDefaultIfNeeded();
  await manager.cancelInstall(); release(false); await automatic;
  expect(install).not.toHaveBeenCalled();
  expect((await manager.view()).installation?.stage).toBe("cancelled");
  const restarted = new OcrManager(root), restartedInstall = spyOn(restarted.runtime, "install").mockResolvedValue();
  await restarted.downloadDefaultIfNeeded(); expect(restartedInstall).not.toHaveBeenCalled();
  await restarted.install("local-fast"); expect(restartedInstall).toHaveBeenCalledTimes(1);
  expect(await access(join(root, "auto-download-cancelled")).then(() => true, () => false)).toBe(false);
});

test("shutdown stops a pending automatic start without recording a user cancellation", async () => {
  const { root, manager, install } = await setup();
  const run = manager.downloadDefaultIfNeeded(); manager.stop(); await run;
  expect(install).not.toHaveBeenCalled();
  expect(await access(join(root, "auto-download-cancelled")).then(() => true, () => false)).toBe(false);
  const restarted = new OcrManager(root), next = spyOn(restarted.runtime, "install").mockResolvedValue();
  await restarted.downloadDefaultIfNeeded(); expect(next).toHaveBeenCalledTimes(1);
});

test("automatic setup failures are visible and do not continuously retry", async () => {
  const { manager, install } = await setup(); install.mockRejectedValue(new Error("offline"));
  await manager.downloadDefaultIfNeeded(); await manager.downloadDefaultIfNeeded();
  expect(install).toHaveBeenCalledTimes(1); expect((await manager.view()).installation).toEqual({ engineId: "local-fast", stage: "failed" });
  install.mockResolvedValue(); await manager.install("local-fast"); expect(install).toHaveBeenCalledTimes(2);
});

test("resolved config enables automatic setup by default, with file and environment opt-out", async () => {
  const { root } = await setup(), configPath = join(root, "server.json");
  delete process.env.LEGALWORK_OCR_AUTO_DOWNLOAD;
  await writeFile(configPath, "{}");
  expect((await resolveServerConfig({ configPath, workspaces: [] })).autoDownloadOcr).toBe(true);
  await writeFile(configPath, JSON.stringify({ autoDownloadOcr: false }));
  expect((await resolveServerConfig({ configPath, workspaces: [] })).autoDownloadOcr).toBe(false);
  process.env.LEGALWORK_OCR_AUTO_DOWNLOAD = "1";
  expect((await resolveServerConfig({ configPath, workspaces: [] })).autoDownloadOcr).toBe(true);
  process.env.LEGALWORK_OCR_AUTO_DOWNLOAD = "0";
  expect((await resolveServerConfig({ configPath, workspaces: [] })).autoDownloadOcr).toBe(false);
});

test("server startup schedules setup without awaiting downloads and skips read-only/disabled hosts", async () => {
  const { root } = await setup();
  process.env.LEGALWORK_RUNTIME_DB = join(root, "runtime.sqlite");
  const pending = new Promise<void>(() => {});
  const automatic = spyOn(OcrManager.prototype, "downloadDefaultIfNeeded").mockImplementation(() => pending);
  try {
    for (const { readOnly, enabled } of [{ readOnly: false, enabled: true }, { readOnly: true, enabled: true }, { readOnly: false, enabled: false }]) {
      const config = await resolveServerConfig({ configPath: join(root, "server.json"), workspaces: [], port: 0, readOnly });
      config.autoDownloadOcr = enabled;
      const server = await startServer(config);
      expect(automatic).toHaveBeenCalledTimes(1);
      expect((await fetch(`http://127.0.0.1:${server.port}/health`)).ok).toBe(true);
      await server.stop();
    }
  } finally { automatic.mockRestore(); }
});
