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
    // The inert citation form, not a markdown link: it survives streaming and
    // models emit it far more reliably than a custom URL scheme.
    expect(system).toContain("[[doc:<document_id>|<document title or filename>]]");
    // The interface renders the Sources list, so the model must not write one.
    expect(system).toContain("DO NOT write your own source list");
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
