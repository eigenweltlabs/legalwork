const { existsSync, readFileSync } = require("node:fs");
const path = require("node:path");
const { version } = require("@legalwork/opencode-release/release.json");

// The v2 CLI provides effect and @opencode/plugin as host-instance virtual
// modules. Validate the packaging contract instead of shipping a second copy.
function assertPackagedOpencodeSdk(resources) {
  const bundle = path.join(resources, "opencode-sdk");
  const manifest = JSON.parse(readFileSync(path.join(bundle, "package.json"), "utf8"));
  if (manifest.opencode?.version !== version || manifest.opencode?.runtime !== "released-cli" ||
      JSON.stringify(manifest.opencode?.providedModules) !== JSON.stringify(["@opencode/plugin", "effect"])) {
    throw new Error("Packaged OpenCode host-runtime declaration does not match the pinned engine");
  }
  if (existsSync(path.join(bundle, "node_modules"))) throw new Error("Packaged OpenCode must use the host's plugin/effect modules, without a foreign SDK tree");
  return bundle;
}

module.exports = { assertPackagedOpencodeSdk };
