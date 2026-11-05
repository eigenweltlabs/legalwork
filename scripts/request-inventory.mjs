import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../apps/app/package.json", import.meta.url));
const ts = require("typescript");
const inventory = { requestDefinitions: [], queryPolicies: [], timers: [], serverRoutes: [], fetchCalls: [], sdkCalls: [] };

async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]))).flat();
}
function owner(node, source) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent)) && parent.name) return parent.name.getText(source);
  }
  return null;
}
for (const dir of ["apps/app/src", "apps/server/src", "apps/desktop/electron"]) {
  for (const file of (await files(join(root, dir))).sort()) {
    if (!/\.(?:tsx?|m?js)$/.test(file) || /\.test\./.test(file)) continue;
    const source = ts.createSourceFile(file, await readFile(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = node => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const name = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : "";
        const location = { file: relative(root, file), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, owner: owner(node, source) };
        if (["requestJson", "requestBinary", "requestStorageUpload", "requestStorageTransfer", "requestForm"].includes(name)) {
          inventory.requestDefinitions.push({ ...location, transport: name, path: node.arguments[1]?.getText(source), options: node.arguments[2]?.getText(source) });
        }
        if (["useQuery", "useInfiniteQuery", "queryOptions", "infiniteQueryOptions", "fetchQuery", "prefetchQuery", "ensureQueryData"].includes(name) && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
          const properties = Object.fromEntries(node.arguments[0].properties.filter(ts.isPropertyAssignment).map(property => [property.name.getText(source), property.initializer.getText(source)]));
          inventory.queryPolicies.push({ ...location, kind: name, key: properties.queryKey, enabled: properties.enabled, interval: properties.refetchInterval, background: properties.refetchIntervalInBackground, staleTime: properties.staleTime, query: properties.queryFn });
        }
        if (["setInterval", "startRequestPolling"].includes(name)) inventory.timers.push({ ...location, kind: name, callback: node.arguments[0]?.getText(source), cadence: node.arguments[1]?.getText(source) });
        if (name === "addRoute") inventory.serverRoutes.push({ ...location, method: node.arguments[1]?.getText(source), path: node.arguments[2]?.getText(source), auth: node.arguments[3]?.getText(source) });
        if (["fetch", "desktopFetch", "desktopReadFetch", "desktopFetchViaMain", "desktopStreamFetch", "fetchDesktopStream", "fetchDesktopText"].includes(name)) inventory.fetchCalls.push({ ...location, transport: expression.getText(source), target: node.arguments[0]?.getText(source) });
        if (ts.isPropertyAccessExpression(expression) && /client/i.test(expression.expression.getText(source)) && !["src", "text", "getState"].includes(name)) inventory.sdkCalls.push({ ...location, call: expression.getText(source) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}
const output = join(root, process.argv[2] ?? "tmp/performance/request-inventory.json");
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(inventory, null, 2) + "\n");
console.log(JSON.stringify(Object.fromEntries(Object.entries(inventory).map(([key, rows]) => [key, rows.length]))));
