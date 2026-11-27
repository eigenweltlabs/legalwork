import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RaycastPairing } from "../../desktop/electron/launcher/raycast-pairing.mjs";
import { raycastHandoffUrl, readPairing, requireCurrentPairing } from "../src/pairing.ts";

test("the extension discovers the desktop writer for installed, dev and legacy profiles", async () => {
  const appData = await mkdtemp(path.join(tmpdir(), "legalwork-raycast-"));
  try {
    for (const [folder, scheme] of [
      ["com.eigenweltlabs.legalwork", "legalwork"], ["com.eigenweltlabs.legalwork.dev", "legalwork-dev"], ["LegalWork", "legalwork"],
    ]) {
      const userDataDir = path.join(appData, folder);
      await mkdir(userDataDir);
      const serverInfo = async () => ({ running: true, baseUrl: "http://localhost:31337", hostToken: "fixture-host" });
      const fetch: typeof globalThis.fetch = async () => Response.json({ token: "fixture" });
      const desktop = new RaycastPairing({ userDataDir, scheme, serverInfo, fetch });
      await desktop.enable();
      assert.deepEqual(await readPairing(appData), { scheme, serverUrl: "http://localhost:31337", token: "fixture" });
      await desktop.disable();
      assert.equal(await readPairing(appData), null);
    }
  } finally {
    await rm(appData, { recursive: true, force: true });
  }
});

test("the URL given to the operating system contains only the opaque handoff ID", () => {
  const id = "c556f4eb-0071-422f-9951-088bbbc7aab5";
  const url = new URL(raycastHandoffUrl("legalwork-dev", id));
  assert.equal(url.protocol, "legalwork-dev:");
  assert.equal(url.hostname + url.pathname, "assistant/open");
  assert.deepEqual([...url.searchParams], [["handoff", id]]);
  assert.throws(() => raycastHandoffUrl("legalwork-dev", "Synthetic/Private.md"));
});

test("a displayed row can use only the pairing that issued it", async () => {
  const issuedBy = { serverUrl: "http://127.0.0.1:4123", token: "fixture-old", scheme: "legalwork" };
  assert.equal(await requireCurrentPairing(issuedBy, "Refresh Search", async () => ({ ...issuedBy })), issuedBy);
  for (const current of [null, { ...issuedBy, token: "fixture-new" }, { ...issuedBy, serverUrl: "http://127.0.0.1:4999" }, { ...issuedBy, scheme: "legalwork-dev" }]) {
    await assert.rejects(requireCurrentPairing(issuedBy, "Refresh Search", async () => current), /Refresh Search/);
  }
});

test("the extension ignores a legacy file containing the workspace credential", async () => {
  const appData = await mkdtemp(path.join(tmpdir(), "legalwork-raycast-v1-"));
  try {
    const profile = path.join(appData, "LegalWork");
    await mkdir(profile);
    await writeFile(path.join(profile, "launcher-pairing.json"), JSON.stringify({ enabled: true, version: 1, serverUrl: "http://localhost:31337", token: "fixture-client" }));
    assert.equal(await readPairing(appData), null);
  } finally { await rm(appData, { recursive: true, force: true }); }
});
