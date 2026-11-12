/** Released native plugins carry host-provided @opencode/plugin and effect imports.
 * Every other package must be bundled before the directory is copied outside node_modules. */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { init, parse } from "es-module-lexer";
import { isBuiltin } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(__dirname, "..", "dist", "opencode-plugins");

await init();

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
    const [imports] = parse(source, file);
    for (const { specifier } of imports) {
      if (!specifier || specifier.startsWith(".")) continue;
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
