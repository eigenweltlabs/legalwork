import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LegalWorkExtensionsPreview } from "./legalwork-extensions-preview.js";

const roots: string[] = [];
let originalFetch: typeof globalThis.fetch | null = null;
let previousDiscovery: string | undefined;

afterEach(async () => {
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = null;
  if (previousDiscovery === undefined) delete process.env.LEGALWORK_UI_CONTROL_DISCOVERY;
  else process.env.LEGALWORK_UI_CONTROL_DISCOVERY = previousDiscovery;
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

/** Point the plugin at a fake UI bridge that serves one snapshot payload. */
async function withBridge(snapshot: unknown) {
  const root = await mkdtemp(join(tmpdir(), "legalwork-ui-bridge-"));
  roots.push(root);
  const discovery = join(root, "legalwork-ui-control.json");
  await writeFile(discovery, JSON.stringify({ baseUrl: "http://ui.test", token: "t" }), "utf8");
  previousDiscovery = process.env.LEGALWORK_UI_CONTROL_DISCOVERY;
  process.env.LEGALWORK_UI_CONTROL_DISCOVERY = discovery;

  originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/snapshot")) return Response.json(snapshot);
      return new Response("Not found", { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
}

describe("legalwork_ui_snapshot session identity", () => {
  // Regression: asked "give me the session id of this convo", the agent found
  // no tool carrying it, navigated to the session view, and read an id out of
  // the resulting route — a DIFFERENT session than the one it was running in —
  // then stated it as fact. The engine had the real id in the tool context all
  // along, so the snapshot now carries it.
  test("reports the running session id, not the id in the route", async () => {
    await withBridge({
      ok: true,
      route: "/workspace/ws_84ca3ac552ab/session/ses_someOtherSessionOnScreen",
      status: "ready",
    });

    const plugin = await LegalWorkExtensionsPreview();
    const raw = await plugin.tool.legalwork_ui_snapshot.execute(
      {},
      { sessionID: "ses_theRunningSession", agent: "legalwork", directory: "/Users/lawyer/Matter" },
    );
    const parsed = JSON.parse(raw) as {
      route: string;
      session: { id: string; agent: string; directory: string };
    };

    expect(parsed.session.id).toBe("ses_theRunningSession");
    expect(parsed.session.agent).toBe("legalwork");
    expect(parsed.session.directory).toBe("/Users/lawyer/Matter");
    // The route still reflects the screen, and must stay distinguishable from
    // the running session — that difference is the whole point.
    expect(parsed.route).toContain("ses_someOtherSessionOnScreen");
    expect(parsed.session.id).not.toBe("ses_someOtherSessionOnScreen");
  });

  test("still carries session identity when the bridge reports an error", async () => {
    await withBridge({ ok: false, error: "LegalWork UI bridge not available." });

    const plugin = await LegalWorkExtensionsPreview();
    const raw = await plugin.tool.legalwork_ui_snapshot.execute({}, { sessionID: "ses_abc" });
    const parsed = JSON.parse(raw) as { ok: boolean; session: { id: string } };

    expect(parsed.ok).toBe(false);
    expect(parsed.session.id).toBe("ses_abc");
  });

  test("the tool description sends the agent to session.id rather than the route", async () => {
    const plugin = await LegalWorkExtensionsPreview();
    expect(plugin.tool.legalwork_ui_snapshot.description).toContain("session.id");
    expect(plugin.tool.legalwork_ui_snapshot.description).toContain("never from `route`");
  });
});
