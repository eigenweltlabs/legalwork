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
    expect(system).toContain("legalmemory://document/<document_id>");
    expect(system).toContain("legalmemory://matter/<matter_id>");
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

  test("stays silent when the status check is unavailable", async () => {
    const plugin = await LegalWorkLegalMemoryKnowledge({ directory: "/tmp/ws" });
    const output: { system: string[] } = { system: [] };

    await plugin["experimental.chat.system.transform"](null, output);

    expect(output.system).toEqual([]);
  });
});
