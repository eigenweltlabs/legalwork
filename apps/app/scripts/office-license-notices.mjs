// Refresh when upgrading an office editor. Run from apps/app with pnpm exec node.
import { createRequire } from "node:module";
import { readFileSync, readdirSync, existsSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = ["pptx-react-viewer", "@univerjs/core", "@univerjs/themes", "@univerjs/preset-sheets-core", "@xmldom/xmldom", "i18next", "react-i18next", "jszip", "xlsx"];
const visited = new Set();
const entries = [];
function visit(name, from) {
  const require = createRequire(join(from, "package.json"));
  const candidate = (require.resolve.paths("legalwork-license-lookup") ?? []).map((directory) => join(directory, name, "package.json")).find(existsSync);
  if (!candidate) throw new Error(`Cannot resolve ${name}`);
  const file = realpathSync(candidate);
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const key = `${pkg.name}@${pkg.version}`;
  if (visited.has(key)) return;
  visited.add(key);
  const directory = dirname(file);
  const notices = readdirSync(directory).filter((name) => /^(licen[cs]e|notice|copying)([.-]|$)/i.test(name));
  const texts = notices.map((name) => `${name}\n${readFileSync(join(directory, name), "utf8")}`).join("\n\n");
  const license = pkg.license ?? (pkg.name === "@univerjs/telemetry" && texts.includes("Apache License") ? "Apache-2.0 (LICENSE file)" : undefined);
  if (!license || pkg.name.startsWith("@univerjs-pro/")) throw new Error(`Review the license of ${key} before distributing.`);
  entries.push({ key, license, text: texts || `License declaration: ${JSON.stringify(pkg.license)}. Source: ${JSON.stringify(pkg.repository ?? pkg.homepage ?? "")}` });
  for (const dependency of Object.keys(pkg.dependencies ?? {})) visit(dependency, directory);
}
for (const name of roots) visit(name, app);
entries.sort((a, b) => a.key.localeCompare(b.key));
const text = "Legalwork office editor dependency licenses and notices\nGenerated from the pinned installed dependency tree. Dependencies retain their original licenses.\nFor dual-licensed dependencies offering MIT, this distribution uses the MIT option; DOMPurify uses the Apache-2.0 option.\n\n" + entries.map((entry) => `===== ${entry.key} (${JSON.stringify(entry.license)}) =====\n${entry.text}`).join("\n\n");
writeFileSync(join(app, "public/third-party/office-editors/DEPENDENCY_LICENSES.txt"), text);
console.log(`${entries.length} packages; licenses: ${[...new Set(entries.map((entry) => JSON.stringify(entry.license)))].join(", ")}`);
