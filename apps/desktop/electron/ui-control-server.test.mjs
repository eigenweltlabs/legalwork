import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createUiControlServer } from "./ui-control-server.mjs";

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
