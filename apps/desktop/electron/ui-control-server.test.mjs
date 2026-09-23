import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createUiControlServer } from "./ui-control-server.mjs";

function stubWindow() {
  return {
    show: () => {}, isMinimized: () => false, restore: () => {}, focus: () => {},
    webContents: { executeJavaScript: async () => ({ ok: true }) },
  };
}

test("the discovery file holding the token is readable only by its owner", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-ui-perm-"));
  const bridge = createUiControlServer({
    appName: "test", appIdentifier: "test", getUserDataDir: () => root, getWindow: async () => stubWindow(),
  });
  t.after(async () => {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  });

  await bridge.start();
  const discoveryPath = path.join(root, "legalwork-ui-control.json");
  const mode = (await stat(discoveryPath)).mode & 0o777;
  assert.equal(mode.toString(8), "600", "group and other must not be able to read the bearer token");
});

test("only the exact bearer token is accepted", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-ui-auth-"));
  const bridge = createUiControlServer({
    appName: "test", appIdentifier: "test", getUserDataDir: () => root, getWindow: async () => stubWindow(),
  });
  t.after(async () => {
    await bridge.stop();
    await rm(root, { recursive: true, force: true });
  });

  await bridge.start();
  const { baseUrl, token } = JSON.parse(await readFile(path.join(root, "legalwork-ui-control.json"), "utf8"));
  const status = async (authorization) => (
    await fetch(`${baseUrl}/actions`, { headers: authorization ? { authorization } : {} })
  ).status;

  assert.equal(await status(`Bearer ${token}`), 200);
  assert.equal(await status(undefined), 401);
  assert.equal(await status(""), 401);
  // A correct prefix, a longer guess, and the bare token must all fail.
  assert.equal(await status(`Bearer ${token.slice(0, -1)}`), 401);
  assert.equal(await status(`Bearer ${token}x`), 401);
  assert.equal(await status(token), 401);
});

test("agent commands execute in a minimized window without stealing focus", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "legalwork-ui-focus-"));
  const calls = [];
  const previousDiscovery = process.env.LEGALWORK_UI_CONTROL_DISCOVERY;
  const bridge = createUiControlServer({
    appName: "test", appIdentifier: "test", getUserDataDir: () => root,
    getWindow: async () => ({
      show: () => calls.push("show"), isMinimized: () => true,
      restore: () => calls.push("restore"), focus: () => calls.push("focus"),
      webContents: { executeJavaScript: async (_expression, userGesture) => { calls.push({ userGesture }); return { ok: true }; } },
    }),
  });
  try {
    await bridge.start();
    const { baseUrl, token } = JSON.parse(await readFile(path.join(root, "legalwork-ui-control.json"), "utf8"));
    for (const actionId of ["documents.open", "office.agent_tool", "document.agent_tool", "markdown.agent_tool"]) {
      const response = await fetch(`${baseUrl}/execute`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ actionId }) });
      assert.equal(response.status, 200);
    }
    assert.deepEqual(calls, Array.from({ length: 4 }, () => ({ userGesture: false })));
    calls.length = 0;
    await fetch(`${baseUrl}/execute`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ actionId: "settings.panel.open", focus: true }) });
    assert.deepEqual(calls, ["show", "restore", "focus", { userGesture: true }]);
    assert.equal((await fetch(`${baseUrl}/execute`, { method: "POST", body: "{}" })).status, 401);
  } finally {
    await bridge.stop();
    if (previousDiscovery === undefined) delete process.env.LEGALWORK_UI_CONTROL_DISCOVERY;
    else process.env.LEGALWORK_UI_CONTROL_DISCOVERY = previousDiscovery;
    await rm(root, { recursive: true, force: true });
  }
});
