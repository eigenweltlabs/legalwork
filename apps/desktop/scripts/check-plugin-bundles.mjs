/**
 * Guards the packaged OpenCode plugins' module resolution.
 *
 * electron-builder copies server/dist/opencode-plugins to
 * Resources/opencode-plugins, outside the asar and outside every node_modules
 * tree. The engine loads each file by URL, so a bare import in one of them has
 * nothing to resolve against: node: builtins are all a plugin may rely on.
 * Everything else has to be bundled in.
 *
 * A plugin that fails to import is skipped silently -- no error, no log, the
 * tools simply never register. Dev stays green because it loads the TypeScript
 * straight out of apps/server/src, where the repo's node_modules is right
 * there. That shipped: `bun build` was writing its bundles to a nested
 * dist/opencode-plugins/src/opencode-plugins/, so the flat tsc output was
 * packaged instead, and six plugins (Word, Excel, PowerPoint, benchmark,
 * extensions preview, skill tools) lost every tool to a bare `zod` import.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(__dirname, "..", "server", "dist", "opencode-plugins");

/** Bare specifiers only: "./x" and "../x" resolve next to the file and are fine. */
const IMPORT = /\bfrom\s*["']([^"'.][^"']*)["']|\bimport\s*\(\s*["']([^"'.][^"']*)["']/g;

export function findUnresolvableImports(dir = pluginDir) {
  const offenders = [];
  // Mirrors the electron-builder filter: tests are not packaged and are
  // never loaded as plugins.
  const packaged = (name) => name.endsWith(".js") && !name.endsWith(".test.js");
  for (const file of readdirSync(dir).filter(packaged).sort()) {
    const source = readFileSync(join(dir, file), "utf8");
    const bare = new Set();
    for (const match of source.matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2];
      if (!specifier.startsWith("node:")) bare.add(specifier);
    }
    if (bare.size > 0) offenders.push({ file, imports: [...bare].sort() });
  }
  return offenders;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const offenders = findUnresolvableImports();
  if (offenders.length > 0) {
    console.error("Packaged OpenCode plugins carry imports that cannot resolve at runtime:");
    for (const { file, imports } of offenders) console.error(`- ${file}: ${imports.join(", ")}`);
    console.error(
      "They are copied outside every node_modules tree, so the engine skips them silently and their tools never appear.",
    );
    console.error("Bundle the dependency in (apps/server `build` runs bun build over these entry points).");
    process.exit(1);
  }
  console.log("Packaged OpenCode plugins are self-contained.");
}
