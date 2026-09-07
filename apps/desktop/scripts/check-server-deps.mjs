/**
 * Guards the packaged server's module resolution.
 *
 * electron-build.mjs stages apps/server/dist into apps/desktop/server, so the
 * compiled server lands at app.asar/server/dist/server.js and resolves its bare
 * imports from app.asar/node_modules. electron-builder builds that directory
 * from apps/desktop/package.json -- apps/server/package.json is copied in for
 * metadata, but its dependency list is never installed. Every server runtime
 * dep therefore has to be mirrored into apps/desktop/package.json.
 *
 * Miss one and dev stays green (dev resolves via apps/server/node_modules)
 * while the packaged app dies on launch with "Cannot find package 'x' imported
 * from .../server/dist/server.js". That shipped: `openai` was added to the
 * server for realtime voice and never mirrored here.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "../..");

const readDeps = (path) => JSON.parse(readFileSync(path, "utf8")).dependencies ?? {};

export function findServerDepDrift() {
  const server = readDeps(resolve(repoRoot, "apps/server/package.json"));
  const desktop = readDeps(resolve(desktopRoot, "package.json"));
  return {
    missing: Object.keys(server)
      .filter((name) => !(name in desktop))
      .map((name) => `${name}@${server[name]}`),
    // A drifting range packages a different version than the server was built
    // and tested against.
    mismatched: Object.keys(server)
      .filter((name) => name in desktop && desktop[name] !== server[name])
      .map((name) => `${name} (server ${server[name]}, desktop ${desktop[name]})`),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { missing, mismatched } = findServerDepDrift();
  if (missing.length > 0) {
    console.error("apps/desktop/package.json is missing server runtime deps:");
    for (const dep of missing) console.error(`- ${dep}`);
    console.error("Add them to dependencies so electron-builder packages them into the asar.");
  }
  for (const dep of mismatched) console.error(`Version range drifted from apps/server: ${dep}`);
  if (missing.length > 0 || mismatched.length > 0) process.exit(1);
  console.log("Packaged server deps mirror apps/server.");
}
