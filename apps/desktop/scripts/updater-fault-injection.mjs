/* Fault-injection harness for the updater pipeline.
 *
 * Drives the REAL electron-updater through the real IPC handlers
 * (electron/updater.mjs registerUpdaterIpc) against mock feed servers on
 * 127.0.0.1 — no request ever leaves the machine, so runs create no analytics
 * events and no GitHub download-counter noise. Each scenario is a regression
 * test for a specific failure mode of the feed-fallback design:
 *
 *   1. tracked feed answers            -> no fallback traffic
 *   2. tracked feed valid-but-STALE    -> GitHub cross-check heals silently
 *   3. both feeds up to date           -> single cross-check, no update
 *   4. tracked feed 200-with-HTML      -> parse error -> fallback heals
 *   5. every feed down                 -> error after exactly one fallback try
 *   6. alpha feed broken               -> error; NEVER a silent switch to stable
 *   7. stable asset download breaks    -> download last-ditch heals via fallback
 *   8. alpha asset download breaks     -> fails WITHOUT crossing to stable
 *
 * Usage (from apps/desktop): pnpm exec electron scripts/updater-fault-injection.mjs
 *
 * The feed URLs are injected via the LEGALWORK_ELECTRON_UPDATE_* env overrides
 * (see electron/updater.mjs), set here before updater.mjs is imported.
 *
 * NOTE: in an ESM main entry Electron emits "ready" only after the module has
 * finished evaluating, so `await app.whenReady()` at the top level deadlocks —
 * all work happens inside main(), started from whenReady().then().
 */

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { app } from "electron";

const VERSION_NEW = "999.0.0";
const VERSION_STALE = "0.0.1";

// Each feed serves DIFFERENT zip bytes (and thus a different sha512), like
// real life where an alpha build never shares a checksum with a stable one.
// Identical bytes across feeds would let electron-updater's download cache
// satisfy one scenario with another scenario's file.
const FEED_ZIP_SEED = { primary: 1, fallback: 2, alpha: 3 };
function zipBytes(feed) {
  return Buffer.alloc(2048, FEED_ZIP_SEED[feed]);
}
function zipSha512(feed) {
  return createHash("sha512").update(zipBytes(feed)).digest("base64");
}

function manifestYaml(version, feed) {
  return [
    `version: ${version}`,
    "files:",
    `  - url: tiny-${version}.zip`,
    `    sha512: ${zipSha512(feed)}`,
    `    size: ${zipBytes(feed).length}`,
    `path: tiny-${version}.zip`,
    `sha512: ${zipSha512(feed)}`,
    "releaseDate: '2026-07-13T00:00:00.000Z'",
    "",
  ].join("\n");
}

/* One server, three feeds ("primary" | "fallback" | "alpha") selected by path
   prefix. Behavior per feed is set in `modes` between scenarios:
     { kind: "manifest", version, zip: "ok" | "missing" }
     { kind: "html" }                      200 text/html body
     { kind: "error", status }             that status on every path
   Every request is appended to `requests` for count assertions. */
const modes = { primary: null, fallback: null, alpha: null };
const requests = [];

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://127.0.0.1");
  const [, feed, ...rest] = pathname.split("/");
  const file = rest.join("/");
  const mode = modes[feed];
  requests.push({ feed, file });
  if (!mode) {
    res.writeHead(500);
    return res.end("feed not configured");
  }
  if (mode.kind === "error") {
    res.writeHead(mode.status ?? 500);
    return res.end("injected error");
  }
  if (mode.kind === "html") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end("<!doctype html><html><body>maintenance</body></html>");
  }
  // manifest mode
  if (file.endsWith(".yml")) {
    res.writeHead(200, { "content-type": "text/yaml" });
    return res.end(manifestYaml(mode.version, feed));
  }
  if (file.endsWith(".zip") && mode.zip === "ok") {
    const bytes = zipBytes(feed);
    res.writeHead(200, {
      "content-type": "application/zip",
      "content-length": String(bytes.length),
    });
    return res.end(bytes);
  }
  res.writeHead(404);
  res.end("not found");
});

