/** Released native plugins carry host-provided @opencode/plugin and effect imports.
 * Every other package must be bundled before the directory is copied outside node_modules. */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isBuiltin } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(__dirname, "..", "server", "dist", "opencode-plugins");

/**
 * Bare specifiers only: "./x" and "../x" resolve next to the file and are fine.
 * A `from "x"` counts only after an import or export keyword with nothing but
 * bindings, braces, commas and `*` in between. Plugin code may hold the string
 * "from" (task tools read a mail's sender under that key), and a bare
 * `from\s*"` pattern took the text up to the next quote for an import.
 */
const IMPORT =
  /\b(?:import|export)\b[\p{ID_Continue}$\s*{},]*?\bfrom\s*["']([^"'.][^"']*)["']|\bimport\s*\(\s*["']([^"'.][^"']*)["']|\bimport\s*["']([^"'.][^"']*)["']/gu;

export function findUnresolvableImports(dir = pluginDir) {
  const offenders = [];
  // Mirrors the electron-builder filter: tests are not packaged and are
  // never loaded as plugins.
  const packaged = (name) => name.endsWith(".js") && !name.endsWith(".test.js");
  const walk = (directory, prefix = "") => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(join(directory, entry.name), join(prefix, entry.name))
    : packaged(entry.name) ? [join(prefix, entry.name)] : []);
  for (const file of walk(dir).sort()) {
    const source = readFileSync(join(dir, file), "utf8");
    const bare = new Set();
    for (const match of source.matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!isBuiltin(specifier) && !/^(?:@opencode\/plugin|effect)(?:\/|$)/.test(specifier)) bare.add(specifier);
    }
    if (bare.size > 0) offenders.push({ file, imports: [...bare].sort() });
  }
  return offenders;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // PR CI passes apps/server/dist/opencode-plugins: electron-build stages its copy only when packaging.
  const offenders = findUnresolvableImports(process.argv[2]);
  if (offenders.length > 0) {
    console.error("Packaged OpenCode plugins carry imports that cannot resolve at runtime:");
    for (const { file, imports } of offenders) console.error(`- ${file}: ${imports.join(", ")}`);
    console.error(
      "They are copied outside every node_modules tree, so the engine skips them silently and their tools never appear.",
    );
    console.error("Bundle the dependency in (apps/server `build` runs bun build over these entry points).");
    process.exit(1);
  }
  console.log("Packaged native plugin imports resolve through the released host or bundled code.");
}
