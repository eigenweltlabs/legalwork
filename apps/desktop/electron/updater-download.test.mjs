import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";

const { AppUpdater } = createRequire(import.meta.url)("electron-updater/out/AppUpdater.js");
// This file runs in its own test process. Simulate the Windows boundary so no
// native installer, Squirrel preferences, or real app cache is touched.
Object.defineProperty(process, "platform", { value: "win32" });
const updaterKey = Symbol.for("legalwork.test.updater");
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "electron-updater") {
    return {
      url: 'data:text/javascript,export default {get autoUpdater(){return globalThis[Symbol.for("legalwork.test.updater")]}}',
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
} });

const releases = [
  { tag: "v4.0.0-beta.2", version: "4.0.0-beta.2", prerelease: false },
  { tag: `alpha-windows-${process.arch}-v5.0.0-alpha.7-abcdef1`, version: "5.0.0-alpha.7.gabcdef1", prerelease: true },
];
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify(releases.map((release, id) => ({
  tag_name: release.tag, id, published_at: "2026-10-31T00:00:00Z", draft: false,
  prerelease: release.prerelease,
  assets: ["latest.yml", "latest-arm64.yml", `legalwork-win-${process.arch}-${release.version}.exe`]
    .map((name) => ({ name, state: "uploaded", size: 10 })),
}))));
// The real release resolver captures only this simulated metadata transport.
const { registerUpdaterIpc } = await import("./updater.mjs");
globalThis.fetch = originalFetch;

async function downloadAfterWebsiteFailure(channel, failure = "none", { checkFirst = true, websiteCheckFails = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "legalwork-download-fallback-"));
  const { version, tag } = releases[channel === "alpha" ? 1 : 0];
  const githubFeed = `https://github.com/eigenweltlabs/legalwork/releases/download/${tag}`;
  const trace = [];
  try {
    await writeFile(path.join(root, "electron-updater-channel.v1.json"), JSON.stringify({ channel }));
    const app = { isPackaged: true, version: "3.0.0", name: "LegalWork", userDataPath: root,
      baseCachePath: root, appUpdateConfigPath: path.join(root, "app-update.yml"),
      whenReady: async () => {}, relaunch() {}, quit() {}, onQuit() {},
      getVersion: () => "3.0.0", getPath: () => root,
    };
    const updater = new AppUpdater(undefined, app);
    updater.logger = { info() {}, warn() {}, error() {} };
    updater.httpExecutor = { request: async (options) => {
      const url = `${options.protocol}//${options.hostname}${options.path}`;
      trace.push({ action: "check", url });
      const website = options.hostname === "eigenweltlabs.com";
      if ((website && websiteCheckFails) || (!website && failure === "manifest-error")) throw new Error("Manifest unavailable");
      const returnedVersion = url.includes("/latest/download/") || (!website && failure === "mismatch") ? "3.5.0" : version;
      const staging = !website && failure === "ineligible" ? 0 : 100;
      return `version: ${returnedVersion}\nstagingPercentage: ${staging}\nfiles:\n  - url: legalwork-win-${process.arch}-${returnedVersion}.exe\n    sha512: abc\n    size: 10\n`;
    } };
    updater.doDownloadUpdate = async ({ updateInfoAndProvider: { info, provider } }) => {
      const url = provider.resolveFiles(info)[0].url.href;
      trace.push({ action: "download", url, version: info.version });
      if (url.startsWith("https://eigenweltlabs.com") || failure === "download-error") throw new Error("Installer unavailable");
      return [path.join(root, "installer.exe")];
    };
    globalThis[updaterKey] = updater;
    const handlers = new Map();
    registerUpdaterIpc({ app, ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, getMainWindow: () => null });
    if (checkFirst) {
      const check = await handlers.get("legalwork:updater:check")({}, channel);
      assert.equal(check.available, true);
      assert.equal(check.latestVersion, version);
    }
    const result = await handlers.get("legalwork:updater:download")({});
    return { result, trace, version, githubFeed, autoInstallOnAppQuit: updater.autoInstallOnAppQuit };
  } finally {
    delete globalThis[updaterKey];
    await rm(root, { recursive: true, force: true });
  }
}

for (const channel of ["stable", "prerelease", "alpha"]) {
  for (const checkFirst of [true, false]) {
    it(`retries the selected ${channel} installer on GitHub after a website failure (prior check=${checkFirst})`, async () => {
      const { result, trace, version, githubFeed, autoInstallOnAppQuit } = await downloadAfterWebsiteFailure(channel, "none", { checkFirst });
      assert.deepEqual(result, { ok: true });
      const downloads = trace.filter((entry) => entry.action === "download");
      assert.equal(downloads.length, 2);
      assert.ok(downloads[0].url.startsWith("https://eigenweltlabs.com/legalwork/update/releases/"));
      assert.equal(downloads[1].url, `${githubFeed}/legalwork-win-${process.arch}-${version}.exe`);
      assert.deepEqual(downloads.map((entry) => entry.version), [version, version]);
      assert.ok(trace.every((entry) => !entry.url.includes("/latest/download/")));
      assert.equal(autoInstallOnAppQuit, true);
    });
  }
  for (const failure of ["mismatch", "ineligible", "manifest-error", "download-error"]) {
    it(`does not substitute Latest when ${channel} download recovery encounters ${failure}`, async () => {
      const { result, trace, autoInstallOnAppQuit } = await downloadAfterWebsiteFailure(channel, failure);
      assert.equal(result.ok, false);
      assert.equal(trace.filter((entry) => entry.action === "check" && entry.url.startsWith("https://github.com/")).length, 1);
      assert.equal(trace.filter((entry) => entry.action === "download").length, failure === "download-error" ? 2 : 1);
      assert.ok(trace.every((entry) => !entry.url.includes("/latest/download/")));
      assert.equal(autoInstallOnAppQuit, false);
    });
  }
}

it("does not retry Latest after the selected GitHub provider itself fails to download", async () => {
  const { result, trace } = await downloadAfterWebsiteFailure("stable", "download-error", { websiteCheckFails: true });
  assert.equal(result.ok, false);
  assert.equal(trace.filter((entry) => entry.action === "check" && entry.url.startsWith("https://github.com/")).length, 1);
  assert.equal(trace.filter((entry) => entry.action === "download").length, 1);
  assert.ok(trace.every((entry) => !entry.url.includes("/latest/download/")));
});
