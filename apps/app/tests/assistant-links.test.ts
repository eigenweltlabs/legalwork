import { expect, test } from "bun:test";
import { buildAssistantDeepLink, parseAssistantDeepLink } from "../src/app/lib/assistant-links";

test("assistant deep links carry only identifiers and reject unknown actions", () => {
  expect(parseAssistantDeepLink("legalwork://assistant/ask?q=Was%20ist%20offen&invocation=inv_1&context=ctx_abc")).toEqual({ id: "inv_1", action: "ask", query: "Was ist offen", conversationId: undefined, projectId: undefined, actionId: undefined, contextId: "ctx_abc", source: "deep-link" });
  expect(parseAssistantDeepLink("legalwork-dev://assistant")?.action).toBe("open");
  expect(parseAssistantDeepLink("legalwork://assistant/files?q=Mietvertrag&project=mueller")).toMatchObject({ action: "files", query: "Mietvertrag", projectId: "mueller" });
  expect(parseAssistantDeepLink("legalwork://assistant/delete-everything")).toBeNull();
  expect(parseAssistantDeepLink("legalwork://connect-remote?legalworkHostUrl=x")).toBeNull();
  expect(parseAssistantDeepLink("https://legalwork.app/assistant/ask")).toBeNull();
  const built = buildAssistantDeepLink({ id: "inv_2", action: "quick-action", actionId: "quick-action:qa_1", contextId: "ctx_1" });
  expect(built).toBe("legalwork://assistant/quick-action?invocation=inv_2&action=quick-action%3Aqa_1&context=ctx_1");
  expect(parseAssistantDeepLink(built)).toMatchObject({ id: "inv_2", action: "quick-action", actionId: "quick-action:qa_1", contextId: "ctx_1" });
  expect(parseAssistantDeepLink("legalwork://assistant/open")?.id).toMatch(/^link_/);
});

test("exact result links preserve source identity and reject malformed payloads", () => {
  const result = { kind: "files", id: "Agreements/Contract.docx", workspaceId: "matter-2", sourceId: "local:matter-2", path: "Agreements/Contract.docx" } satisfies NonNullable<Parameters<typeof buildAssistantDeepLink>[0]["result"]>;
  const link = buildAssistantDeepLink({ id: "exact-result", action: "open", result });
  expect(parseAssistantDeepLink(link)?.result).toEqual(result);
  expect(parseAssistantDeepLink("legalwork://assistant/open?result=broken")).toBeNull();
  expect(parseAssistantDeepLink(`legalwork://assistant/open?result=${encodeURIComponent(JSON.stringify({ ...result, route: "/settings" }))}`)).toBeNull();
  expect(parseAssistantDeepLink(`legalwork://assistant/open?result=${encodeURIComponent(JSON.stringify({ ...result, workspaceId: 42 }))}`)).toBeNull();
  for (const resultAction of ["chat-with-assistant", "ask", "summarize"] satisfies NonNullable<Parameters<typeof buildAssistantDeepLink>[0]["resultAction"]>[]) {
    expect(parseAssistantDeepLink(buildAssistantDeepLink({ id: "exact-action", action: "open", result, resultAction }))).toMatchObject({ result, resultAction });
  }
  expect(parseAssistantDeepLink(`${link}&resultAction=move-to-project`)).toBeNull();
  expect(parseAssistantDeepLink("legalwork://assistant/open?resultAction=ask")).toBeNull();
});
