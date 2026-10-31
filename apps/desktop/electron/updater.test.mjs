import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";

import {
  ELECTRON_UPDATER_FALLBACK_FEEDS,
  checkForUpdatesWithFeedFallback as checkUpdates,
  isVersionNewer,
  alphaFeedUrl,
  serializeUpdaterTasks,
  staleUpdaterStatePaths,
  electronUpdaterFeedConfig,
  downloadUpdateReady,
  isEligibleUpdate,
} from "./updater.mjs";

const checkForUpdatesWithFeedFallback = (app, updater) => checkUpdates(app, updater, { resolveFeed: async () => { throw new Error("Simulated API outage"); } });

const fakeApp = { getPath: (key) => (key === "home" ? "/Users/test" : `/Users/test/${key}`) };

// Exercise the dependency's real Squirrel proxy and autoInstallOnAppQuit branch.
// Only the native OS boundary is simulated: it must fetch the feed and ZIP
// before reporting validation success or failure. No installer is executed.
const { MacUpdater } = createRequire(import.meta.url)("electron-updater/out/MacUpdater.js");
const { AppUpdater } = createRequire(import.meta.url)("electron-updater/out/AppUpdater.js");

it("the real updater retains its gradual-rollout identity across app launches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legalwork-rollout-check-"));
  const selected = { tag: "v4.0.0", version: "4.0.0", releaseId: 1, manifest: "latest.yml", assetNames: [], kind: "stable", feedUrl: "https://github.com/eigenweltlabs/legalwork/releases/download/v4.0.0" };
  const app = { isPackaged: true, version: "3.0.0", name: "LegalWork", userDataPath: root,
    baseCachePath: root, appUpdateConfigPath: path.join(root, "app-update.yml"),
    whenReady: async () => {}, relaunch() {}, quit() {}, onQuit() {},
    getVersion: () => "3.0.0", getPath: () => root,
  };
  const requests = [];
  try {
    for (let launch = 0; launch < 3; launch++) {
      const updater = new AppUpdater(undefined, app);
      updater.autoDownload = false;
      updater.logger = { info() {}, warn() {}, error() {} };
      updater.httpExecutor = { request: async (options) => {
        requests.push(options);
        return "version: 4.0.0\nfiles:\n  - url: legalwork-mac-arm64-4.0.0.zip\n    sha512: abc\n    size: 10\n";
      } };
      const { channelState, result } = await checkUpdates(app, updater, { resolveFeed: async () => selected });
      assert.equal(channelState.feedFallback, false);
      assert.equal(result.updateInfo.version, "4.0.0");
      assert.equal(isEligibleUpdate(result, app.version), true);
    }
    const persisted = await readFile(path.join(root, ".updaterId"), "utf8");
    assert.equal(requests.length, 3);
    for (const req of requests) {
      assert.equal(req.hostname, "eigenweltlabs.com");
      assert.match(req.path, /^\/legalwork\/update\/releases\/v4\.0\.0\/latest.*\.yml/);
      assert.equal(req.headers["x-user-staging-id"], persisted);
      assert.deepEqual(Object.keys(req.headers).sort(), ["x-user-staging-id", "x-legalwork-version", "x-legalwork-update-channel"].sort());
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("honors the real updater's gradual-rollout decision before offering or downloading an update", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legalwork-staged-rollout-"));
  const id = "11111111-2222-4333-8444-555555555555";
  const selected = { tag: "v4.0.0", version: "4.0.0", releaseId: 1, manifest: "latest.yml", assetNames: [], kind: "stable", feedUrl: "https://github.com/eigenweltlabs/legalwork/releases/download/v4.0.0" };
  const app = { isPackaged: true, version: "3.0.0", name: "LegalWork", userDataPath: root,
    baseCachePath: root, appUpdateConfigPath: path.join(root, "app-update.yml"),
    whenReady: async () => {}, relaunch() {}, quit() {}, onQuit() {},
    getVersion: () => "3.0.0", getPath: () => root,
  };
  try {
    await writeFile(path.join(root, ".updaterId"), id);
    for (const stagingPercentage of [0, 100]) {
      const updater = new AppUpdater(undefined, app);
      updater.autoDownload = false;
      updater.logger = { info() {}, warn() {}, error() {} };
      updater.httpExecutor = { request: async (options) => {
        assert.equal(options.headers["x-user-staging-id"], id);
        return `version: 4.0.0\nstagingPercentage: ${stagingPercentage}\nfiles:\n  - url: legalwork-mac-arm64-4.0.0.zip\n    sha512: abc\n    size: 10\n`;
      } };
      const { result } = await checkUpdates(app, updater, { resolveFeed: async () => selected });
      assert.equal(result.updateInfo.version, "4.0.0");
      assert.equal(result.isUpdateAvailable, stagingPercentage === 100);
      assert.equal(isEligibleUpdate(result, app.version), stagingPercentage === 100);
      assert.equal(isEligibleUpdate(result, "4.0.0"), false);
      assert.equal(isEligibleUpdate(result, "5.0.0"), false);
    }
    assert.equal(await readFile(path.join(root, ".updaterId"), "utf8"), id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const autoInstallOnAppQuit of [false, true]) {
  for (const preparationFails of [false, true]) {
    it(`prepares through the real MacUpdater handoff (auto install=${autoInstallOnAppQuit}, failure=${preparationFails})`, async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "legalwork-mac-updater-"));
      const downloadedFile = path.join(root, "update.zip");
      const payload = Buffer.from("downloaded update fixture");
      await writeFile(downloadedFile, payload);
      const native = Object.assign(new EventEmitter(), {
        feed: null,
        checks: 0,
        transferred: false,
        setFeedURL(feed) { this.feed = feed; },
        checkForUpdates() {
          this.checks++;
          void this.prepare().catch((error) => native.emit("error", error));
        },
        async prepare() {
          assert.ok(this.feed, "MacUpdater must configure its local feed first");
          const response = await fetch(this.feed.url, { headers: this.feed.headers, signal: AbortSignal.timeout(3_000) });
          assert.equal(response.status, 200);
          const { url } = await response.json();
          const zip = await fetch(url, { signal: AbortSignal.timeout(3_000) });
          assert.equal(zip.status, 200);
          assert.deepEqual(Buffer.from(await zip.arrayBuffer()), payload);
          this.transferred = true;
          // Native validation happens after the proxy has finished serving.
          await new Promise((resolve) => setImmediate(resolve));
          if (preparationFails) throw new Error("Native signature validation failed");
          native.emit("update-downloaded");
        },
      });
      // Bypass the constructor's Electron singleton, retaining the real
      // updateDownloaded, closeServerIfExists, and event dispatch methods.
      const updater = Object.assign(Object.create(MacUpdater.prototype), {
        nativeUpdater: native,
        autoInstallOnAppQuit,
        _logger: { info() {}, warn() {}, error() {} },
        downloadUpdate() {
          return MacUpdater.prototype.updateDownloaded.call(this, { url: new URL("https://example.test/update.zip"), info: { size: payload.length } }, { downloadedFile });
        },
      });
      EventEmitter.call(updater);
      try {
        const result = downloadUpdateReady(updater, native, 5_000);
        if (preparationFails) await assert.rejects(result, /Native signature validation failed/);
        else await result;
        assert.equal(native.checks, 1, "preparation must start exactly once");
        assert.equal(native.transferred, true);
        assert.equal(updater.autoInstallOnAppQuit, autoInstallOnAppQuit, "preparation must not enable automatic installation");
        assert.equal(native.listenerCount("update-downloaded"), 0);
        assert.equal(native.listenerCount("error"), 0);
      } finally {
        updater.closeServerIfExists();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}

it("resolves each persisted channel to an exact release without permitting a downgrade", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "legalwork-channel-test-"));
  try {
    for (const channel of ["stable", "prerelease", "alpha"]) {
      await writeFile(path.join(root, "electron-updater-channel.v1.json"), JSON.stringify({ channel }));
      const app = { isPackaged: true, getVersion: () => "5.0.0", getPath: () => root };
      const updater = { feed: "", setFeedURL({ url }) { this.feed = url; }, async checkForUpdates() { return { updateInfo: { version: "4.0.0" } }; } };
      const selected = { tag: "v4.0.0", releaseId: 1, kind: "stable", manifest: "latest.yml", assetNames: [], version: "4.0.0", feedUrl: "https://github.com/eigenweltlabs/legalwork/releases/download/v4.0.0" };
      const { channelState } = await checkUpdates(app, updater, { resolveFeed: async (chosen) => {
        assert.equal(chosen, channel === "alpha" && process.platform === "linux" ? "stable" : channel);
        return selected;
      } });
      const websiteFeed = "https://eigenweltlabs.com/legalwork/update/releases/v4.0.0";
      assert.equal(channelState.feedUrl, websiteFeed);
      assert.equal(updater.feed, websiteFeed);
      assert.equal(channelState.feedFallback, false);
      assert.equal(updater.allowDowngrade, false);
      assert.equal(isVersionNewer("4.0.0", "5.0.0"), false);
      assert.equal(isVersionNewer("4.0.0", "4.0.0"), false);
      assert.equal(isVersionNewer("broken", "4.0.0"), false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const tag of ["v4.0.0", "v4.0.0-beta.2", "alpha-macos-v4.0.0-alpha.7-abcdef1"]) {
  for (const websiteFailure of ["outage", "stale"]) {
    it(`retries the exact selected ${tag} on GitHub after a website ${websiteFailure}`, async () => {
      const app = { isPackaged: true, getVersion: () => "3.0.0", getPath: () => "/nonexistent/legalwork-test" };
      const selected = { tag, version: "4.0.0", releaseId: 1, manifest: "latest.yml", assetNames: [], kind: "stable", feedUrl: `https://github.com/eigenweltlabs/legalwork/releases/download/${tag}` };
      const checks = [];
      const updater = {
        feed: "", requestHeaders: { existing: "retained" }, allowDowngrade: false,
        setFeedURL({ url }) { this.feed = url; },
        async checkForUpdates() {
          checks.push(this.feed);
          if (this.feed.startsWith("https://eigenweltlabs.com")) {
            if (websiteFailure === "outage") throw new Error("Website unavailable");
            return { updateInfo: { version: "3.0.0" } };
          }
          return { updateInfo: { version: selected.version } };
        },
      };
      const { channelState } = await checkUpdates(app, updater, { resolveFeed: async () => selected });
      assert.deepEqual(checks, [`https://eigenweltlabs.com/legalwork/update/releases/${tag}`, selected.feedUrl]);
      assert.equal(channelState.feedUrl, selected.feedUrl);
      assert.equal(channelState.feedFallback, true);
      assert.equal(updater.feed, selected.feedUrl, "follow-up downloads must use the feed that answered");
      assert.equal(updater.requestHeaders["x-legalwork-update-channel"], "stable");
      assert.equal(updater.requestHeaders["x-legalwork-version"], "3.0.0");
      assert.equal(updater.requestHeaders.existing, "retained");
      assert.equal(updater.allowDowngrade, false);
    });
  }
}

it("rejects mismatched manifests instead of silently switching release or channel", async () => {
  const app = { isPackaged: true, getVersion: () => "3.0.0", getPath: () => "/nonexistent/legalwork-test" };
  const updater = { setFeedURL() {}, async checkForUpdates() { return { updateInfo: { version: "8.0.0" } }; } };
  await assert.rejects(checkUpdates(app, updater, { resolveFeed: async () => ({ tag: "v4.0.0", releaseId: 1, kind: "stable", manifest: "latest.yml", assetNames: [], version: "4.0.0", feedUrl: "https://github.com/example/v4" }) }), /manifest does not match/);
  const empty = await checkUpdates(app, updater, { resolveFeed: async () => null });
  assert.equal(empty.result, null);
});

it("serializes a channel switch behind a download and recovers after failed checks", async () => {
  const run = serializeUpdaterTasks();
  const events = [];
  /** @type {() => void} */
  let finish = () => assert.fail("download not started");
  const download = run(async () => { events.push("download"); await new Promise((resolve) => { finish = () => resolve(undefined); }); events.push("downloaded"); });
  const change = run(() => { events.push("channel changed"); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["download"]);
  finish();
  await Promise.all([download, change]);
  await assert.rejects(run(() => { throw new Error("offline"); }));
  await run(() => events.push("new check"));
  assert.deepEqual(events, ["download", "downloaded", "channel changed", "new check"]);
});

describe("downloadUpdateReady", () => {
  it("waits for macOS to finish unpacking after the ZIP transfer", async () => {
    const native = new EventEmitter();
    let downloaded = false, ready = false;
    const result = downloadUpdateReady({ autoInstallOnAppQuit: true, async downloadUpdate() { downloaded = true; } }, native).then(() => { ready = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(downloaded, true);
    assert.equal(ready, false);
    native.emit("update-downloaded");
    await result;
    assert.equal(ready, true);
    assert.equal(native.listenerCount("error"), 0);
    assert.equal(native.listenerCount("update-downloaded"), 0);
  });

  it("reports an unpacking failure after downloadUpdate has already resolved", async () => {
    const native = new EventEmitter();
    const result = downloadUpdateReady({ autoInstallOnAppQuit: true, async downloadUpdate() {} }, native);
    const rejected = assert.rejects(result, /No space left on device/);
    await new Promise((resolve) => setImmediate(resolve));
    native.emit("error", new Error("ditto: No space left on device"));
    await rejected;
    assert.equal(native.listenerCount("update-downloaded"), 0);
  });

  it("subscribes before starting a cached download and still waits for its promise", async () => {
    const native = new EventEmitter();
    /** @type {() => void} */
    let finish = () => assert.fail("download must start first");
    let ready = false;
    const result = downloadUpdateReady({ autoInstallOnAppQuit: true, downloadUpdate() {
      native.emit("update-downloaded");
      return new Promise((resolve) => { finish = () => resolve(undefined); });
    } }, native).then(() => { ready = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(ready, false);
    finish();
    await result;
    assert.equal(native.listenerCount("error"), 0);
  });

  it("cleans up native listeners when the download fails", async () => {
    const native = new EventEmitter();
    await assert.rejects(downloadUpdateReady({ autoInstallOnAppQuit: true, async downloadUpdate() { throw new Error("Download failed"); } }, native), /Download failed/);
    assert.equal(native.listenerCount("error"), 0);
    assert.equal(native.listenerCount("update-downloaded"), 0);
  });

  it("times out a missing native completion event so retry remains possible", async () => {
    const native = new EventEmitter();
    await assert.rejects(downloadUpdateReady({ autoInstallOnAppQuit: true, async downloadUpdate() {} }, native, 10), /could not finish preparing/);
    assert.equal(native.listenerCount("error"), 0);
    assert.equal(native.listenerCount("update-downloaded"), 0);
  });

  it("keeps the download promise as readiness off macOS", async () => {
    for (const autoInstallOnAppQuit of [false, true]) {
      let downloaded = false;
      await downloadUpdateReady({ autoInstallOnAppQuit, async downloadUpdate() { downloaded = true; } }, null);
      assert.equal(downloaded, true);
      await assert.rejects(downloadUpdateReady({ autoInstallOnAppQuit, async downloadUpdate() { throw new Error("Download failed"); } }, null), /Download failed/);
    }
  });
});

it("keeps Windows installer architectures separate on every update feed", () => {
  for (const url of ["https://eigenweltlabs.com/legalwork/update", ELECTRON_UPDATER_FALLBACK_FEEDS.stable, "https://example.test/alpha"]) {
    assert.deepEqual(electronUpdaterFeedConfig(url, "win32", "arm64"), { provider: "generic", url, channel: "latest-arm64" });
    assert.deepEqual(electronUpdaterFeedConfig(url, "win32", "x64"), { provider: "generic", url });
    assert.deepEqual(electronUpdaterFeedConfig(url, "darwin", "arm64"), { provider: "generic", url });
  }
});

/* A shipped app that can no longer self-update is the worst failure mode, so
   the feed fallback chain gets exercised directly: primary feed -> GitHub. */
describe("checkForUpdatesWithFeedFallback", () => {
  // No channel file in this userData dir -> the stable channel is used.
  const feedApp = {
    isPackaged: true,
    getVersion: () => "0.1.0",
    getPath: () => path.join(os.tmpdir(), "legalwork-updater-test-userdata"),
  };

  // `versions` maps a feed-URL prefix to the version that feed advertises
  // (default "9.9.9", i.e. an available update).
  function fakeUpdater({ failFeeds, versions = {} }) {
    return {
      feedUrls: [],
      setFeedURL({ url }) {
        this.feedUrls.push(url);
      },
      async checkForUpdates() {
        const current = this.feedUrls[this.feedUrls.length - 1];
        if (failFeeds.some((feed) => current.startsWith(feed))) {
          throw new Error(`feed unreachable: ${current}`);
        }
        const match = Object.entries(versions).find(([feed]) => current.startsWith(feed));
        return { updateInfo: { version: match ? match[1] : "9.9.9" } };
      },
    };
  }

  it("uses the tracked feed when it answers", async () => {
    const updater = fakeUpdater({ failFeeds: [] });
    const { channelState, result } = await checkForUpdatesWithFeedFallback(feedApp, updater);
    assert.equal(channelState.feedUrl, "https://eigenweltlabs.com/legalwork/update");
    assert.equal(channelState.feedFallback, false);
    assert.equal(result.updateInfo.version, "9.9.9");
    assert.deepEqual(updater.feedUrls, ["https://eigenweltlabs.com/legalwork/update"]);
  });

  it("falls back to GitHub when the tracked feed errors", async () => {
    const updater = fakeUpdater({ failFeeds: ["https://eigenweltlabs.com"] });
    const { channelState, result } = await checkForUpdatesWithFeedFallback(feedApp, updater);
    assert.equal(channelState.feedFallback, true);
    assert.equal(channelState.feedUrl, ELECTRON_UPDATER_FALLBACK_FEEDS.stable);
    assert.equal(result.updateInfo.version, "9.9.9");
    // The GitHub feed must stay applied so the follow-up download uses it too.
    assert.equal(
      updater.feedUrls[updater.feedUrls.length - 1],
      ELECTRON_UPDATER_FALLBACK_FEEDS.stable,
    );
  });

  it("throws only when both feeds fail, tagging the error against redundant retries", async () => {
    const updater = fakeUpdater({ failFeeds: ["https://eigenweltlabs.com", "https://github.com"] });
    const error = await checkForUpdatesWithFeedFallback(feedApp, updater).then(
      () => assert.fail("expected rejection"),
      (rejection) => rejection,
    );
    assert.match(String(error?.message), /feed unreachable: https:\/\/github\.com/);
    // The tag tells the IPC handlers' last-ditch recovery that GitHub was
    // already tried, so they don't repeat the identical request.
    assert.equal(error.githubFallbackAttempted, true);
  });

  /* A tracked feed that answers with valid-but-stale data never errors, so the
     error fallback alone would pin the fleet on the current version. The
     freshness cross-check is what heals that. */
  it("cross-checks GitHub on 'no update' and prefers the newer version", async () => {
    const updater = fakeUpdater({
      failFeeds: [],
      versions: { "https://eigenweltlabs.com": "0.1.0" }, // stale: equals current
    });
    const { channelState, result } = await checkForUpdatesWithFeedFallback(feedApp, updater);
    assert.equal(result.updateInfo.version, "9.9.9");
    assert.equal(channelState.feedFallback, true);
    assert.equal(channelState.feedUrl, ELECTRON_UPDATER_FALLBACK_FEEDS.stable);
    // GitHub must stay applied so the follow-up download resolves against it.
    assert.equal(
      updater.feedUrls[updater.feedUrls.length - 1],
      ELECTRON_UPDATER_FALLBACK_FEEDS.stable,
    );
  });

  it("keeps the tracked feed's answer when GitHub agrees there is no update", async () => {
    const updater = fakeUpdater({
      failFeeds: [],
      versions: { "https://eigenweltlabs.com": "0.1.0", "https://github.com": "0.1.0" },
    });
    const { channelState, result } = await checkForUpdatesWithFeedFallback(feedApp, updater);
    assert.equal(result.updateInfo.version, "0.1.0");
    assert.equal(channelState.feedFallback, false);
    // The tracked feed is re-applied after the cross-check.
    assert.equal(
      updater.feedUrls[updater.feedUrls.length - 1],
      "https://eigenweltlabs.com/legalwork/update",
    );
  });

  it("ignores a failing GitHub cross-check when the tracked feed answered", async () => {
    const updater = fakeUpdater({
      failFeeds: ["https://github.com"],
      versions: { "https://eigenweltlabs.com": "0.1.0" },
    });
    const { channelState, result } = await checkForUpdatesWithFeedFallback(feedApp, updater);
    assert.equal(result.updateInfo.version, "0.1.0");
    assert.equal(channelState.feedFallback, false);
    assert.equal(
      updater.feedUrls[updater.feedUrls.length - 1],
      "https://eigenweltlabs.com/legalwork/update",
    );
  });
});

describe("staleUpdaterStatePaths", () => {
  it("targets the ShipIt cache on macOS", { skip: process.platform !== "darwin" }, () => {
    assert.deepEqual(staleUpdaterStatePaths(fakeApp), [
      "/Users/test/Library/Caches/com.eigenweltlabs.legalwork.ShipIt",
    ]);
  });

  it("is a no-op off macOS", { skip: process.platform === "darwin" }, () => {
    assert.deepEqual(staleUpdaterStatePaths(fakeApp), []);
  });
});

it("alpha fallback never offers an ARM-only macOS installer to an Intel Mac", () => {
  assert.equal(alphaFeedUrl("darwin", "x64"), "https://eigenweltlabs.com/legalwork/update");
  assert.match(alphaFeedUrl("darwin", "arm64"), /alpha-macos-latest$/);
  assert.match(alphaFeedUrl("win32", "x64"), /alpha-windows-latest$/);
  assert.match(alphaFeedUrl("win32", "arm64"), /alpha-windows-latest$/);
});
