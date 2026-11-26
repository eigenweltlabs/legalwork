import { expect, test } from "bun:test";
import { join } from "node:path";
import { z } from "zod";
import { nativeChatResponse, nativeDomainEngine } from "./native-domain-engine.test-support.js";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import { parseEigenweltEntitlements } from "../eigenwelt-auth.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
for (const directTools of [true, false]) test.skipIf(!binary)(`released engine hides firm-disabled search and restores it (direct=${directTools}, BYOK model)`, async () => {
  if (!binary) throw new Error("A released engine is required");
  let enabled = true, policyUnavailable = false;
  let discover = false, discovered = "";
  const catalogs: string[] = [];
  const platform = Bun.serve({ port: 0, async fetch(request) {
    if (new URL(request.url).pathname === "/api/desktop/web-search") {
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-policy-token");
      return policyUnavailable ? new Response("Unavailable", { status: 503 }) : Response.json({ enabled });
    }
    const body = z.object({ tools: z.array(z.unknown()).optional(),
      messages: z.array(z.object({ role: z.string(), content: z.unknown() })),
    }).parse(await request.json());
    if (!body.tools?.length) return nativeChatResponse(undefined, 0); // Auxiliary title requests have no tools.
    catalogs.push(JSON.stringify(body.tools ?? []));
    if (discover) {
      discover = false;
      return nativeChatResponse({ name: "execute", input: { code: 'return search({query:"legalwork",limit:50});' } }, catalogs.length);
    }
    if (!directTools) discovered = JSON.stringify(body.messages.filter(message => message.role === "tool").at(-1)?.content);
    return nativeChatResponse(undefined, catalogs.length);
  } });
  const previous = process.env.EIGENWELT_PLATFORM_URL;
  process.env.EIGENWELT_PLATFORM_URL = platform.url.origin;
  let host: Awaited<ReturnType<typeof nativeDomainEngine>> | undefined;
  try {
    host = await nativeDomainEngine({ binary, directTools, plugins: [join(import.meta.dir, "legalwork-sandbox.ts")],
      modelURL: platform.url.origin + "/v1", configuration: { permissions: [{ action: "*", resource: "*", effect: "allow" }] },
      async setup(config) {
        await writeEigenweltConnection(config, {
          platformURL: platform.url.origin, platformToken: "synthetic-policy-token",
          entitlements: parseEigenweltEntitlements({ plan: "plus", subscriptionStatus: "active", features: ["premium_models"] }),
        });
      },
    });
    const chat = await host.appClient.session.create({ location: host.location, agent: "build" });
    for (const step of [{ enabled: true, unavailable: false }, { enabled: false, unavailable: false },
      { enabled: true, unavailable: false }, { enabled: true, unavailable: true }, { enabled: true, unavailable: false }]) {
      enabled = step.enabled; policyUnavailable = step.unavailable;
      discover = !directTools; discovered = "";
      const before = catalogs.length;
      await host.appClient.session.prompt({ sessionID: chat.id, text: "Check synthetic tool availability." });
      await host.client.session.wait({ sessionID: chat.id }, { signal: AbortSignal.timeout(30_000) });
      expect(catalogs.length).toBeGreaterThan(before);
      // Direct schemas and real Code Mode discovery must agree with the live policy.
      const catalog = directTools ? catalogs.at(-1)! : discovered;
      expect(catalog.includes("legalwork_websearch")).toBe(enabled && !policyUnavailable);
      expect(catalog).toContain("legalwork_webfetch");
      expect(catalog).toContain("legalwork_shell");
      const registered = z.array(z.string()).parse(await host.tools());
      expect(registered.includes("legalwork_websearch")).toBe(enabled && !policyUnavailable);
    }
  } finally {
    await host?.close(); platform.stop(true);
    if (previous === undefined) delete process.env.EIGENWELT_PLATFORM_URL; else process.env.EIGENWELT_PLATFORM_URL = previous;
  }
}, 180_000);
