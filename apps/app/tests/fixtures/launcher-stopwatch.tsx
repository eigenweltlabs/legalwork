import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { StopwatchAction, StopwatchState } from "@legalwork/types/time-capture";

const window = new Window({ url: "http://localhost" });
for (const [key, value] of Object.entries({
  window, document: window.document, navigator: window.navigator, localStorage: window.localStorage,
  HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement, HTMLTextAreaElement: window.HTMLTextAreaElement,
  Element: window.Element, Node: window.Node, NodeFilter: window.NodeFilter, Event: window.Event,
  MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, key, { value, configurable: true });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createLegalworkServerClient } = await import("../../src/app/lib/legalwork-server");
const { LauncherStopwatch, useLauncherStopwatch } = await import("../../src/react-app/launcher/launcher-stopwatch");
const { useTimeWorkspaceStopwatch } = await import("../../src/react-app/domains/back-office/time-workspace-stopwatch");

let state: StopwatchState = { profileId: "a".repeat(64), enabled: true, active: null, lastStopped: null };
let loseStartReply = true;
let failMatters = true;
let directoryReads = 0;
let closeCount = 0;
let openedTime = 0;
const actions: StopwatchAction[] = [];
const client = {
  ...createLegalworkServerClient({ baseUrl: "http://localhost" }),
  activityProfile: async () => ({ profileId: state.profileId, directoryId: "local", scope: "local", user: "test", principal: "test", enabled: state.enabled, workspaceActivity: false }),
  privateStopwatch: async (action?: StopwatchAction, profileId?: string, includeMatters?: boolean) => {
    assert.equal(profileId, state.profileId, "Never mutate the previous account");
    if (includeMatters) { directoryReads++; if (failMatters) throw new Error("Directory offline"); }
    if (action) {
      actions.push(action);
      if (action.type === "start") {
        assert.equal(state.active, null, "There must be only one timer");
        state.active = { id: action.id, startedAt: new Date(Date.now() - 2000).toISOString(), matterId: action.matterId ?? null, note: action.note };
        if (loseStartReply) { loseStartReply = false; throw new Error("Lost reply after saving"); }
      } else if (action.type === "stop") {
        assert.equal(action.id, state.active?.id);
        state.active = null; state.lastStopped = { id: action.id, stoppedAt: new Date().toISOString(), date: "2026-11-27" };
      } else {
        assert.ok(state.active); state.active.matterId = action.matterId;
      }
    }
    return structuredClone({ ...state, ...(includeMatters ? { matters: [{ id: "matter-a", name: "Test matter" }] } : {}) });
  },
};
const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const host = document.createElement("div"); document.body.append(host);
const root = createRoot(host);
const formState = () => {};
function Harness() {
  const timer = useLauncherStopwatch(client, true);
  // A second surface sees the same cache, like the main Time workspace.
  const shared = useTimeWorkspaceStopwatch(client, timer.profileId, true);
  return <><output data-shared>{shared.data?.active?.id ?? "idle"}</output>
    <LauncherStopwatch key={timer.profileId ?? "loading"} client={client} timer={timer} onClose={() => { closeCount++; }}
      onOpenApp={() => { openedTime++; }} onFormStateChange={formState} /></>;
}
async function flush() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); }
function form() { const value = host.querySelector("form"); assert.ok(value); return value; }
function button(text: string) {
  const value = [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes(text));
  assert.ok(value, `Missing ${text}: ${host.textContent}`); return value;
}
async function confirm() {
  await act(async () => form().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true })));
  await flush();
}
try {
  await act(async () => root.render(<QueryClientProvider client={cache}><Harness /></QueryClientProvider>));
  await flush(); await flush();
  assert.equal(actions.length, 0, "Opening must never start a timer or create a chat");
  assert.equal(directoryReads, 1, "Fetch the matter directory only for the editor");
  assert.ok(host.textContent?.includes("Matters could not be loaded"));
  assert.equal(button("Start stopwatch").disabled, false, "Unassigned timing works without a directory");
  await confirm();
  assert.equal(actions.length, 1, "A lost successful reply must not duplicate Start");
  assert.equal(actions[0].type, "start");
  assert.equal(state.active?.matterId, null);
  assert.equal(host.querySelector("[data-shared]")?.textContent, state.active?.id);
  assert.ok(host.querySelector('[role="timer"]'));
  assert.ok(button("Stop stopwatch"));
  // A native/HUD update that disables capture must still allow stopping an existing run.
  state.enabled = false;
  await act(async () => { await cache.invalidateQueries({ queryKey: ["private-stopwatch"] }); });
  await flush(); await confirm();
  assert.equal(actions.length, 2); assert.equal(actions[1].type, "stop");
  assert.equal(host.querySelector("[data-shared]")?.textContent, "idle");
  assert.ok(host.textContent?.includes("saved for review"));
  assert.ok(host.textContent?.includes("Time tracking is turned off"));
  await confirm(); assert.equal(actions.length, 2, "Disabled capture cannot start a new timer");
  await act(async () => button("Open Time in app").click());
  assert.equal(openedTime, 1);
  await act(async () => form().dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(closeCount, 1);
  failMatters = false;
  state = { profileId: "b".repeat(64), enabled: true, active: null, lastStopped: null };
  await act(async () => { await cache.invalidateQueries({ queryKey: ["time-tracking-profile"] }); });
  await flush(); await flush();
  assert.ok(button("Start stopwatch"));
  assert.ok(!host.textContent?.includes("Stopwatch time saved for review."), "Account switches clear the editor's previous success state");
  const picker = host.querySelector<HTMLInputElement>('input[role="combobox"]');
  assert.ok(picker);
  await act(async () => {
    picker.focus();
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(picker, "Test matter");
    picker.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await flush();
  await act(async () => picker.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
  await act(async () => picker.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  await flush();
  assert.equal(actions.length, 2, "Choosing a matter must not start the timer");
  await confirm();
  assert.equal(actions.length, 3); assert.ok(state.active);
  assert.equal(state.active.matterId, "matter-a", "Keyboard-selected matter is sent to the shared timer");
  console.log("Launcher stopwatch regressions passed");
} finally {
  await act(async () => root.unmount()); cache.clear(); await window.happyDOM.close();
}
