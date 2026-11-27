import { OpenCode } from "@opencode/client";
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { z } from "zod";
import { writeEigenweltConnection } from "../eigenwelt-connection-store.js";
import { EIGENWELT_BOOTSTRAP_PLATFORM_URL } from "../native-shared-values.js";
import { ensureWikiAgentToken } from "../wiki/agent-access.js";
import { nativeChatResponse, nativeDomainEngine } from "./native-domain-engine.test-support.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;

test.skipIf(!binary)("normal chats can diagnose and only advertise ticket submission after sign-in", async () => {
  const toolsSeen: { names: string[]; messages: unknown[] }[] = [];
  const diagnostics = "legalwork_support_diagnostics";
  const ticket = "legalwork_support_submit_ticket";
  const description = "PDF reading failed";
  const model = Bun.serve({ port: 0, async fetch(request) {
    const body = z.object({ messages: z.array(z.unknown()), tools: z.array(z.object({ function: z.object({ name: z.string() }) })).default([]) }).parse(await request.json());
    if (!body.tools.length) return nativeChatResponse(undefined, 0);
    const names = body.tools.map(tool => tool.function.name);
    toolsSeen.push({ names, messages: body.messages });
    const next = toolsSeen.length === 1 ? { name: "execute", input: { code: `return await tools.${diagnostics}({});` } }
      : toolsSeen.length === 3 ? { name: ticket, input: { description } } : undefined;
    return nativeChatResponse(next, toolsSeen.length);
  } });
  let confirmations = 0;
  let engine: Awaited<ReturnType<typeof nativeDomainEngine>> | undefined;
  try {
    if (!binary) throw new Error("A prepared engine is required.");
    engine = await nativeDomainEngine({
      binary, modelURL: model.url.origin + "/v1", directTools: false, scopedRuntime: true,
      plugins: [resolve(import.meta.dir, "legalwork-support-tools.ts")],
      configuration: { agents: { legalwork: { mode: "primary" } }, permissions: [{ action: "*", resource: "*", effect: "allow" }] },
      setup: async config => {
        config.desktopSupport = {
          confirm: async report => {
            expect(report.description).toBe(description);
            confirmations++;
            return "cancel";
          },
          collectLogs: async () => { throw new Error("The user cancelled."); },
          readChatLog: () => ["PDF not supported. Confidential file name."],
        };
      },
    });
    const appClient = OpenCode.make({
      baseUrl: engine.serverURL + "/workspace/matter/opencode",
      headers: { "X-LegalWork-Host-Token": engine.config.hostToken },
    });
    const session = await appClient.session.create({ location: engine.location, agent: "legalwork", model: { providerID: "fixture", id: "fixture" } });
    await appClient.session.prompt({ sessionID: session.id, text: "Help me diagnose this PDF reading failure." });
    await appClient.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(20_000) });
    expect(toolsSeen[0]?.names).not.toContain(ticket);
    expect(JSON.stringify(toolsSeen[0]?.messages)).toContain("LegalWork support assistant");
    expect(JSON.stringify(toolsSeen[1]?.messages)).toContain("model_capability_unsupported");
    expect(JSON.stringify(toolsSeen[1]?.messages)).not.toContain("Confidential file name");

    await writeEigenweltConnection(engine.config, {
      account: { userId: "user_example", userName: null, userEmail: "example@example.test", orgId: "org_example", orgName: "Example" },
      platformToken: "fixture-token", platformURL: EIGENWELT_BOOTSTRAP_PLATFORM_URL, accessTokenExpiresAt: Date.now() + 600_000,
    });
    const availability = await fetch(engine.serverURL + "/agent/support/ticket", { headers: {
      "X-LegalWork-Wiki-Agent-Token": await ensureWikiAgentToken(engine.config),
      "X-LegalWork-Wiki-Agent-Session": session.id,
      "X-LegalWork-Wiki-Agent-Directory": encodeURIComponent(engine.directory),
    } });
    expect(await availability.json()).toEqual({ available: true });
    expect(toolsSeen).toHaveLength(2);
    await appClient.session.prompt({ sessionID: session.id, text: "Please send a support ticket." });
    await appClient.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(20_000) });
    expect(toolsSeen[2]?.names).toContain(ticket);
    expect(confirmations).toBe(1);
    expect(JSON.stringify(toolsSeen[3]?.messages)).toContain("cancelled");
  } finally {
    await engine?.close();
    model.stop(true);
  }
}, 60_000);
