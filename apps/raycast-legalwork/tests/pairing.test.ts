import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RaycastPairing } from "../../desktop/electron/launcher/raycast-pairing.mjs";
import { readPairing } from "../src/pairing.ts";

test("the extension discovers the desktop writer for installed, dev and legacy profiles", async () => {
  const appData = await mkdtemp(path.join(tmpdir(), "legalwork-raycast-"));
  try {
    for (const [folder, scheme] of [
      ["com.eigenweltlabs.legalwork", "legalwork"], ["com.eigenweltlabs.legalwork.dev", "legalwork-dev"], ["LegalWork", "legalwork"],
    ]) {
      const userDataDir = path.join(appData, folder);
      await mkdir(userDataDir);
      const serverInfo = async () => ({ running: true, baseUrl: "http://localhost:31337", clientToken: "fixture" });
      const desktop = new RaycastPairing({ userDataDir, scheme, serverInfo });
      await desktop.enable();
      assert.deepEqual(await readPairing(appData), { scheme, serverUrl: "http://localhost:31337", token: "fixture" });
      await desktop.disable();
      assert.equal(await readPairing(appData), null);
    }
  } finally {
    await rm(appData, { recursive: true, force: true });
  }
});
