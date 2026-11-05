import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { downloadOpencodeBinary, opencodeReleaseTarget } from "../electron/opencode-release.mjs";

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const destination = value("--destination");
if (!destination) throw new Error("--destination is required");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const result = await downloadOpencodeBinary({
  destination: resolve(destination), version: value("--version"),
  cacheDirectory: value("--cache-directory") ?? resolve(root, ".cache", "opencode"),
  target: value("--target") ?? opencodeReleaseTarget(process.platform, process.arch, value("--libc")),
});
console.log(`Installed ${result.package}@${result.version} with verified archive integrity at ${result.destination}`);
