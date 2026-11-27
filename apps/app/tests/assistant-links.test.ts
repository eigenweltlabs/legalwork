import { expect, test } from "bun:test";
import { buildAssistantDeepLink, parseAssistantDeepLink } from "../src/app/lib/assistant-links";

test("public assistant links can open drafts without consuming staged context", () => {
  expect(parseAssistantDeepLink("legalwork://assistant/ask?q=Was%20ist%20offen&invocation=inv_1&context=ctx_abc")).toEqual({ id: "inv_1", action: "ask", query: "Was ist offen", conversationId: undefined, projectId: undefined, source: "deep-link" });
  expect(parseAssistantDeepLink("legalwork-dev://assistant")?.action).toBe("open");
  expect(parseAssistantDeepLink("legalwork://assistant/files?q=Mietvertrag&project=mueller")).toMatchObject({ action: "files", query: "Mietvertrag", projectId: "mueller" });
  expect(parseAssistantDeepLink("legalwork://assistant/delete-everything")).toBeNull();
  expect(parseAssistantDeepLink("legalwork://connect-remote?legalworkHostUrl=x")).toBeNull();
  expect(parseAssistantDeepLink("https://legalwork.app/assistant/ask")).toBeNull();
  expect(parseAssistantDeepLink("legalwork://assistant/quick-action?action=quick-action:qa_1")).toBeNull();
  expect(() => buildAssistantDeepLink({ id: "inv_2", action: "ask", query: "Private draft" })).toThrow("authenticated Raycast handoff");
  const built = buildAssistantDeepLink({ id: "inv_2", action: "resume", conversationId: "conv_1" });
  expect(built).toBe("legalwork://assistant/resume?invocation=inv_2&conversation=conv_1");
  expect(parseAssistantDeepLink("legalwork://assistant/open")?.id).toMatch(/^link_/);
});

test("exact result links preserve source identity and reject malformed payloads", () => {
  const result = { kind: "files", id: "Agreements/Contract.docx", workspaceId: "matter-2", sourceId: "local:matter-2", path: "Agreements/Contract.docx" } satisfies NonNullable<Parameters<typeof buildAssistantDeepLink>[0]["result"]>;
  expect(() => buildAssistantDeepLink({ id: "exact-result", action: "open", result })).toThrow("authenticated Raycast handoff");
  const link = `legalwork://assistant/open?result=${encodeURIComponent(JSON.stringify(result))}`;
  expect(parseAssistantDeepLink(link)?.result).toEqual(result);
  expect(parseAssistantDeepLink("legalwork://assistant/open?result=broken")).toBeNull();
  expect(parseAssistantDeepLink(`legalwork://assistant/open?result=${encodeURIComponent(JSON.stringify({ ...result, route: "/settings" }))}`)).toBeNull();
  expect(parseAssistantDeepLink(`legalwork://assistant/open?result=${encodeURIComponent(JSON.stringify({ ...result, workspaceId: 42 }))}`)).toBeNull();
  for (const resultAction of ["chat-with-assistant", "ask", "summarize"] satisfies NonNullable<Parameters<typeof buildAssistantDeepLink>[0]["resultAction"]>[]) {
    const preview = parseAssistantDeepLink(`${link}&resultAction=${resultAction}`);
    expect(preview).toMatchObject({ result, source: "deep-link" });
    expect(preview?.resultAction).toBeUndefined();
  }
  expect(parseAssistantDeepLink(`${link}&resultAction=move-to-project`)).toBeNull();
  expect(parseAssistantDeepLink("legalwork://assistant/open?resultAction=ask")).toBeNull();
});
