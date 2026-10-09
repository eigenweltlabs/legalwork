import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UIMessage } from "ai";
import DOMPurify from "dompurify";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MessageList } from "../src/components/chat/message-list";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import type { ThreadStatus } from "../src/lib/messages";

function textMessage(id: string, role: UIMessage["role"], text: string): UIMessage {
  return { id, role, parts: [{ type: "text", text }] };
}

function renderMessages(messages: UIMessage[], status: ThreadStatus) {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MessageListProvider
        workspaceId="copy-test"
        sessionId="session"
        showThinking={false}
        developerMode={false}
        displaySuggestions={false}
        providerConnectedCount={0}
        dispatchAction={() => {}}
        setPrompt={() => {}}
        onRevertToUserMessage={() => {}}
        onForkAtMessage={() => {}}
        onEditUserMessage={() => {}}
      >
        <MessageList messages={messages} status={status} />
      </MessageListProvider>
    </QueryClientProvider>,
  );
}

function copyButtonCount(html: string) {
  return html.match(/aria-label="Copy message"/g)?.length ?? 0;
}

describe("message copying", () => {
  // These fixtures contain trusted literal text. Bun has no browser DOM for
  // DOMPurify; limit its stand-in to this suite so we can render the real list.
  beforeAll(() => Object.defineProperty(DOMPurify, "sanitize", {
    value: (html: string) => html,
    configurable: true,
  }));
  afterAll(() => { Reflect.deleteProperty(DOMPurify, "sanitize"); });

  test.each(["streaming", "retrying"] satisfies ThreadStatus[])("keeps earlier answers copyable while a later turn is %s", (status) => {
    const html = renderMessages([
      textMessage("user-1", "user", "First prompt"),
      textMessage("assistant-1", "assistant", "Completed answer"),
      textMessage("user-2", "user", "Second prompt"),
      textMessage("assistant-2", "assistant", "Still writing"),
    ], status);

    expect(copyButtonCount(html)).toBe(3);
  });

  test("keeps a submitted prompt copyable and selectable before the agent replies", () => {
    const html = renderMessages([textMessage("user", "user", "Original instructions")], "streaming");

    expect(copyButtonCount(html)).toBe(1);
    expect(html).toMatch(/class="[^"]*select-text[^"]*"[^>]*data-slot="context-menu-trigger"/);
    expect(html).not.toContain('aria-label="Edit message"');
    expect(html).toContain("focus-within:opacity-100");
  });

  test("keeps partial answers copyable after an interrupted tool step", () => {
    const html = renderMessages([
      textMessage("user", "user", "Search for prior art"),
      textMessage("assistant", "assistant", "Here is what I found so far."),
      { id: "tool-step", role: "assistant", parts: [{
        type: "dynamic-tool", toolName: "patent_search", toolCallId: "search",
        state: "output-error", input: {}, errorText: "Run cancelled",
      }] },
    ], "ready");

    expect(copyButtonCount(html)).toBe(2);
  });

  test("does not offer answer copying for a tool-only turn", () => {
    const html = renderMessages([
      textMessage("user", "user", "Search"),
      { id: "tool-step", role: "assistant", parts: [{
        type: "dynamic-tool", toolName: "patent_search", toolCallId: "search",
        state: "output-available", input: {}, output: { results: [] },
      }] },
    ], "ready");

    expect(copyButtonCount(html)).toBe(1);
  });
});
