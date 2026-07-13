import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import {
  ELECTRON_UPDATER_FALLBACK_FEEDS,
  checkForUpdatesWithFeedFallback,
  staleUpdaterStatePaths,
} from "./updater.mjs";

const fakeApp = { getPath: (key) => (key === "home" ? "/Users/test" : `/Users/test/${key}`) };

/* A shipped app that can no longer self-update is the worst failure mode, so
   the feed fallback chain gets exercised directly: primary feed -> GitHub. */
describe("checkForUpdatesWithFeedFallback", () => {
  // No channel file in this userData dir -> the stable channel is used.
  const feedApp = {
    isPackaged: true,
    getVersion: () => "0.1.0",
    getPath: () => path.join(os.tmpdir(), "legalwork-updater-test-userdata"),
  };

  function fakeUpdater({ failFeeds }) {
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
        return { updateInfo: { version: "9.9.9" } };
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

  it("throws only when both feeds fail", async () => {
    const updater = fakeUpdater({ failFeeds: ["https://eigenweltlabs.com", "https://github.com"] });
    await assert.rejects(
      () => checkForUpdatesWithFeedFallback(feedApp, updater),
      /feed unreachable: https:\/\/github\.com/,
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
