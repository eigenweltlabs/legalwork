import { describe, expect, test } from "bun:test";
import { LegalWorkLegalMemoryKnowledge } from "./legalwork-legalmemory-knowledge.js";

function statusClient(statuses: Record<string, { status: string }>) {
  return {
    mcp: {
      status: async (_options: { directory?: string }) => ({ data: statuses }),
    },
  };
}

describe("LegalWork LegalMemory knowledge plugin", () => {
  test("pushes the use-LegalMemory-first section when the server is connected", async () => {
    const plugin = await LegalWorkLegalMemoryKnowledge({
      directory: "/tmp/ws",
      client: statusClient({ legalmemory: { status: "connected" } }),
    });
    const output: { system: string[] } = { system: [] };

    await plugin["experimental.chat.system.transform"](null, output);

    const system = output.system.join("\n");
    expect(system).toContain("LegalMemory is connected");
    expect(system).toContain("SEARCH LEGALMEMORY FIRST");
    // The markdown-link form, which is what the model measurably emits.
    expect(system).toContain("[<document title>](legalmemory://document/<document_id>)");
    // The interface renders the Sources list, so the model must not write one.
    expect(system).toContain("DO NOT write your own \"Sources\"");
  });

  test("recognizes the appliance's own sample server name", async () => {
    const plugin = await LegalWorkLegalMemoryKnowledge({
      directory: "/tmp/ws",
      client: statusClient({ "knowledge-index": { status: "connected" } }),
    });
    const output: { system: string[] } = { system: [] };

    await plugin["experimental.chat.system.transform"](null, output);

    expect(output.system.join("\n")).toContain("LegalMemory is connected");
  });

  test("stays silent when the server is configured but not connected", async () => {
    const plugin = await LegalWorkLegalMemoryKnowledge({
      directory: "/tmp/ws",
      client: statusClient({ legalmemory: { status: "needs_auth" }, notion: { status: "connected" } }),
    });
    const output: { system: string[] } = { system: [] };

    await plugin["experimental.chat.system.transform"](null, output);

    expect(output.system).toEqual([]);
  });

  // Failing open is deliberate: guidance over absent tools is cosmetic, silence
  // over a connected appliance costs the whole feature.
  test("still speaks when the status check tells us nothing", async () => {
    const plugin = await LegalWorkLegalMemoryKnowledge({ directory: "/tmp/ws" });
    const output: { system: string[] } = { system: [] };

    await plugin["experimental.chat.system.transform"](null, output);

    expect(output.system.join("\n")).toContain("LegalMemory is connected");
  });

  test("still speaks when the status map is empty", async () => {
    const plugin = await LegalWorkLegalMemoryKnowledge({
      directory: "/tmp/ws",
      client: statusClient({}),
    });
    const output: { system: string[] } = { system: [] };

    await plugin["experimental.chat.system.transform"](null, output);

    expect(output.system.join("\n")).toContain("LegalMemory is connected");
  });
});
