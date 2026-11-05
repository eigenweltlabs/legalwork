import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import LegalWorkWordTools, { isOpenWordFilePipelineCall } from "./legalwork-word-tools.js";
import { nativePluginTestRuntime } from "./native-plugin-test-support.js";

const OPEN_DOCUMENT = "/Users/lawyer/Matter/NDA Example.docx";

const runtimes: Array<ReturnType<typeof nativePluginTestRuntime>> = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) await runtime.close(); });

async function wordRuntime() {
  const runtime = nativePluginTestRuntime();
  runtimes.push(runtime);
  await runtime.start(LegalWorkWordTools);
  return runtime;
}

/** Native admission persists changed state without rewriting the fixed system text. */
async function modelContext(runtime: Awaited<ReturnType<typeof wordRuntime>>) {
  const system: { system: Array<{ type: string; text: string }> } = { system: [] };
  await runtime.hook("session", "context", system);
  const start = runtime.prompts.length;
  await runtime.hook("session", "prompt", { sessionID: "ses_word", messageID: "msg_test", prompt: { text: "Edit the document" }, delivery: "steer" });
  return { system: system.system.map(part => part.text).join("\n"), reminder: runtime.prompts.slice(start).map(message => message.text).join("\n") };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map(part => part?.type === "text" ? part.text : "").join("\n") : "";
}

describe("LegalWork Word tools", () => {
  test("reports live mode as a reminder while Word is connected, keeping the system prompt fixed", async () => {
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.LEGALWORK_SERVER_URL;
    const originalToken = process.env.LEGALWORK_SERVER_TOKEN;
    process.env.LEGALWORK_SERVER_URL = "http://legalwork.test";
    process.env.LEGALWORK_SERVER_TOKEN = "test-token";
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.endsWith("/workspaces")) {
          return Response.json({
            items: [{ id: "matter", path: "/Users/lawyer/Matter" }],
          });
        }
        if (url.endsWith("/workspace/matter/office-tools/status")) {
          return Response.json({
            connected: true,
            hosts: [{ host: "word", documentUrl: OPEN_DOCUMENT }],
          });
        }
        return new Response("Not found", { status: 404 });
      },
      { preconnect: originalFetch.preconnect },
    );

    try {
      const plugin = await wordRuntime();
      const { system, reminder } = await modelContext(plugin);

      expect(reminder).toContain("You are working inside Microsoft Word right now");
      expect(reminder).toContain("NDA Example.docx");
      expect(system).toContain("## Microsoft Word document tools");
      expect(system).not.toContain("NDA Example.docx");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.LEGALWORK_SERVER_URL;
      else process.env.LEGALWORK_SERVER_URL = originalUrl;
      if (originalToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN;
      else process.env.LEGALWORK_SERVER_TOKEN = originalToken;
    }
  });

  test("treats a failed pane check as no change, not as a disconnect", async () => {
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.LEGALWORK_SERVER_URL;
    const originalToken = process.env.LEGALWORK_SERVER_TOKEN;
    process.env.LEGALWORK_SERVER_URL = "http://legalwork.test";
    process.env.LEGALWORK_SERVER_TOKEN = "test-token";
    let pane: "connected" | "failing" | "closed" = "connected";
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.endsWith("/workspaces")) return Response.json({ items: [{ id: "matter", path: "/Users/lawyer/Matter" }] });
        if (pane === "failing") return new Response("Unavailable", { status: 503 });
        return Response.json(pane === "connected" ? { connected: true, hosts: [{ host: "word", documentUrl: OPEN_DOCUMENT }] } : { connected: false, hosts: [] });
      },
      { preconnect: originalFetch.preconnect },
    );

    try {
      const plugin = await wordRuntime();
      expect((await modelContext(plugin)).reminder).toContain("NDA Example.docx");
      // Past the short cache for a connected pane.
      setSystemTime(new Date(Date.now() + 10_000));
      pane = "failing";
      const failed = { content: "read" };
      await plugin.hook("tool", "execute.after", { sessionID: "ses_word", status: "completed", result: failed });
      expect(failed.content).toBe("read");

      pane = "closed";
      const closed = { content: "read" };
      const event = { sessionID: "ses_word", status: "completed", result: closed };
      await plugin.hook("tool", "execute.after", event);
      expect(contentText(event.result.content)).toContain("no longer connected");
    } finally {
      setSystemTime();
      globalThis.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.LEGALWORK_SERVER_URL;
      else process.env.LEGALWORK_SERVER_URL = originalUrl;
      if (originalToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN;
      else process.env.LEGALWORK_SERVER_TOKEN = originalToken;
    }
  });

  test("blocks the DOCX file pipeline for the document open in Word", () => {
    expect(
      isOpenWordFilePipelineCall(
        "legalwork_shell",
        { command: 'node .opencode/skills/docx-edit/assets/docx-agent.mjs inspect "NDA Example.docx"' },
        OPEN_DOCUMENT,
      ),
    ).toBe(true);
  });

  test("blocks a docx-redliner task targeting the open document", () => {
    expect(
      isOpenWordFilePipelineCall(
        "subagent",
        { agent: "docx-redliner", prompt: "Redline NDA Example.docx" },
        OPEN_DOCUMENT,
      ),
    ).toBe(true);
  });

  test("matches a URL-encoded document URL", () => {
    expect(
      isOpenWordFilePipelineCall(
        "shell",
        { command: 'node docx-agent.mjs inspect "NDA Example.docx"' },
        "file:///Users/lawyer/Matter/NDA%20Example.docx",
      ),
    ).toBe(true);
  });

  test("allows the file pipeline for another workspace document", () => {
    expect(
      isOpenWordFilePipelineCall(
        "shell",
        { command: 'node .opencode/skills/docx-edit/assets/docx-agent.mjs inspect "Other NDA.docx"' },
        OPEN_DOCUMENT,
      ),
    ).toBe(false);
  });

  test("allows unrelated shell work while Word is connected", () => {
    expect(
      isOpenWordFilePipelineCall("shell", { command: "pnpm test" }, OPEN_DOCUMENT),
    ).toBe(false);
  });
});

