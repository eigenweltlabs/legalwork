import { describe, expect, test } from "bun:test";
import {
  isOpenWordFilePipelineCall,
  LegalWorkWordTools,
} from "./legalwork-word-tools.js";

const OPEN_DOCUMENT = "/Users/lawyer/Matter/NDA Example.docx";

describe("LegalWork Word tools", () => {
  test("enables live mode for any turn while Word is connected", async () => {
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
      const plugin = await LegalWorkWordTools({ directory: "/Users/lawyer/Matter" });
      const output: { system: string[] } = { system: [] };
      await plugin["experimental.chat.system.transform"](null, output);

      expect(output.system.join("\n")).toContain(
        "You are working inside Microsoft Word right now",
      );
      expect(output.system.join("\n")).toContain("NDA Example.docx");
    } finally {
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
        "bash",
        { command: 'node .opencode/skills/docx-edit/assets/docx-agent.mjs inspect "NDA Example.docx"' },
        OPEN_DOCUMENT,
      ),
    ).toBe(true);
  });

  test("blocks a docx-redliner task targeting the open document", () => {
    expect(
      isOpenWordFilePipelineCall(
        "task",
        { subagent_type: "docx-redliner", prompt: "Redline NDA Example.docx" },
        OPEN_DOCUMENT,
      ),
    ).toBe(true);
  });

  test("matches a URL-encoded document URL", () => {
    expect(
      isOpenWordFilePipelineCall(
        "bash",
        { command: 'node docx-agent.mjs inspect "NDA Example.docx"' },
        "file:///Users/lawyer/Matter/NDA%20Example.docx",
      ),
    ).toBe(true);
  });

  test("allows the file pipeline for another workspace document", () => {
    expect(
      isOpenWordFilePipelineCall(
        "bash",
        { command: 'node .opencode/skills/docx-edit/assets/docx-agent.mjs inspect "Other NDA.docx"' },
        OPEN_DOCUMENT,
      ),
    ).toBe(false);
  });

  test("allows unrelated shell work while Word is connected", () => {
    expect(
      isOpenWordFilePipelineCall("bash", { command: "pnpm test" }, OPEN_DOCUMENT),
    ).toBe(false);
  });
});
