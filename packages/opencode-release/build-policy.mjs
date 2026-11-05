import { createHash } from "node:crypto";
import policy from "./selection.json" with { type: "json" };
import recipe from "./build/recipe.json" with { type: "json" };
import release from "./release.json" with { type: "json" };

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const sourceBuildPolicy = Object.freeze({ ...policy, ...(policy.productionMacSigner ? { productionMacSigner: Object.freeze({ ...policy.productionMacSigner }) } : {}) });
export const sourcePolicySha256 = digest(policy);
export const recipePolicySha256 = digest(recipe);

/** A generated build identity supplements the committed source policy; it
 * cannot choose another engine or turn a development build into production. */
export function validateBuildSelection(selection) {
  // Historical official-build fixtures declare their own immutable policy.
  // The normal source policy never reaches this branch or falls back to it.
  if (policy.kind === "official" && policy.schemaVersion === 1 && policy.version === release.version && policy.baseVersion === release.version) {
    if (JSON.stringify(selection) !== JSON.stringify(policy)) throw new Error("The prepared official engine differs from its compiled policy.");
    return selection;
  }
  if (policy.schemaVersion !== 1 || policy.kind !== "source-build" || policy.version !== recipe.version || policy.baseVersion !== recipe.baseVersion) {
    throw new Error("The committed engine source policy does not match its reviewed recipe.");
  }
  if (selection.schemaVersion !== 1 || selection.kind !== "derivative" || selection.version !== policy.version || selection.baseVersion !== policy.baseVersion
    || selection.build?.schemaVersion !== 1 || !["development", "production"].includes(selection.build.mode)
    || selection.build.sourcePolicySha256 !== sourcePolicySha256 || selection.build.recipeSha256 !== recipePolicySha256
    || !validHash(selection.build.sourceKey)) throw new Error("The prepared engine is missing or stale; run pnpm engine:prepare for the current source policy.");
  if (typeof selection.manifestContent !== "string" || !validHash(selection.manifestSha256)
    || createHash("sha256").update(selection.manifestContent).digest("hex") !== selection.manifestSha256) throw new Error("The prepared engine manifest does not match its build pin.");
  const manifest = JSON.parse(selection.manifestContent);
  if (selection.build.mode === "production" && (manifest.schemaVersion !== 1 || manifest.scope !== undefined)) throw new Error("A production engine requires the complete reviewed target distribution.");
  if (selection.downloadBaseUrl !== undefined) throw new Error("Source-built engines are bundled during preparation; a runtime download URL is not permitted.");
  return selection;
}