describe("routing an unqualified edit request to the live document", () => {
  // Regression: asked to "rename Christian-Hauke Poensgen to Chris Poensgen"
  // with the NDA open in Word, the agent grepped the workspace, found the
  // same-named .md export, edited that, and answered "Done." The document the
  // lawyer had on screen never changed and the reply gave no hint of it.
  test("live-mode prompt routes an unqualified rename to the open document", async () => {
    const originalFetch = globalThis.fetch;
    const originalUrl = process.env.LEGALWORK_SERVER_URL;
    const originalToken = process.env.LEGALWORK_SERVER_TOKEN;
    process.env.LEGALWORK_SERVER_URL = "http://legalwork.test";
    process.env.LEGALWORK_SERVER_TOKEN = "test-token";
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        const url = input instanceof Request ? input.url : input.toString();
        if (url.endsWith("/workspaces")) {
          return Response.json({ items: [{ id: "matter", path: "/Users/lawyer/Matter" }] });
        }
        if (url.endsWith("/workspace/matter/office-tools/status")) {
          return Response.json({ connected: true, hosts: [{ host: "word", documentUrl: OPEN_DOCUMENT }] });
        }
        return new Response("Not found", { status: 404 });
      },
      { preconnect: originalFetch.preconnect },
    );

    try {
      const plugin = await wordRuntime();
      const { reminder } = await modelContext(plugin);

      // "Rename X to Y" names no file; the model read it as a workspace-wide
      // find and replace. The prompt has to claim it for the open document.
      expect(reminder).toContain("An edit request that names no file is about the open document");
      expect(reminder).toContain("Do NOT grep the workspace");
      expect(reminder).toContain("sidecar");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalUrl === undefined) delete process.env.LEGALWORK_SERVER_URL;
      else process.env.LEGALWORK_SERVER_URL = originalUrl;
      if (originalToken === undefined) delete process.env.LEGALWORK_SERVER_TOKEN;
      else process.env.LEGALWORK_SERVER_TOKEN = originalToken;
    }
  });
});
