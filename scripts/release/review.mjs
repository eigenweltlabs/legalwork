import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { opencodeRelease } from "../../packages/opencode-release/index.mjs";
import { verifyDerivativeDistributionContent } from "../../packages/opencode-release/derivative.mjs";
import { sourceBuildPolicy, validateBuildSelection } from "../../packages/opencode-release/build-policy.mjs";
import recipe from "../../packages/opencode-release/build/recipe.json" with { type: "json" };

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);
const outputJson = args.includes("--json");
const strict = args.includes("--strict");

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const readText = (path) => readFileSync(path, "utf8");

const appPkg = readJson(resolve(root, "apps", "app", "package.json"));
const desktopPkg = readJson(resolve(root, "apps", "desktop", "package.json"));
const orchestratorPkg = readJson(
  resolve(root, "apps", "orchestrator", "package.json"),
);
const pinnedOpencodeBaseVersion = String(
  readJson(resolve(root, "constants.json")).opencodeVersion ?? "",
)
  .trim()
  .replace(/^v/, "");
const serverPkg = readJson(resolve(root, "apps", "server", "package.json"));
const preparedSelectionPath = resolve(root, "packages/opencode-release/generated/selection.json");
const selection = existsSync(preparedSelectionPath) ? readJson(preparedSelectionPath) : undefined;

const versions = {
  app: appPkg.version ?? null,
  desktop: desktopPkg.version ?? null,
  server: serverPkg.version ?? null,
  orchestrator: orchestratorPkg.version ?? null,
  opencode: sourceBuildPolicy.version,
  opencodeKind: sourceBuildPolicy.kind,
  opencodeBaseVersion: sourceBuildPolicy.baseVersion,
  opencodeManifestSha256: selection?.manifestSha256 ?? null,
  orchestratorLegalworkServerRange:
    orchestratorPkg.dependencies?.["legalwork-server"] ?? null,
};

const checks = [];
const warnings = [];
let ok = true;

const addCheck = (label, pass, details) => {
  checks.push({ label, ok: pass, details });
  if (!pass) ok = false;
};

const addWarning = (message) => warnings.push(message);

addCheck(
  "App/desktop versions match",
  versions.app && versions.desktop && versions.app === versions.desktop,
  `${versions.app ?? "?"} vs ${versions.desktop ?? "?"}`,
);
addCheck(
  "App/legalwork-orchestrator versions match",
  versions.app &&
    versions.orchestrator &&
    versions.app === versions.orchestrator,
  `${versions.app ?? "?"} vs ${versions.orchestrator ?? "?"}`,
);
addCheck(
  "App/legalwork-server versions match",
  versions.app && versions.server && versions.app === versions.server,
  `${versions.app ?? "?"} vs ${versions.server ?? "?"}`,
);

if (versions.opencode) {
  addCheck(
    "OpenCode version pin exists",
    Boolean(versions.opencode),
    String(versions.opencode),
  );
} else {
  addWarning(
    "OpenCode version is not pinned in selection.json.",
  );
}
addCheck(
  "OpenCode selection matches its base ABI",
  pinnedOpencodeBaseVersion === versions.opencodeBaseVersion && versions.opencodeBaseVersion === opencodeRelease.version,
  `${versions.opencodeKind} ${versions.opencode}; base ABI ${versions.opencodeBaseVersion} vs constants ${pinnedOpencodeBaseVersion || "?"}`,
);
addCheck("OpenCode source policy matches the reviewed recipe", sourceBuildPolicy.kind === "source-build"
  && sourceBuildPolicy.schemaVersion === 1 && sourceBuildPolicy.version === recipe.version && sourceBuildPolicy.baseVersion === recipe.baseVersion,
  `${sourceBuildPolicy.kind} ${sourceBuildPolicy.version}; reviewed source ${recipe.upstream.commit}`);
if (selection) {
  try {
    validateBuildSelection(selection);
    const distribution = await verifyDerivativeDistributionContent({ manifestContent: selection.manifestContent, manifestSha256: selection.manifestSha256 });
    addCheck(
      "OpenCode derivative manifest matches its independent pin and selection",
      distribution.version === versions.opencode && distribution.baseVersion === versions.opencodeBaseVersion,
      `${distribution.version}; base ABI ${distribution.baseVersion}; SHA256 ${distribution.manifestSha256}`,
    );
  } catch (error) {
    addCheck("OpenCode derivative manifest matches its independent pin and selection", false, error.message);
  }
} else {
  addWarning("Engine source policy is pinned; no generated engine build is prepared in this checkout. App preparation will create and verify it before packaging.");
}

const legalworkServerRange = versions.orchestratorLegalworkServerRange ?? "";
const legalworkServerPinned = /^\d+\.\d+\.\d+/.test(legalworkServerRange);
if (!legalworkServerRange) {
  addWarning("legalwork-orchestrator is missing an legalwork-server dependency.");
} else if (!legalworkServerPinned) {
  addWarning(
    `legalwork-orchestrator legalwork-server dependency is not pinned (${legalworkServerRange}).`,
  );
} else {
  addCheck(
    "Legalwork-server dependency matches server version",
    versions.server && legalworkServerRange === versions.server,
    `${legalworkServerRange} vs ${versions.server ?? "?"}`,
  );
}

const sidecarManifestPath = resolve(
  root,
  "apps",
  "orchestrator",
  "dist",
  "sidecars",
  "legalwork-orchestrator-sidecars.json",
);
if (existsSync(sidecarManifestPath)) {
  const manifest = readJson(sidecarManifestPath);
  addCheck(
    "Sidecar manifest version matches legalwork-orchestrator",
    versions.orchestrator && manifest.version === versions.orchestrator,
    `${manifest.version ?? "?"} vs ${versions.orchestrator ?? "?"}`,
  );
  const serverEntry = manifest.entries?.["legalwork-server"]?.version;
  if (serverEntry) {
    addCheck(
      "Sidecar manifest legalwork-server version matches",
      versions.server && serverEntry === versions.server,
      `${serverEntry ?? "?"} vs ${versions.server ?? "?"}`,
    );
  }
} else {
  addWarning(
    "Sidecar manifest missing (run pnpm --filter legalwork-orchestrator build:sidecars).",
  );
}

if (!process.env.SOURCE_DATE_EPOCH) {
  addWarning(
    "SOURCE_DATE_EPOCH is not set (sidecar manifests will include current time).",
  );
}

const report = { ok, versions, checks, warnings };

if (outputJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("Release review");
  for (const check of checks) {
    const status = check.ok ? "ok" : "fail";
    console.log(`- ${status}: ${check.label} (${check.details})`);
  }
  if (warnings.length) {
    console.log("Warnings:");
    for (const warning of warnings) {
      console.log(`- ${warning}`);
    }
  }
}

if (strict && !ok) {
  process.exit(1);
}
