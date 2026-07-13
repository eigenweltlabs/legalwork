import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ELECTRON_UPDATER_CHANNEL_FILENAME = "electron-updater-channel.v1.json";

// In dev mode, app.getVersion() returns the Electron framework version
// (e.g. "35.7.5") instead of the LegalWork app version. Read from
// package.json so the UI always shows the correct version.
const __updater_dirname = path.dirname(fileURLToPath(import.meta.url));
let _cachedAppVersion = null;
function resolveAppVersion(app) {
  if (_cachedAppVersion) return _cachedAppVersion;
  const electronVersion = app.getVersion();
  // If packaged, app.getVersion() is correct (set by electron-builder).
  if (app.isPackaged) {
    _cachedAppVersion = electronVersion;
    return electronVersion;
  }
  // In dev, read from package.json.
  try {
    const pkgPath = path.resolve(__updater_dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    _cachedAppVersion = pkg.version || electronVersion;
  } catch {
    _cachedAppVersion = electronVersion;
  }
  return _cachedAppVersion;
}
// Exported (with the fallback map below) so main.mjs's arch-mismatch download
// flow resolves against the exact same feeds — one definition per URL.
export const ELECTRON_UPDATER_FEEDS = Object.freeze({
  // Stable is served via our domain; the route (eigenwelt-website
  // app/legalwork/update/[file]/route.ts) redirects every file to the same
  // GitHub release assets this URL used to point at:
  //   https://github.com/eigenweltlabs/legalwork/releases/latest/download
  stable: "https://eigenweltlabs.com/legalwork/update",
  // Alpha is a per-platform rolling release: each platform's alpha workflow
  // (alpha-macos-aarch64.yml / alpha-windows-x64.yml) refreshes its own
  // updater manifest on its own tag.
  alpha:
    process.platform === "win32"
      ? "https://github.com/eigenweltlabs/legalwork/releases/download/alpha-windows-latest"
      : "https://github.com/eigenweltlabs/legalwork/releases/download/alpha-macos-latest",
});

// Safety net: if the tracked feed host is unreachable (outage, or the domain
// is gone entirely), checks retry directly against GitHub so shipped apps can
// ALWAYS self-update as long as releases exist. Alpha already points at
// GitHub, so only stable needs a fallback.
export const ELECTRON_UPDATER_FALLBACK_FEEDS = Object.freeze({
  stable: "https://github.com/eigenweltlabs/legalwork/releases/latest/download",
});

const ALPHA_CHANNEL_PLATFORMS = new Set(["darwin", "win32"]);

function normalizeElectronUpdaterChannel(value) {
  if (value === "alpha" && ALPHA_CHANNEL_PLATFORMS.has(process.platform)) return "alpha";
  return "stable";
}

function electronUpdaterChannelPath(app) {
  return path.join(app.getPath("userData"), ELECTRON_UPDATER_CHANNEL_FILENAME);
}

async function readElectronUpdaterChannel(app) {
  try {
    const raw = await readFile(electronUpdaterChannelPath(app), "utf8");
    const parsed = JSON.parse(raw);
    return normalizeElectronUpdaterChannel(parsed?.channel);
  } catch {
    return "stable";
  }
}

async function writeElectronUpdaterChannel(app, channel) {
  const normalized = normalizeElectronUpdaterChannel(channel);
  const outputPath = electronUpdaterChannelPath(app);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify({ channel: normalized, writtenAt: new Date().toISOString() }, null, 2)}\n`,
    "utf8",
  );
  return normalized;
}

function electronUpdaterFeedUrl(channel) {
  return ELECTRON_UPDATER_FEEDS[normalizeElectronUpdaterChannel(channel)];
}

function parseComparableVersion(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^v/i, "");
  if (!normalized) return null;

  const [versionCore] = normalized.split("+", 1);
  if (!versionCore) return null;

  const [releasePart, prereleasePart = ""] = versionCore.split("-", 2);
  const release = releasePart.split(".").map((segment) => Number(segment));
  if (!release.length || release.some((segment) => !Number.isInteger(segment) || segment < 0)) {
    return null;
  }

  const prerelease = prereleasePart
    .split(".")
    .map((segment) => segment.trim())
    .filter(Boolean);

  return { release, prerelease };
}

function comparePrereleaseIdentifiers(left, right) {
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;

  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;

    const leftNumeric = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumeric = /^\d+$/.test(rightPart) ? Number(rightPart) : null;

    if (leftNumeric !== null && rightNumeric !== null) {
      if (leftNumeric !== rightNumeric) return leftNumeric < rightNumeric ? -1 : 1;
      continue;
    }

    if (leftNumeric !== null) return -1;
    if (rightNumeric !== null) return 1;

    const comparison = leftPart.localeCompare(rightPart);
    if (comparison !== 0) return comparison < 0 ? -1 : 1;
  }

  return 0;
}

function compareVersions(left, right) {
  const parsedLeft = parseComparableVersion(left);
  const parsedRight = parseComparableVersion(right);
  if (!parsedLeft || !parsedRight) return null;

  const count = Math.max(parsedLeft.release.length, parsedRight.release.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = parsedLeft.release[index] ?? 0;
    const rightPart = parsedRight.release[index] ?? 0;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }

  return comparePrereleaseIdentifiers(parsedLeft.prerelease, parsedRight.prerelease);
}

function isVersionNewer(candidate, current) {
  const comparison = compareVersions(candidate, current);
  return comparison === null ? candidate !== current : comparison > 0;
}

function updaterChannelState(app, channel) {
  const normalized = normalizeElectronUpdaterChannel(channel);
  return {
    channel: normalized,
    feedUrl: electronUpdaterFeedUrl(normalized),
    currentVersion: resolveAppVersion(app),
  };
}

async function applyElectronUpdaterFeed(app, updater) {
  const channel = await readElectronUpdaterChannel(app);
  const state = updaterChannelState(app, channel);
  updater.allowPrerelease = state.channel === "alpha";
  // Moving from alpha back to stable can be a semver downgrade; still show
  // the latest stable so users can return to the stable channel deliberately.
  updater.allowDowngrade = state.channel === "stable";
  if (updater?.setFeedURL) {
    updater.setFeedURL({ provider: "generic", url: state.feedUrl });
  }
  return state;
}

/* Check against the channel's primary feed first; if that errors, retry the
   same check against the GitHub fallback feed. A success-shaped answer that
   reports "no update" is additionally cross-checked against GitHub: a tracked
   feed serving valid-but-STALE data never errors, and without the cross-check
   it would silently pin every install on its current version. Leaves the feed
   that answered applied on the updater instance, so a subsequent
   downloadUpdate() resolves installer files against the feed the update info
   actually came from.
   Exported for tests — a broken update path is the app's worst failure mode. */
export async function checkForUpdatesWithFeedFallback(app, updater) {
  const channelState = await applyElectronUpdaterFeed(app, updater);
  const fallbackUrl = ELECTRON_UPDATER_FALLBACK_FEEDS[channelState.channel];
  try {
    const result = await updater.checkForUpdates();
    const version = result?.updateInfo?.version;
    if (
      fallbackUrl &&
      updater?.setFeedURL &&
      !(version && isVersionNewer(version, resolveAppVersion(app)))
    ) {
      // "No update" from the tracked feed: confirm against GitHub and prefer
      // whichever feed advertises the newer version. Costs one extra request
      // on up-to-date checks; buys immunity against a stale tracked feed.
      try {
        updater.setFeedURL({ provider: "generic", url: fallbackUrl });
        const crossResult = await updater.checkForUpdates();
        const crossVersion = crossResult?.updateInfo?.version;
        if (crossVersion && isVersionNewer(crossVersion, resolveAppVersion(app))) {
          console.warn("[updater] tracked feed is stale, using GitHub", { version, crossVersion });
          return {
            channelState: { ...channelState, feedUrl: fallbackUrl, feedFallback: true },
            result: crossResult,
          };
        }
      } catch {
        // Best-effort freshness check; the tracked feed already answered.
      }
      updater.setFeedURL({ provider: "generic", url: channelState.feedUrl });
    }
    return { channelState: { ...channelState, feedFallback: false }, result };
  } catch (error) {
    if (!fallbackUrl || !updater?.setFeedURL) throw error;
    console.warn("[updater] feed check failed, retrying via GitHub", error?.message ?? error);
    updater.setFeedURL({ provider: "generic", url: fallbackUrl });
    try {
      const result = await updater.checkForUpdates();
      return {
        channelState: { ...channelState, feedUrl: fallbackUrl, feedFallback: true },
        result,
      };
    } catch (fallbackError) {
      // Mark that GitHub itself was just tried, so the last-ditch recovery in
      // the IPC handlers doesn't burn another timeout on an identical request.
      if (fallbackError && typeof fallbackError === "object") {
        fallbackError.githubFallbackAttempted = true;
      }
      throw fallbackError;
    }
  }
}

function runDefaults(args) {
  return new Promise((resolve) => {
    execFile("/usr/bin/defaults", args, (error) => {
      // Best-effort: a failure here just means we fall back to Squirrel's
      // default move-based install. Never block the update on it.
      if (error) console.warn("[updater] defaults write failed", error?.message ?? error);
      resolve(undefined);
    });
  });
}

// Squirrel.Mac's `ShipIt` helper (which swaps the .app on macOS) reads its
// options from this NSUserDefaults domain.
const SHIP_IT_DEFAULTS_DOMAIN = "com.eigenweltlabs.legalwork.ShipIt";

// Squirrel.Mac defaults to moving the *entire* app bundle through a temp
// directory. On repeat installs that move can leave the staged bundle missing,
// producing:
//   "Failed to copy bundle … no such file or directory"
//   "Too many attempts to install, aborting update"
// and silently relaunching the OLD app (so the in-app version looks updated
// while the on-disk renderer stays stale). Enabling DirectContentsWrite makes
// ShipIt write file contents in place instead of moving whole bundles, which
// avoids the ENOENT abort.
async function enableSquirrelDirectContentsWrite() {
  if (process.platform !== "darwin") return;
  await runDefaults(["write", SHIP_IT_DEFAULTS_DOMAIN, "SquirrelMacEnableDirectContentsWrite", "-bool", "YES"]);
}

// Path of the ShipIt cache that, when stuck, keeps aborting future installs.
// Exported for tests.
export function staleUpdaterStatePaths(app) {
  if (process.platform !== "darwin") return [];
  const home = app.getPath("home");
  return [path.join(home, "Library", "Caches", SHIP_IT_DEFAULTS_DOMAIN)];
}

// Remove a previously-failed, half-applied update so the next attempt starts
// from a clean slate. A stuck `ShipIt` state (after "Too many attempts to
// install, aborting update") can otherwise keep aborting future installs.
async function cleanStaleUpdaterState(app) {
  for (const target of staleUpdaterStatePaths(app)) {
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      console.warn("[updater] failed to clean stale state", target, error?.message ?? error);
    }
  }
}

// electron-updater wiring. Packaged-only; dev builds skip this so the
// updater doesn't try to probe a non-existent release channel.
export function registerUpdaterIpc({ app, ipcMain, getMainWindow }) {
  let autoUpdaterInstance = null;
  let autoUpdaterLoaded = false;
  let checkedUpdateVersion = null;

  function sendToRenderer(channel, data) {
    try {
      const win = typeof getMainWindow === "function" ? getMainWindow() : null;
      if (win?.webContents && !win.isDestroyed()) {
        win.webContents.send(channel, data);
      }
    } catch {
      // Window may be closed; swallow send failures.
    }
  }

  async function ensureAutoUpdater() {
    if (!app.isPackaged) return null;
    if (autoUpdaterLoaded) return autoUpdaterInstance;
    autoUpdaterLoaded = true;
    try {
      const mod = await import("electron-updater");
      autoUpdaterInstance = mod.autoUpdater ?? mod.default?.autoUpdater ?? null;
      if (autoUpdaterInstance) {
        autoUpdaterInstance.autoDownload = false;
        autoUpdaterInstance.autoInstallOnAppQuit = true;
        // Differential (blockmap) downloads reconstruct the update zip from the
        // installed app + a diff. On macOS that reconstructed bundle is what
        // feeds Squirrel's fragile move-based install, and is a common trigger
        // for the "Failed to copy bundle … no such file" abort. Download the
        // full zip instead — alpha builds are swapped wholesale anyway.
        autoUpdaterInstance.disableDifferentialDownload = true;
        // Make Squirrel.Mac write contents in place rather than moving whole
        // bundles (see enableSquirrelDirectContentsWrite for why).
        await enableSquirrelDirectContentsWrite();
        autoUpdaterInstance.on("error", (err) => {
          console.warn("[updater] error", err);
        });
        // Forward download progress to the renderer so the UI can show
        // incremental bytes instead of staying stuck at 0.
        autoUpdaterInstance.on("download-progress", (info) => {
          sendToRenderer("legalwork:updater:download-progress", {
            bytesPerSecond: info.bytesPerSecond ?? 0,
            percent: info.percent ?? 0,
            transferred: info.transferred ?? 0,
            total: info.total ?? 0,
            delta: info.delta ?? 0,
          });
        });
        await applyElectronUpdaterFeed(app, autoUpdaterInstance);
      }
    } catch (error) {
      console.warn("[updater] electron-updater not available", error);
      autoUpdaterInstance = null;
    }
    return autoUpdaterInstance;
  }

  ipcMain.handle("legalwork:updater:getChannel", async () => {
    const channel = await readElectronUpdaterChannel(app);
    return updaterChannelState(app, channel);
  });

  ipcMain.handle("legalwork:updater:setChannel", async (_event, rawChannel) => {
    const channel = await writeElectronUpdaterChannel(app, rawChannel);
    checkedUpdateVersion = null;
    const updater = await ensureAutoUpdater();
    if (updater) {
      return applyElectronUpdaterFeed(app, updater);
    }
    return updaterChannelState(app, channel);
  });

  ipcMain.handle("legalwork:updater:check", async (_event, rawChannel) => {
    if (rawChannel !== undefined) {
      await writeElectronUpdaterChannel(app, rawChannel);
    }
    const updater = await ensureAutoUpdater();
    if (!updater) {
      const channelState = updaterChannelState(app, await readElectronUpdaterChannel(app));
      return { available: false, reason: "unavailable", ...channelState };
    }
    const shapeCheckResult = (info, channelState) => {
      const currentVersion = resolveAppVersion(app);
      const available = Boolean(info?.version && isVersionNewer(info.version, currentVersion));
      checkedUpdateVersion = available ? info.version : null;
      return {
        available,
        currentVersion,
        latestVersion: info?.version ?? null,
        releaseDate: info?.releaseDate ?? null,
        releaseNotes: info?.releaseNotes ?? null,
        ...channelState,
      };
    };
    try {
      const { channelState, result } = await checkForUpdatesWithFeedFallback(app, updater);
      return shapeCheckResult(result?.updateInfo ?? null, channelState);
    } catch (error) {
      /* Last-ditch recovery, deliberately dumb: if anything above threw before
         GitHub could be tried — e.g. a bug in our own feed/channel plumbing —
         try one raw check straight against GitHub with no helpers in the way.
         The less code on this path, the less of it can be broken; self-updating
         must outlive every other failure in this file. Two guards: never for
         the alpha channel (reporting channel "stable" here would be persisted
         by the renderer, silently migrating the user off alpha), and never when
         the fallback chain already reached GitHub (an identical retry can only
         burn another network timeout). */
      const channel = await readElectronUpdaterChannel(app);
      if (channel === "stable" && !error?.githubFallbackAttempted) {
        try {
          updater.setFeedURL({ provider: "generic", url: ELECTRON_UPDATER_FALLBACK_FEEDS.stable });
          const result = await updater.checkForUpdates();
          return shapeCheckResult(result?.updateInfo ?? null, {
            channel: "stable",
            feedUrl: ELECTRON_UPDATER_FALLBACK_FEEDS.stable,
            currentVersion: resolveAppVersion(app),
            feedFallback: true,
          });
        } catch {
          // Fall through to the error result below.
        }
      }
      checkedUpdateVersion = null;
      return { available: false, reason: String(error?.message ?? error), ...updaterChannelState(app, channel) };
    }
  });

  ipcMain.handle("legalwork:updater:download", async () => {
    const updater = await ensureAutoUpdater();
    if (!updater) return { ok: false, reason: "unavailable" };
    try {
      // No unconditional feed re-apply here: the feed left active by the last
      // successful check (primary or GitHub fallback) is the one the cached
      // update info came from, and channel switches clear the cache below.
      const currentVersion = resolveAppVersion(app);
      if (!checkedUpdateVersion || !isVersionNewer(checkedUpdateVersion, currentVersion)) {
        const { result } = await checkForUpdatesWithFeedFallback(app, updater);
        const info = result?.updateInfo ?? null;
        checkedUpdateVersion = info?.version && isVersionNewer(info.version, currentVersion)
          ? info.version
          : null;
      }
      if (!checkedUpdateVersion) {
        return { ok: false, reason: "No update available." };
      }
      // Clear any stuck ShipIt state from a prior aborted install so this
      // download applies cleanly on quit.
      await cleanStaleUpdaterState(app);
      await updater.downloadUpdate();
      return { ok: true };
    } catch (error) {
      /* Last-ditch mirror of the check path: one raw GitHub check + download
         with no helpers, so a bug in our plumbing can't block updates. Same
         guards as the check path: stable channel only (a transient alpha
         download failure must not silently install a stable build), and
         skipped when the fallback chain already failed against GitHub. */
      try {
        const channel = await readElectronUpdaterChannel(app);
        if (channel !== "stable" || error?.githubFallbackAttempted) {
          return { ok: false, reason: String(error?.message ?? error) };
        }
        updater.setFeedURL({ provider: "generic", url: ELECTRON_UPDATER_FALLBACK_FEEDS.stable });
        const result = await updater.checkForUpdates();
        const info = result?.updateInfo ?? null;
        if (!info?.version || !isVersionNewer(info.version, resolveAppVersion(app))) {
          return { ok: false, reason: String(error?.message ?? error) };
        }
        checkedUpdateVersion = info.version;
        // Same stuck-ShipIt hygiene as the happy path — the throw above may
        // have happened before that cleanStaleUpdaterState() ran.
        await cleanStaleUpdaterState(app);
        await updater.downloadUpdate();
        return { ok: true };
      } catch {
        return { ok: false, reason: String(error?.message ?? error) };
      }
    }
  });

  ipcMain.handle("legalwork:updater:installAndRestart", async () => {
    const updater = await ensureAutoUpdater();
    if (!updater) return { ok: false, reason: "unavailable" };
    try {
      // Re-assert the in-place-write default right before the swap; the ShipIt
      // defaults domain may have been wiped when stale state was cleaned.
      await enableSquirrelDirectContentsWrite();
      updater.quitAndInstall(false, true);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: String(error?.message ?? error) };
    }
  });

  return { ensureAutoUpdater };
}
