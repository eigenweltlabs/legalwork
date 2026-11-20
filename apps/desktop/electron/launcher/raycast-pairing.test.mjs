import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PAIRING_FILE, RaycastPairing } from "./raycast-pairing.mjs";

test("pairing writes a private credential file while enabled and removes it when disabled", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "raycast-pairing-"));
  try {
    let info = { running: true, baseUrl: "http://127.0.0.1:4123", hostToken: "owner-token" };
    let issued = 0, active = null;
    const fetch = async (_url, init) => {
      assert.equal(init.headers["x-legalwork-host-token"], info.hostToken);
      if (init.method === "DELETE") { active = null; return Response.json({ ok: true }); }
      active = `scoped-token-${++issued}`;
      return Response.json({ token: active });
    };
    const pairing = new RaycastPairing({ userDataDir: dir, serverInfo: async () => info, fetch });
    assert.deepEqual(await pairing.load(), { enabled: false, path: null });
    await pairing.enable();
    const file = path.join(dir, PAIRING_FILE);
    const parsed = JSON.parse(await readFile(file, "utf8"));
    assert.equal(parsed.serverUrl, "http://127.0.0.1:4123");
    assert.equal(parsed.version, 2);
    assert.equal(parsed.token, "scoped-token-1");
    assert.equal(JSON.stringify(parsed).includes("owner-token"), false);
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    // The server restarted with a new port and token: refresh rewrites the file.
    info = { running: true, baseUrl: "http://127.0.0.1:4999", hostToken: "fresh-owner" };
    await pairing.refresh();
    assert.equal(JSON.parse(await readFile(file, "utf8")).token, "scoped-token-2");
    // A stopped server never writes a stale credential.
    const running = info;
    info = { running: false, baseUrl: null, hostToken: null };
    await pairing.refresh();
    assert.equal(JSON.parse(await readFile(file, "utf8")).serverUrl, "http://127.0.0.1:4999");
    assert.equal((await new RaycastPairing({ userDataDir: dir, serverInfo: async () => info }).load()).enabled, true);
    info = running;
    await pairing.disable();
    assert.equal(active, null);
    await assert.rejects(stat(file));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("development pairing launches the development app that owns the staged context", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "raycast-dev-pairing-"));
  try {
    const pairing = new RaycastPairing({ userDataDir: dir, scheme: "legalwork-dev", serverInfo: async () => ({ running: true, baseUrl: "http://127.0.0.1:4123", hostToken: "host" }), fetch: async () => Response.json({ token: "scoped" }) });
    await pairing.enable();
    assert.equal(JSON.parse(await readFile(path.join(dir, PAIRING_FILE), "utf8")).scheme, "legalwork-dev");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("consumed commands carry the local server instance that issued the handoff", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "raycast-instance-"));
  try {
    const instanceId = "c556f4eb-0071-422f-9951-088bbbc7aab5";
    const invocation = { id: "fixture", action: "ask", source: "raycast", query: "Synthetic question" };
    const pairing = new RaycastPairing({ userDataDir: dir, serverInfo: async () => ({
      running: true, baseUrl: "http://127.0.0.1:4123", hostToken: "fixture-host", instanceId,
    }), fetch: async url => String(url).endsWith("/pairing") ? Response.json({ token: "fixture" }) : Response.json({ invocation }) });
    await pairing.enable();
    assert.deepEqual(await pairing.consume("fixture"), { ...invocation, raycastServerInstanceId: instanceId });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
