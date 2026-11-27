import { expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { sandboxEnginePermissions } from "../agent-sandbox/engine-policy.js";
import { nativeChatResponse, nativeDomainEngine } from "./native-domain-engine.test-support.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
for (const directTools of [true, false]) for (const effect of ["allow", "ask", "deny"] satisfies Array<"allow" | "ask" | "deny">)
  test.skipIf(!binary)(`existing webfetch permission controls both web tools (direct=${directTools}, ${effect}, BYOK)`, async () => {
    if (!binary) throw new Error("A released engine is required");
    const catalogs: string[] = [];
    let discover = !directTools, discovered = "";
    const provider = Bun.serve({ port: 0, async fetch(request) {
      const body = z.object({ tools: z.array(z.unknown()).optional(),
        messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
      }).parse(await request.json());
      if (!body.tools?.length) return nativeChatResponse(undefined, 0);
      catalogs.push(JSON.stringify(body.tools));
      if (discover) {
        discover = false;
        return nativeChatResponse({ name: "execute", input: { code: 'return search({query:"legalwork",limit:50});' } }, catalogs.length);
      }
      if (!directTools) discovered = JSON.stringify(body.messages.filter(message => message.role === "tool").at(-1)?.content);
      return nativeChatResponse(undefined, catalogs.length);
    } });
    let host: Awaited<ReturnType<typeof nativeDomainEngine>> | undefined;
    try {
      host = await nativeDomainEngine({ binary, directTools, plugins: [join(import.meta.dir, "legalwork-sandbox.ts")],
        modelURL: provider.url.origin + "/v1", configuration: { permissions: sandboxEnginePermissions([
          { action: "*", resource: "*", effect: "allow" }, { action: "webfetch", resource: "*", effect },
        ]) },
      });
      const chat = await host.appClient.session.create({ location: host.location, agent: "build" });
      await host.appClient.session.prompt({ sessionID: chat.id, text: "Check synthetic tool availability." });
      await host.client.session.wait({ sessionID: chat.id }, { signal: AbortSignal.timeout(30_000) });
      expect(catalogs.length).toBeGreaterThan(0);
      const catalog = directTools ? catalogs.at(-1)! : discovered;
      expect(catalog.includes("legalwork_websearch")).toBe(effect !== "deny");
      expect(catalog.includes("legalwork_webfetch")).toBe(effect !== "deny");
      expect(catalog).toContain("legalwork_shell");
    } finally { await host?.close(); provider.stop(true); }
  }, 60_000);
