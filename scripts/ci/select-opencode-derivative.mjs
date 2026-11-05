// Verify an independently pinned same-run build, without rewriting source policy.
import path from "node:path";
import recipe from "../../packages/opencode-release/build/recipe.json" with { type: "json" };
import { sourceBuildPolicy } from "../../packages/opencode-release/build-policy.mjs";
import { prepareOpencodeEngine } from "../../packages/opencode-release/build/prepare.mjs";
const [manifestPath, manifestSha256, mode = "development"] = process.argv.slice(2);
if (!manifestPath || !/^[a-f0-9]{64}$/.test(manifestSha256 ?? "")) throw new Error("A manifest path and independent producer SHA256 are required.");
if (path.basename(manifestPath) !== "derivative-release.json") throw new Error("The producer handoff must identify its derivative-release.json.");
const prepared = await prepareOpencodeEngine({ mode, targets: recipe.targets, distributionDirectory: path.dirname(path.resolve(manifestPath)), manifestSha256,
  ...(mode === "production" ? { macSigning: sourceBuildPolicy.productionMacSigner } : {}) });
console.log(JSON.stringify(prepared));