function countRequests(feed, suffix, since = 0) {
  return requests
    .slice(since)
    .filter((r) => r.feed === feed && (!suffix || r.file.endsWith(suffix))).length;
}

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`  PASS  ${name}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function main() {
  app.dock?.hide();

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.LEGALWORK_ELECTRON_UPDATE_FEED = `${base}/primary`;
  process.env.LEGALWORK_ELECTRON_UPDATE_FALLBACK_FEED = `${base}/fallback`;
  process.env.LEGALWORK_ELECTRON_UPDATE_ALPHA_FEED = `${base}/alpha`;

  // Env overrides are read at module load, so updater.mjs must be imported
  // AFTER the mock server's URLs are known.
  const { registerUpdaterIpc } = await import("../electron/updater.mjs");

  // electron-updater's forced-dev mode insists on a dev-app-update.yml next to
  // the entry script during downloadUpdate; the values are irrelevant because
  // our code always applies the feed via setFeedURL. Created here, removed in
  // the finally below.
  const devConfigPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "dev-app-update.yml",
  );
  writeFileSync(devConfigPath, "provider: generic\nurl: http://127.0.0.1:1/unused\n");

  /* The handlers gate on app.isPackaged and resolve every filesystem path via
     app.getPath — a proxy makes the dev electron binary look like a packaged
     1.0.0 install whose home/userData live in a throwaway temp dir, so the
     ShipIt-cache cleanup and channel file never touch the real machine. */
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "legalwork-updater-faults-"));
  const testApp = new Proxy(app, {
    get(target, prop) {
      if (prop === "isPackaged") return true;
      if (prop === "getVersion") return () => "1.0.0";
      if (prop === "getPath") {
        return (name) => {
          const dir = path.join(tmpRoot, name);
          mkdirSync(dir, { recursive: true });
          return dir;
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const channelFile = path.join(tmpRoot, "userData", "electron-updater-channel.v1.json");
  function setChannel(channel) {
    mkdirSync(path.dirname(channelFile), { recursive: true });
    writeFileSync(channelFile, `${JSON.stringify({ channel })}\n`);
  }

  /* Fresh handler closure per scenario (clean checkedUpdateVersion), same
     electron-updater singleton underneath — exactly like consecutive checks in
     a running app. forceDevUpdateConfig lets the real (unpackaged) electron
     binary run checks; the feed itself always comes from our setFeedURL. */
  async function freshHandlers() {
    const handlers = {};
    const { ensureAutoUpdater } = registerUpdaterIpc({
      app: testApp,
      ipcMain: {
        handle(name, fn) {
          handlers[name] = fn;
        },
      },
      getMainWindow: () => null,
    });
    const updater = await ensureAutoUpdater();
    if (!updater) throw new Error("electron-updater unavailable in harness");
    updater.forceDevUpdateConfig = true;
    return handlers;
  }

  // -------------------------------------------------------------- scenarios

  console.log("\n1. tracked feed answers -> no fallback traffic");
  {
    setChannel("stable");
    modes.primary = { kind: "manifest", version: VERSION_NEW, zip: "ok" };
    modes.fallback = { kind: "manifest", version: VERSION_NEW, zip: "ok" };
    const handlers = await freshHandlers();
    const mark = requests.length;
    const result = await handlers["legalwork:updater:check"]({});
    check("update offered", result.available === true, JSON.stringify(result));
    check("via tracked feed", result.feedFallback === false, `feedFallback=${result.feedFallback}`);
    check("fallback untouched", countRequests("fallback", "", mark) === 0);
  }

  console.log("\n2. tracked feed valid-but-stale -> cross-check heals");
  {
    setChannel("stable");
    modes.primary = { kind: "manifest", version: VERSION_STALE, zip: "ok" };
    modes.fallback = { kind: "manifest", version: VERSION_NEW, zip: "ok" };
    const handlers = await freshHandlers();
    const result = await handlers["legalwork:updater:check"]({});
    check("newer version found on GitHub", result.available === true, JSON.stringify(result));
    check("marked as fallback", result.feedFallback === true, `feedFallback=${result.feedFallback}`);
    check("latest is the fallback's version", result.latestVersion === VERSION_NEW);
  }

  console.log("\n3. both feeds up to date -> single cross-check, no update");
  {
    setChannel("stable");
    modes.primary = { kind: "manifest", version: VERSION_STALE, zip: "ok" };
    modes.fallback = { kind: "manifest", version: VERSION_STALE, zip: "ok" };
    const handlers = await freshHandlers();
    const mark = requests.length;
    const result = await handlers["legalwork:updater:check"]({});
    check("no update", result.available === false, JSON.stringify(result));
    check("tracked answer kept", result.feedFallback === false, `feedFallback=${result.feedFallback}`);
    check("exactly one cross-check", countRequests("fallback", ".yml", mark) === 1);
  }

  console.log("\n4. tracked feed serves 200 HTML -> fallback heals");
  {
    setChannel("stable");
    modes.primary = { kind: "html" };
    modes.fallback = { kind: "manifest", version: VERSION_NEW, zip: "ok" };
    const handlers = await freshHandlers();
    const result = await handlers["legalwork:updater:check"]({});
    check(
      "update offered via fallback",
      result.available === true && result.feedFallback === true,
      JSON.stringify(result),
    );
  }

  console.log("\n5. every feed down -> error after exactly one fallback attempt");
  {
    setChannel("stable");
    modes.primary = { kind: "error", status: 500 };
    modes.fallback = { kind: "error", status: 500 };
    const handlers = await freshHandlers();
    const mark = requests.length;
    const result = await handlers["legalwork:updater:check"]({});
    check(
      "no update, reason surfaced",
      result.available === false && Boolean(result.reason),
      JSON.stringify(result),
    );
    check(
      "fallback tried once, not thrice",
      countRequests("fallback", ".yml", mark) === 1,
      `fallback manifest hits=${countRequests("fallback", ".yml", mark)}`,
    );
  }

  console.log("\n6. alpha feed broken -> error, never a silent switch to stable");
  {
    setChannel("alpha");
    modes.alpha = { kind: "error", status: 404 };
    modes.primary = { kind: "manifest", version: VERSION_NEW, zip: "ok" };
    modes.fallback = { kind: "manifest", version: VERSION_NEW, zip: "ok" };
    const handlers = await freshHandlers();
    const mark = requests.length;
    const result = await handlers["legalwork:updater:check"]({});
    check(
      "error surfaced",
      result.available === false && Boolean(result.reason),
      JSON.stringify(result),
    );
    check("channel stays alpha", result.channel === "alpha", `channel=${result.channel}`);
    check(
      "stable feeds untouched",
      countRequests("primary", "", mark) === 0 && countRequests("fallback", "", mark) === 0,
    );
  }

  console.log("\n7. stable asset download breaks -> last-ditch heals via fallback");
  {
    setChannel("stable");
    modes.primary = { kind: "manifest", version: VERSION_NEW, zip: "missing" };
    modes.fallback = { kind: "manifest", version: VERSION_NEW, zip: "ok" };
    const handlers = await freshHandlers();
    const checkResult = await handlers["legalwork:updater:check"]({});
    check(
      "update offered via tracked feed",
      checkResult.available === true && checkResult.feedFallback === false,
    );
    const mark = requests.length;
    const result = await handlers["legalwork:updater:download"]({});
    const healedZipFetches = countRequests("fallback", ".zip", mark);
    // In this dev harness Squirrel.Mac may refuse to stage the unsigned dummy
    // zip AFTER the download+checksum succeeded; the heal we're testing is the
    // network path, proven by the fallback zip actually being fetched.
    check(
      "download healed via fallback zip",
      result.ok === true || healedZipFetches >= 1,
      `ok=${result.ok} reason=${result.reason} fallbackZipFetches=${healedZipFetches}`,
    );
    check("fallback re-checked before downloading", countRequests("fallback", ".yml", mark) >= 1);
  }

  console.log("\n8. alpha asset download breaks -> fails WITHOUT crossing to stable");
  {
    setChannel("alpha");
    modes.alpha = { kind: "manifest", version: VERSION_NEW, zip: "missing" };
    modes.primary = { kind: "manifest", version: VERSION_NEW, zip: "ok" };
    modes.fallback = { kind: "manifest", version: VERSION_NEW, zip: "ok" };
    const handlers = await freshHandlers();
    const checkResult = await handlers["legalwork:updater:check"]({});
    check(
      "alpha update offered",
      checkResult.available === true && checkResult.channel === "alpha",
    );
    const mark = requests.length;
    const result = await handlers["legalwork:updater:download"]({});
    check(
      "download fails with reason",
      result.ok === false && Boolean(result.reason),
      JSON.stringify(result),
    );
    check(
      "no cross-channel traffic",
      countRequests("primary", "", mark) === 0 && countRequests("fallback", "", mark) === 0,
    );
  }

  // ------------------------------------------------------------------ done

  console.log(`\n${failures === 0 ? "All scenarios passed" : `${failures} assertion(s) failed`}`);
  server.close();
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(devConfigPath, { force: true });
  app.exit(failures === 0 ? 0 : 1);
}

app
  .whenReady()
  .then(main)
  .catch((error) => {
    console.error("harness crashed:", error);
    app.exit(2);
  });
