// Stage only an explicitly chosen private benchmark profile, never a production
// home/workspace. Uses a separate native authored config and the normal
// LegalWork project approval/reload endpoints; generated selections stay intact.
import { execFileSync } from "node:child_process";
import { chmod, readFile as readBuiltFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { discoverElectron, createDriver } from "./electron-runner.mjs";
import { privateWrite, sha256 } from "./evidence.mjs";
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const root = option("--root");
const repo = option("--repo");
if (!root || !repo) throw new Error("--root and --repo are required");
const privateRoot = resolve(root);
const repository = resolve(repo);
if (privateRoot === repository || privateRoot.startsWith(`${repository}/`))
  throw new Error("Observer profile must be outside the checkout");
const connection = await discoverElectron(
  join(privateRoot, "electron"),
  join(privateRoot, "workspace"),
);
const driver = createDriver(
  connection,
  join(privateRoot, `observer-setup-${Date.now()}`),
);
const info = await driver.engine("/api/info");
if (!info.version?.startsWith("2."))
  throw new Error(
    "The observer is only for an isolated native v2 candidate, never the frozen v1 baseline",
  );
const require = createRequire(join(repository, "apps/server/package.json"));
const observerSource = await readFile(
  fileURLToPath(new URL("./catalog-observer.mjs", import.meta.url)),
  "utf8",
);
const source = observerSource.replace(
  'from "zod/v4/core"',
  `from ${JSON.stringify(require.resolve("zod/v4/core"))}`,
);
const pluginDirectory = join(privateRoot, "observation", "catalog-observer");
const path = join(pluginDirectory, "index.mjs");
const sourcePath = join(pluginDirectory, "source.mjs");
await privateWrite(sourcePath, source);
// Match the real app's plugin packaging: bundle Zod while using the released
// engine's own Effect runtime. Importing another Effect copy can break its host.
execFileSync(
  "bun",
  [
    "build",
    sourcePath,
    "--target=node",
    "--format=esm",
    "--external=effect",
    `--outfile=${path}`,
  ],
  { stdio: "pipe", cwd: repository },
);
await chmod(path, 0o600);
const staged = await readBuiltFile(path);
const headers = { authorization: `Bearer ${connection.token}`, "content-type": "application/json" };
const endpoint = `${connection.base}/workspace/${connection.workspace.id}`;
const initialReviewResponse = await fetch(`${endpoint}/engine-project`, { headers });
if (!initialReviewResponse.ok) throw new Error(`Isolated project review HTTP ${initialReviewResponse.status}`);
const initialReview = await initialReviewResponse.json();
const authoredPath = [join(privateRoot, "workspace", ".opencode", "opencode.jsonc"), join(privateRoot, "workspace", "opencode.jsonc")]
  .find(path => resolve(path) !== resolve(initialReview.projection.path ?? "/"));
if (!authoredPath) throw new Error("No separate authored fixture config path is available");
let existingContent;
try { existingContent = await readFile(authoredPath, "utf8"); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const configFile = { content: existingContent };
const { parse, modify, applyEdits } = require("jsonc-parser");
const raw = configFile.content?.trim() ? configFile.content : "{}\n";
const errors = [];
const config = parse(raw, errors);
if (
  errors.length ||
  !config ||
  typeof config !== "object" ||
  Array.isArray(config)
)
  throw new Error("Isolated project config is invalid; refusing to replace it");
const existing = config.plugins ?? [];
if (!Array.isArray(existing))
  throw new Error(
    "Native plugins config is not an array; manual review required",
  );
const pluginTarget = pluginDirectory;
const updated = applyEdits(
  raw,
  modify(
    raw,
    ["plugins"],
    [...existing.filter((value) => value !== pluginTarget), pluginTarget],
    { formattingOptions: { insertSpaces: true, tabSize: 2 } },
  ),
);
await privateWrite(join(privateRoot, "observation", "registration.json"), {
  timestamp: new Date().toISOString(),
  engineVersion: info.version,
  sourceSha256: sha256(observerSource),
  stagedSha256: sha256(staged),
  pluginTarget,
  authoredPath,
  scope: "isolated-candidate-only",
  registeredModelTools: 0,
  changedPrompt: false,
  changedPolicy: false,
  changedTransforms: false,
  configBeforeSha256: sha256(raw),
  configAfterSha256: sha256(updated),
});
// Instrumentation is declared in a separate standard native authored file.
// Never edit LegalWork's generated selection document or a production profile.
await privateWrite(join(privateRoot, "observation", "config.before.jsonc"), raw);
await privateWrite(authoredPath, updated);
// The user approved this exact read-only observer for the isolated benchmark.
// Approve only that new executable identity; unrelated pending targets stop setup.
const reviewResponse = await fetch(`${endpoint}/engine-project`, { headers });
if (!reviewResponse.ok) throw new Error(`Isolated project approval read HTTP ${reviewResponse.status}`);
const review = await reviewResponse.json();
if (resolve(review.directory) !== resolve(join(privateRoot, "workspace"))) throw new Error("Observer approval scope does not match the isolated workspace");
const pending = review.plugins.filter(plugin => !plugin.approved).map(plugin => plugin.target);
if (pending.some(target => target !== pluginTarget)) throw new Error("Other project plugins require explicit review; observer setup did not approve them");
if (review.state === "approval_required") {
  const approved = await fetch(`${endpoint}/engine-project/approve`, { method: "POST", headers, body: JSON.stringify({ directory: review.directory, pluginTargets: pending }) });
  if (!approved.ok) throw new Error(`Isolated observer project approval HTTP ${approved.status}`);
  await privateWrite(join(privateRoot, "observation", "approval.json"), { reviewed: review, result: await approved.json(), reason: "User-approved exact read-only observer and synthetic private benchmark folder; no unrelated executable identities approved." });
}
const reload = await fetch(`${endpoint}/engine/reload`, {
  method: "POST",
  headers,
  body: JSON.stringify({ reason: "benchmark-observer-setup" }),
});
if (!reload.ok)
  throw new Error(`Isolated observer reload HTTP ${reload.status}`);
await driver.engine(
  `/api/model?${new URLSearchParams({ "location[directory]": connection.workspace.path })}`,
);
console.log(
  JSON.stringify({
    configured: true,
    engineVersion: info.version,
    observer: "legalwork-benchmark-observer",
    registeredModelTools: 0,
    paidCalls: 0,
    evidence: join(privateRoot, "observation", "registration.json"),
  }),
);
