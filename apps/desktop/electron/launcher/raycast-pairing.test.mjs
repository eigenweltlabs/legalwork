import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PAIRING_FILE, RaycastPairing } from "./raycast-pairing.mjs";

test("pairing writes a private credential file while enabled and removes it when disabled", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "raycast-pairing-"));
  try {
    let info = { running: true, baseUrl: "http://127.0.0.1:4123", clientToken: "client-token", ownerToken: "owner-token" };
    const pairing = new RaycastPairing({ userDataDir: dir, serverInfo: async () => info });
    assert.deepEqual(await pairing.load(), { enabled: false, path: null });
    await pairing.enable();
    const file = path.join(dir, PAIRING_FILE);
    const parsed = JSON.parse(await readFile(file, "utf8"));
    assert.equal(parsed.serverUrl, "http://127.0.0.1:4123");
    assert.equal(parsed.token, "client-token");
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    // The server restarted with a new port and token: refresh rewrites the file.
    info = { running: true, baseUrl: "http://127.0.0.1:4999", clientToken: "fresh-client", ownerToken: "fresh-owner" };
    await pairing.refresh();
    assert.equal(JSON.parse(await readFile(file, "utf8")).token, "fresh-client");
    // The owner token never leaves the app: without a client token nothing is rewritten.
    info = { running: true, baseUrl: "http://127.0.0.1:5000", clientToken: null, ownerToken: "owner-only" };
    await pairing.refresh();
    assert.equal(JSON.parse(await readFile(file, "utf8")).token, "fresh-client");
    // A stopped server never writes a stale credential.
    info = { running: false, baseUrl: null, clientToken: null, ownerToken: null };
    await pairing.refresh();
    assert.equal(JSON.parse(await readFile(file, "utf8")).serverUrl, "http://127.0.0.1:4999");
    assert.equal((await new RaycastPairing({ userDataDir: dir, serverInfo: async () => info }).load()).enabled, true);
    await pairing.disable();
    await assert.rejects(stat(file));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
