import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uiBridgeRequest } from "./inapp-document-bridge.js";

test("changing desktop discovery never reuses another profile's cached bridge", async () => {
  const root = await mkdtemp(join(tmpdir(), "legalwork-bridge-discovery-"));
  const previous = process.env.LEGALWORK_UI_CONTROL_DISCOVERY;
  const calls: string[] = [];
  const bridges = ["first", "second"].map(profile => Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      calls.push(profile);
      expect(request.headers.get("authorization")).toBe(`Bearer ${profile}`);
      return Response.json({ ok: true, profile });
    },
  }));
  try {
    for (const [index, bridge] of bridges.entries()) {
      const profile = index === 0 ? "first" : "second";
      const discovery = join(root, `${profile}.json`);
      await writeFile(discovery, JSON.stringify({ baseUrl: bridge.url.origin, token: profile }));
      process.env.LEGALWORK_UI_CONTROL_DISCOVERY = discovery;
      expect(await uiBridgeRequest("/snapshot")).toEqual({ ok: true, profile });
    }
    process.env.LEGALWORK_UI_CONTROL_DISCOVERY = join(root, "missing.json");
    expect(await uiBridgeRequest("/snapshot")).toEqual({ ok: false, error: "LegalWork UI bridge not available. The desktop app may not be running." });
    expect(calls).toEqual(["first", "second"]);
  } finally {
    for (const bridge of bridges) bridge.stop(true);
    if (previous === undefined) delete process.env.LEGALWORK_UI_CONTROL_DISCOVERY;
    else process.env.LEGALWORK_UI_CONTROL_DISCOVERY = previous;
    await rm(root, { recursive: true, force: true });
  }
});
