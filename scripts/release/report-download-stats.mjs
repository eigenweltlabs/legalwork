#!/usr/bin/env node
/**
 * Snapshot GitHub release download counts and repo traffic into PostHog.
 *
 * GitHub only exposes a lifetime cumulative `download_count` per release
 * asset — no time series. This script runs on a schedule (see
 * .github/workflows/download-stats.yml) and captures one
 * `release_download_snapshot` event per asset, so PostHog insights can
 * compute downloads-per-day as the delta between snapshots.
 *
 * Also snapshots the repo Traffic API (views, clones, referrers) as
 * `repo_traffic_snapshot` events — GitHub deletes that data after a rolling
 * 14 days. Each run re-sends the current window; insights take the latest
 * snapshot per day (argMax), so re-sends are harmless.
 *
 * Events carry only public release metadata (tag, asset name, platform,
 * cumulative count) under a fixed bot distinct_id with person processing
 * disabled — no person profiles are created.
 *
 * Env:
 *   GITHUB_TOKEN            optional; raises the API rate limit (set in CI)
 *   LEGALWORK_POSTHOG_KEY   override the default publishable project key
 *   LEGALWORK_POSTHOG_HOST  override the default EU ingestion host
 *
 * Usage: node scripts/release/report-download-stats.mjs [--dry-run]
 */

const REPO = "eigenweltlabs/legalwork";

// Same publishable key/host defaults as apps/app/src/app/lib/analytics.ts —
// release stats land in the LegalWork PostHog project next to app usage.
const POSTHOG_KEY =
  (process.env.LEGALWORK_POSTHOG_KEY ?? "").trim() ||
  "phc_mvBQ5pbmKNZPmLn6c6bMZb9yXqEtf6bvSPZBa5vwRJfw";
const POSTHOG_HOST = ((process.env.LEGALWORK_POSTHOG_HOST ?? "").trim() || "https://eu.i.posthog.com").replace(
  /\/+$/,
  "",
);
const GITHUB_TOKEN = (process.env.GITHUB_TOKEN ?? "").trim();
const DRY_RUN = process.argv.includes("--dry-run");

const EVENT_NAME = "release_download_snapshot";
const DISTINCT_ID = `github-releases:${REPO}`;
const MAX_BATCH = 50;

async function githubGet(path) {
  const response = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} on ${path}: ${await response.text()}`);
  }
  return response.json();
}

async function fetchAllReleases() {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const batch = await githubGet(`releases?per_page=100&page=${page}`);
    releases.push(...batch);
    if (batch.length < 100) return releases;
  }
}

/**
 * Returns null for assets that should not be reported (blockmaps), otherwise
 * { fileKind, platform, arch, version }. electron-updater manifests are kept
 * as fileKind "update-manifest": their counts approximate update *checks*,
 * not human downloads, so insights should usually filter them out. The same
 * goes for mac zips (fileKind "zip", platform "mac"): they are what
 * electron-updater downloads during auto-update, while humans get the .dmg —
 * treat their counts as update *installs*, not human downloads.
 */
function classifyAsset(name) {
  if (name.endsWith(".blockmap")) return null;

  const manifest = name.match(/^latest(?:-(mac|linux))?(?:-(arm64))?\.yml$/);
  if (manifest) {
    return {
      fileKind: "update-manifest",
      platform: manifest[1] ?? "win", // electron-updater's plain latest.yml is Windows
      arch: manifest[2] ?? null,
      version: null,
    };
  }

  const installer = name.match(/^legalwork-(mac|win|linux)-(arm64|x64|x86_64)-(.+?)\.(dmg|zip|exe|AppImage|tar\.gz)$/);
  if (installer) {
    return {
      fileKind: installer[4],
      platform: installer[1],
      arch: installer[2] === "x86_64" ? "x64" : installer[2],
      version: installer[3],
    };
  }

  return { fileKind: "other", platform: null, arch: null, version: null };
}

async function sendBatch(events) {
  const response = await fetch(`${POSTHOG_HOST}/batch/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: POSTHOG_KEY, batch: events }),
  });
  if (!response.ok) {
    throw new Error(`PostHog ${response.status}: ${await response.text()}`);
  }
}

const releases = await fetchAllReleases();
const timestamp = new Date().toISOString();
const events = [];

for (const release of releases) {
  if (release.draft) continue;
  for (const asset of release.assets ?? []) {
    const classified = classifyAsset(asset.name);
    if (!classified) continue;
    events.push({
      event: EVENT_NAME,
      distinct_id: DISTINCT_ID,
      timestamp,
      properties: {
        $process_person_profile: false,
        repo: REPO,
        release_tag: release.tag_name,
        prerelease: release.prerelease,
        release_published_at: release.published_at,
        asset_name: asset.name,
        platform: classified.platform,
        arch: classified.arch,
        file_kind: classified.fileKind,
        version: classified.version,
        cumulative_downloads: asset.download_count,
      },
    });
  }
}

/* Repo traffic: views/clones per day plus the 14-day referrer table. Needs
   push access — if the token lacks it (403), skip traffic rather than fail
   the whole run. */
let trafficEvents = 0;
try {
  const [views, clones, referrers] = await Promise.all([
    githubGet("traffic/views"),
    githubGet("traffic/clones"),
    githubGet("traffic/popular/referrers"),
  ]);
  const trafficProps = { $process_person_profile: false, repo: REPO };
  for (const [kind, buckets] of [
    ["views", views.views ?? []],
    ["clones", clones.clones ?? []],
  ]) {
    for (const bucket of buckets) {
      events.push({
        event: "repo_traffic_snapshot",
        distinct_id: DISTINCT_ID,
        timestamp,
        properties: {
          ...trafficProps,
          kind,
          day: bucket.timestamp.slice(0, 10),
          count: bucket.count,
          uniques: bucket.uniques,
        },
      });
      trafficEvents += 1;
    }
  }
  for (const ref of referrers) {
    events.push({
      event: "repo_traffic_snapshot",
      distinct_id: DISTINCT_ID,
      timestamp,
      properties: {
        ...trafficProps,
        kind: "referrer",
        referrer: ref.referrer,
        count_14d: ref.count,
        uniques_14d: ref.uniques,
      },
    });
    trafficEvents += 1;
  }
} catch (error) {
  console.warn(`Traffic API unavailable (needs push access) — skipping: ${error.message ?? error}`);
}

const installerTotals = new Map();
for (const event of events) {
  if (event.event !== EVENT_NAME) continue;
  const { file_kind: fileKind, platform } = event.properties;
  if (fileKind === "update-manifest") continue;
  // Mac zips are auto-update fetches, not human downloads (see classifyAsset).
  if (fileKind === "zip" && platform === "mac") continue;
  const key = platform ?? "unknown";
  installerTotals.set(key, (installerTotals.get(key) ?? 0) + event.properties.cumulative_downloads);
}

console.log(
  `${REPO}: ${releases.length} releases, ${events.length - trafficEvents} asset snapshots, ${trafficEvents} traffic snapshots @ ${timestamp}`,
);
console.log(
  "Cumulative installer downloads by platform:",
  Object.fromEntries([...installerTotals.entries()].sort()),
);

if (DRY_RUN) {
  console.log(JSON.stringify(events, null, 2));
  console.log("Dry run — nothing sent.");
} else {
  for (let i = 0; i < events.length; i += MAX_BATCH) {
    await sendBatch(events.slice(i, i + MAX_BATCH));
  }
  console.log(`Sent ${events.length} events to ${POSTHOG_HOST}.`);
}
