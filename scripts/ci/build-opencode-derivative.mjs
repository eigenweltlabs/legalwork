// Build the reviewed complete engine matrix without publishing it.
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { buildOpencodeDistribution } from "../../packages/opencode-release/build/producer.mjs";
import recipe from "../../packages/opencode-release/build/recipe.json" with { type: "json" };

const [root, ...args] = process.argv.slice(2);
if (!root || process.platform !== "darwin" || process.arch !== "arm64") throw new Error("Use a new output directory on the recipe's pinned macOS ARM64 CI builder.");
const values = {};
for (let index = 0; index < args.length; index += 2) {
  const name = args[index], value = args[index + 1];
  if (!["--mode", "--mac-signing-config"].includes(name) || Object.hasOwn(values, name) || !value || value.startsWith("--")) throw new Error("Expected --mode development|production and optional --mac-signing-config <public-policy.json>.");
  values[name] = value;
}
const macSigning = values["--mac-signing-config"] === undefined ? undefined : JSON.parse(await readFile(values["--mac-signing-config"], "utf8"));
const result = await buildOpencodeDistribution({ outputDirectory: path.resolve(root), targets: recipe.targets, mode: values["--mode"], macSigning });
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `manifest-sha256=${result.manifestSha256}\n`);
console.log(JSON.stringify(result));
