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
