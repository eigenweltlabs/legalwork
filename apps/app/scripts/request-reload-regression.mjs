import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
function load(file, imports) {
  const exports = {};
  const source = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, require: imports, AbortController, console });
  return exports;
}
const { startRequestPolling } = load("../src/app/lib/request-poller.ts", () => ({}));
const refs = [], effects = [], changes = [], requests = [], timers = [], pokes = new Set();
let refIndex = 0, effectIndex = 0;
const react = {
  useCallback: callback => callback,
  useState: initial => [initial, () => {}],
  useRef(initial) { const i = refIndex++; return refs[i] ??= { current: initial }; },
  useEffect(callback, dependencies) {
    const i = effectIndex++, previous = effects[i];
    if (!previous || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index]))) {
      changes.push(() => { previous?.cleanup?.(); effects[i] = { dependencies, cleanup: callback() }; });
    }
  },
};
const sync = { live: true, metadata: true, baseUrl: "http://fixture" };
const coordinator = { registerWorkspaceReloadControls: () => () => {}, markReloadRequired() { throw new Error("Historical events must not request reload"); } };
const { useEngineReload } = load("../src/react-app/shell/use-engine-reload.ts", name => {
  if (name === "react") return react;
  if (name.endsWith("/reload-coordinator")) return { useReloadCoordinator: () => coordinator };
  if (name.endsWith("/runtime-env")) return { isDesktopRuntime: () => false };
  if (name.endsWith("/sync-events")) return { useSyncEventsLive: () => sync, onSyncPoke: listener => { pokes.add(listener); return () => pokes.delete(listener); } };
  if (name.endsWith("/request-poller")) return { startRequestPolling: (run, options) => startRequestPolling(run, { ...options, schedule(callback, ms) { const job = { callback, ms, cancelled: false }; timers.push(job); return () => { job.cancelled = true; }; } }) };
  return {};
});
function render(token) {
  refIndex = 0; effectIndex = 0;
  useEngineReload({
    client: { baseUrl: sync.baseUrl }, workspaceId: "ws", workspace: { id: "ws" },
    endpointForWorkspace: () => ({ baseUrl: sync.baseUrl, workspaceId: "ws", token, client: {
      baseUrl: sync.baseUrl,
      listReloadEvents(_id, options) {
        return new Promise((resolve, reject) => {
          requests.push({ token, options, resolve });
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
        });
      },
    } }), activeReloadBlockingSessions: [], onError() {}, refreshRouteState: async () => {},
  });
  for (const change of changes.splice(0)) change();
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
render("first");
assert.equal(requests.length, 1);
render("first");
assert.equal(requests.length, 1, "Equivalent route objects must not restart polling");
requests[0].resolve({ cursor: 12, items: [] }); await settle();
assert.equal(timers.at(-1).ms, 30_000);
render("second");
assert.equal(requests.length, 2);
assert.ok(requests[0].options.signal.aborted, "Credential change must stop the previous poller");
assert.equal(requests[1].token, "second");
assert.equal(requests[1].options.since, undefined, "A credential change needs its own baseline cursor");
for (let i = 0; i < 100; i++) for (const poke of pokes) poke({ reload: true });
assert.equal(requests.length, 2, "Event bursts must not overlap a pending read");
requests[1].resolve({ cursor: 0, items: [] }); await settle();
assert.equal(timers.at(-1).ms, 0);
for (const effect of effects) effect.cleanup?.(); await settle();
assert.ok(requests[1].options.signal.aborted);
assert.equal([...pokes].length, 0);
assert.ok(timers.every(timer => timer.cancelled));
console.log("PASS: actual reload hook keeps one poller, rebinds credentials, isolates cursors and cancels cleanup");
