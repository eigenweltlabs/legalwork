import { afterEach, describe, expect, test } from "bun:test";
import { join, resolve, sep } from "node:path";
import LegalWorkCapabilitiesKnowledge from "./legalwork-capabilities-knowledge.js";
import { nativePluginTestRuntime } from "./native-plugin-test-support.js";

const runtimes: Array<ReturnType<typeof nativePluginTestRuntime>> = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); });
async function pluginRuntime(directory?: string) { const runtime = nativePluginTestRuntime(directory); runtimes.push(runtime); await runtime.start(LegalWorkCapabilitiesKnowledge); return runtime; }

describe("LegalWork capabilities knowledge plugin", () => {
  test("injects local desktop product guidance", async () => {
    const plugin = await pluginRuntime();
    const output: { system: Array<{ text: string }> } = { system: [] };

    await plugin.hook("session", "context", output);

    expect(output.system.map(part => part.text).join("\n")).toContain("local-first desktop app");
    expect(output.system.map(part => part.text).join("\n")).toContain("workspace-relative path");
  });

  test("reports the project prompt as a reminder, resolving native project paths without matching neighbouring folders", async () => {
    const project = resolve("Matters", "Acme");
    const nestedProject = join(project, "Contracts");
    const chatDirectory = (path: string) => process.platform === "win32" ? path.toLowerCase().replace(/\\/g, "/") : path;
    const previousUrl = process.env.LEGALWORK_SERVER_URL;
    const previousToken = process.env.LEGALWORK_SERVER_TOKEN;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/workspaces") return Response.json({ items: [
          { id: "parent", path: `${project}${sep}` },
          { id: "nested", path: nestedProject },
        ] });
        if (path === "/workspace/parent/personalization") return parentStyle === null ? new Response(null, { status: 503 }) : Response.json({ customInstructions: parentStyle });
        if (path === "/workspace/nested/personalization") return Response.json({ customInstructions: "Nested writing style" });
        return new Response(null, { status: 404 });
      },
    });
    process.env.LEGALWORK_SERVER_URL = `http://127.0.0.1:${server.port}`;
    process.env.LEGALWORK_SERVER_TOKEN = "test-token";
    /** The fixed system text and the reminder on the next user message. */
    const modelContext = async (plugin: Awaited<ReturnType<typeof pluginRuntime>>) => {
      const output: { system: Array<{ text: string }> } = { system: [] };
      await plugin.hook("session", "context", output);
      const message = { sessionID: "ses_project", messageID: "msg_test", prompt: { text: "" } };
      await plugin.hook("session", "prompt", message);
      return { system: output.system.map(part => part.text).join("\n"), reminder: message.prompt.text.trim() };
    };
    const prompt = async (directory: string) => (await modelContext(await pluginRuntime(directory))).reminder;
    let parentStyle: string | null = "Parent writing style";
    try {
      const parent = await pluginRuntime(`${chatDirectory(project)}/`);
      const first = await modelContext(parent);
      expect(first.reminder).toStartWith('<system-reminder topic="project-prompt">');
      expect(first.reminder).toContain("Parent writing style");
      expect(first.system).not.toContain("Parent writing style");
      // An edit reaches existing chats with the next message; the system prompt stays the same.
      parentStyle = "Edited writing style";
      const edited = await modelContext(parent);
      expect(edited.reminder).toContain("Edited writing style");
      expect(edited.system).toBe(first.system);
      // A server that cannot answer is no change, not a removed prompt.
      parentStyle = null;
      expect((await modelContext(parent)).reminder).toBe("");
      parentStyle = "";
      expect((await modelContext(parent)).reminder).toContain("project personalisation was removed");

      const nested = await prompt(chatDirectory(join(nestedProject, "documents")));
      expect(nested).toContain("Nested writing style");
      expect(nested).not.toContain("Parent writing style");
      expect(await prompt(chatDirectory(`${project}-other`))).toBe("");
    } finally {
      server.stop(true);
      if (previousUrl === undefined) delete process.env.LEGALWORK_SERVER_URL;
      else process.env.LEGALWORK_SERVER_URL = previousUrl;
      if (previousToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN;
      else process.env.LEGALWORK_SERVER_TOKEN = previousToken;
    }
  });
});
