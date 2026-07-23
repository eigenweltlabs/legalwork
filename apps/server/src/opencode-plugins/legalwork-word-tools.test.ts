import { describe, expect, test } from "bun:test";
import { isOpenWordFilePipelineCall } from "./legalwork-word-tools.js";

const OPEN_DOCUMENT = "/Users/lawyer/Matter/NDA Example.docx";

describe("LegalWork Word tools", () => {
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
