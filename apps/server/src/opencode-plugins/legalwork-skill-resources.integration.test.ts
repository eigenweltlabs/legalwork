import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { upsertSkill } from "../skills.js";
import { upsertSkillResource } from "../skill-resources.js";
import { writeSandboxDefault } from "../agent-sandbox/settings.js";
import { waitForNativeFixture } from "../native-mcp.test-support.js";
import { nativeChatResponse, nativeDomainEngine } from "./native-domain-engine.test-support.js";

const binary = process.env.LEGALWORK_TEST_OPENCODE_BIN;
test.skipIf(!binary)("shipped engine reads global workflow resources with sandbox on and off while other folders still ask", async () => {
  if (!binary) throw new Error("A released engine is required");
  const name = "workflow-assistant-intake";
  let externalProbe = false, unrelated = "", sequence = 0;
  const offered: string[][] = [];
  const model = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const input = z.object({ messages: z.array(z.object({ role: z.string() })), tools: z.array(z.object({ function: z.object({ name: z.string() }) })).optional() }).parse(await request.json());
    const names = input.tools?.map(tool => tool.function.name) ?? [];
    if (!names.length) return nativeChatResponse(undefined, sequence++);
    offered.push(names);
    const step = input.messages.filter(message => message.role === "tool").length;
    const calls = externalProbe ? [{ name: "read", input: { path: unrelated } }] : [
      { name: "legalwork_skill_load", input: { name } },
      { name: "legalwork_skill_read", input: { name, path: "resources/fields.md" } },
      { name: "legalwork_skill_read", input: { name, path: "resources/template.docx" } },
    ];
    return nativeChatResponse(calls[step], sequence++);
  } });
  let engine: Awaited<ReturnType<typeof nativeDomainEngine>> | undefined;
  try {
    engine = await nativeDomainEngine({ binary, plugins: [join(import.meta.dir, "legalwork-skill-tools.ts")], modelURL: model.url.origin + "/v1",
      configuration: { permissions: [{ action: "*", resource: "*", effect: "allow" }, { action: "external_directory", resource: "*", effect: "ask" }] },
      async setup(config, root) {
        const directory = config.workspaces[0].path;
        await upsertSkill(directory, { name, description: "Intake workflow", scope: "global", content: "Read the attached fields and template." });
        await upsertSkillResource(directory, name, { name: "fields.md", content: "Intake field: matter number" });
        const template = await readFile(new URL("../../resources/core-opencode/skills/workflow-assistant-due-diligence/resources/DD-Report-Template.docx", import.meta.url));
        await upsertSkillResource(directory, name, { name: "template.docx", contentBase64: template.toString("base64") });
        unrelated = join(root, "unrelated.txt"); await writeFile(unrelated, "Private unrelated text");
      },
    });
    const { client, config, location, directory } = engine;
    for (const enabled of [false, true]) {
      await writeSandboxDefault(config, { enabled, networkMode: "block" });
      const session = await client.session.create({ location, agent: "build" });
      await client.session.prompt({ sessionID: session.id, text: "Read the workflow resources." });
      await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
      const messages = await client.session.context({ sessionID: session.id });
      const tools = messages.flatMap(message => message.type === "assistant" ? message.content.filter(part => part.type === "tool") : []);
      const reads = tools.filter(part => part.name === "legalwork_skill_read");
      expect(reads.map(part => part.state.status), JSON.stringify(messages)).toEqual(["completed", "completed"]);
      const text = reads.map(part => part.state.status === "completed" ? part.state.content.flatMap(content => content.type === "text" ? [content.text] : []).join("\n") : "");
      expect(text[0]).toContain(enabled ? "Updated intake fields" : "Intake field: matter number");
      expect(text[1]).toContain("{{matter_name}}");
      expect(await client.permission.list({ sessionID: session.id })).toEqual([]);
      await upsertSkillResource(directory, name, { name: "fields.md", content: "Updated intake fields" });
    }
    expect(offered.some(names => names.includes("legalwork_skill_load") && names.includes("legalwork_skill_read"))).toBe(true);
    externalProbe = true;
    const session = await client.session.create({ location, agent: "build" });
    await client.session.prompt({ sessionID: session.id, text: "Read the unrelated external file." });
    const approvals = await waitForNativeFixture(() => client.permission.list({ sessionID: session.id }), items => items.length > 0, "outside-directory approval");
    expect(approvals).toHaveLength(1); expect(approvals[0].action).toBe("external_directory");
    await client.permission.reply({ sessionID: session.id, requestID: approvals[0].id, decision: "reject" });
    await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(15_000) });
    expect(JSON.stringify(await client.session.context({ sessionID: session.id }))).not.toContain("Private unrelated text");
  } finally { await engine?.close(); model.stop(true); }
}, 120_000);
