import { describe, expect, test } from "bun:test";

import { draftDecisionPendingApi } from "../src/react-app/domains/session/artifacts/docx-recovery";

describe("Word editor waiting for a draft decision", () => {
  test("tells agent tools that the user has to decide, instead of 'still loading'", async () => {
    const api = draftDecisionPendingApi("Vertrag.docx");
    const result = await api.executeAgentTool("read_document", {});
    expect(result.success).toBe(false);
    expect(result.error).toContain("Vertrag.docx");
    expect(result.error).toContain('"Recover draft" or "Discard draft and open file"');
    expect(result.error).toContain("Ask the user to decide");
    // Nothing can be saved or exported until the user has decided.
    expect(await api.save()).toBe(false);
    expect(await api.flushSave()).toBe(false);
    expect(api.isDirty()).toBe(true);
    await api.drain();
    expect(await api.getBuffer()).toBeNull();
  });
});
