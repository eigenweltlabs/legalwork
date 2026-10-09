import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";

function loadPreload(file, bridgeName) {
  const messages = [];
  const ipc = Object.assign(new EventEmitter(), {
    send: (...args) => messages.push(args),
    invoke: async (...args) => { messages.push(args); return "ok"; },
  });
  const exposed = new Map();
  const classes = new Set();
  const documentElement = { dataset: {}, classList: { add: (name) => classes.add(name) } };
  // Sandboxed preloads can require electron but cannot import ESM or Node APIs.
  vm.runInNewContext(readFileSync(new URL(file, import.meta.url), "utf8"), {
    require: (name) => {
      assert.equal(name, "electron");
      return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld: (name, value) => {
        assert.equal(name, bridgeName);
        exposed.set(name, value);
      } } };
    },
    process: { platform: "darwin", versions: { electron: "35.0.0" } },
    window: { addEventListener() {}, dispatchEvent() {} },
    document: { documentElement, addEventListener() {} },
  }, { filename: file });
  return { bridge: exposed.get(bridgeName), ipc, messages, documentElement, classes };
}

test("main preload runs with sandbox APIs and preserves native invocation and events", async () => {
  const { bridge, ipc, messages, documentElement, classes } = loadPreload("./preload.cjs", "__LEGALWORK_ELECTRON__");
  assert.equal(await bridge.invokeDesktop("workspaceList"), "ok");
  assert.deepEqual(messages[0], ["legalwork:desktop", "workspaceList"]);
  assert.equal(bridge.meta.platform, "darwin");
  assert.equal(await bridge.system.getArchitectureDownload(), "ok");
  assert.deepEqual(messages[1], ["legalwork:system:architecture-download"]);
  assert.equal(documentElement.dataset.legalworkShell, "electron");
  assert.equal(classes.has("legalwork-electron"), true);
  let calls = 0;
  const unsubscribe = bridge.audio.onEvent(() => calls++);
  ipc.emit("legalwork:audio:event", {}, { kind: "transcript" });
  unsubscribe();
  ipc.emit("legalwork:audio:event", {}, { kind: "transcript" });
  assert.equal(calls, 1);
});

test("menu and call preloads preserve their sandboxed IPC bridges", () => {
  const menu = loadPreload("./menu-overlay-preload.cjs", "__LEGALWORK_MENU_OVERLAY__");
  menu.bridge.ready();
  assert.deepEqual(menu.messages[0], ["legalwork:menu-overlay:ready"]);
  menu.ipc.emit("legalwork:menu-overlay:show", {}, { id: "request" });
  const requests = [];
  menu.bridge.onShow((value) => { requests.push(value); });
  assert.equal(requests[0].id, "request");
  const overlay = loadPreload("./audio/call-overlay-preload.cjs", "__LEGALWORK_CALL_OVERLAY__");
  overlay.bridge.ask("ask-1", "Question");
  assert.deepEqual(overlay.messages[0], ["legalwork:audio:overlay-ask", "ask-1", "Question"]);
  assert.equal(overlay.bridge.platform, "darwin");
});


test("approval bridge preserves the pending request and only replies to its current id", () => {
  const { bridge, ipc, messages } = loadPreload("./preload.cjs", "__LEGALWORK_ELECTRON__");
  const request = { id: "test-approval" };
  ipc.emit("legalwork:approval:show", {}, request);
  const shown = [];
  const unsubscribe = bridge.approvals.onChange((value) => shown.push(value));
  assert.equal(shown[0], request);
  bridge.approvals.reply("stale-id", "allow");
  bridge.approvals.reply(request.id, "always");
  bridge.approvals.reply(request.id, "deny");
  assert.deepEqual(messages, [["legalwork:approval:reply", request.id, "deny"]]);
  ipc.emit("legalwork:approval:dismiss", {}, "stale-id");
  assert.equal(shown.length, 1);
  ipc.emit("legalwork:approval:dismiss", {}, request.id);
  assert.equal(shown[1], null);
  unsubscribe();
  ipc.emit("legalwork:approval:show", {}, request);
  assert.equal(shown.length, 2);
});
