import { describe, expect, test } from "bun:test";
import { LegalWorkCapabilitiesKnowledge } from "./legalwork-capabilities-knowledge.js";

describe("LegalWork capabilities knowledge plugin", () => {
  test("injects local desktop product guidance", async () => {
    const plugin = await LegalWorkCapabilitiesKnowledge();
    const output: { system: string[] } = { system: [] };

    await plugin["experimental.chat.system.transform"](null, output);

    expect(output.system.join("\n")).toContain("local-first desktop app");
    expect(output.system.join("\n")).toContain("workspace-relative path");
  });

  test("resolves Windows project paths across separators and case without matching neighbouring folders", async () => {
    const previousUrl = process.env.LEGALWORK_SERVER_URL;
    const previousToken = process.env.LEGALWORK_SERVER_TOKEN;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/workspaces") return Response.json({ items: [
          { id: "parent", path: "C:\\Matters\\Acme\\" },
          { id: "nested", path: "C:\\Matters\\Acme\\Contracts" },
        ] });
        if (path === "/workspace/parent/personalization") return Response.json({ customInstructions: "Parent writing style" });
        if (path === "/workspace/nested/personalization") return Response.json({ customInstructions: "Nested writing style" });
        return new Response(null, { status: 404 });
      },
    });
    process.env.LEGALWORK_SERVER_URL = `http://127.0.0.1:${server.port}`;
    process.env.LEGALWORK_SERVER_TOKEN = "test-token";
    const prompt = async (directory: string) => {
      const plugin = await LegalWorkCapabilitiesKnowledge({ directory });
      const output: { system: string[] } = { system: [] };
      await plugin["experimental.chat.system.transform"](null, output);
      return output.system.join("\n");
    };
    try {
      expect(await prompt("c:/matters/acme/")).toContain("Parent writing style");
      const nested = await prompt("c:/MATTERS/Acme/Contracts/documents");
      expect(nested).toContain("Nested writing style");
      expect(nested).not.toContain("Parent writing style");
      expect(await prompt("C:\\Matters\\Acme-other")).not.toContain("Project personalisation");
    } finally {
      server.stop(true);
      if (previousUrl === undefined) delete process.env.LEGALWORK_SERVER_URL;
      else process.env.LEGALWORK_SERVER_URL = previousUrl;
      if (previousToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN;
      else process.env.LEGALWORK_SERVER_TOKEN = previousToken;
    }
  });
});
