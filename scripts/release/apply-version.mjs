#!/usr/bin/env node
/**
 * release:apply-version — stamp the release version into every shipped package.
 *
 * The git tag is the single source of truth for release versions. The
 * package.json files in the repo carry a 0.0.0 placeholder; CI derives the
 * real version from the tag (or an alpha version string) and stamps it into
 * the workspace right before building. Nothing is committed — the stamp only
 * exists inside the build.
 *
 * Usage:
 *   node scripts/release/apply-version.mjs --tag v1.2.3
 *   node scripts/release/apply-version.mjs --version 1.2.3-alpha.4+abc1234
 *   node scripts/release/apply-version.mjs --dry-run --tag v1.2.3
 *
 * Stamps:
 *   - apps/app/package.json            version
 *   - apps/desktop/package.json        version + opencodeRouterVersion
 *   - apps/orchestrator/package.json   version + legalwork-server/opencode-router deps
 *   - apps/server/package.json         version
 *   - apps/opencode-router/package.json version
 *
 * Run AFTER `pnpm install --frozen-lockfile`: pnpm-lock.yaml still records the
 * placeholder specifiers, and this script intentionally leaves it untouched so
 * the frozen-lockfile install stays valid.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);

const readArg = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
};

const dryRun = args.includes("--dry-run");
const tagArg = readArg("--tag");
const versionArg = readArg("--version");

const raw = (versionArg || tagArg || process.env.RELEASE_TAG || "").trim();
if (!raw) {
  console.error(
    "Version missing. Provide --tag vX.Y.Z, --version X.Y.Z, or set RELEASE_TAG.",
  );
  process.exit(1);
}

const version = raw.startsWith("v") ? raw.slice(1) : raw;

// X.Y.Z with optional semver prerelease/build metadata (alpha builds use
// e.g. 0.0.14-alpha.35+9e82c2b).
const versionPattern =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
if (!versionPattern.test(version)) {
  console.error(`Invalid version: ${version} (expected X.Y.Z[-prerelease][+build])`);
  process.exit(1);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, data) => {
  if (dryRun) return;
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
};

const appPath = resolve(root, "apps", "app", "package.json");
const desktopPath = resolve(root, "apps", "desktop", "package.json");
const orchestratorPath = resolve(root, "apps", "orchestrator", "package.json");
const serverPath = resolve(root, "apps", "server", "package.json");
const opencodeRouterPath = resolve(root, "apps", "opencode-router", "package.json");

const appData = readJson(appPath);
const desktopData = readJson(desktopPath);
const orchestratorData = readJson(orchestratorPath);
const serverData = readJson(serverPath);
const opencodeRouterData = readJson(opencodeRouterPath);

appData.version = version;
desktopData.version = version;
// Desktop pins opencodeRouterVersion for sidecar bundling; keep it aligned.
desktopData.opencodeRouterVersion = version;
orchestratorData.version = version;

// legalwork-orchestrator pins exact legalwork-server/opencode-router versions
// (resolved as workspace links at install time; the pins matter for npm publish).
orchestratorData.dependencies = orchestratorData.dependencies ?? {};
orchestratorData.dependencies["legalwork-server"] = version;
orchestratorData.dependencies["opencode-router"] = version;

serverData.version = version;
opencodeRouterData.version = version;

writeJson(appPath, appData);
writeJson(desktopPath, desktopData);
writeJson(orchestratorPath, orchestratorData);
writeJson(serverPath, serverData);
writeJson(opencodeRouterPath, opencodeRouterData);

console.log(
  JSON.stringify(
    {
      ok: true,
      version,
      dryRun,
      files: [
        "apps/app/package.json",
        "apps/desktop/package.json",
        "apps/orchestrator/package.json",
        "apps/server/package.json",
        "apps/opencode-router/package.json",
      ],
    },
    null,
    2,
  ),
);
