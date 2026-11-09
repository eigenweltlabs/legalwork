import { afterAll, beforeAll, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import DOMPurify from "dompurify";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { UIMessage } from "ai";
import { DisconnectedChat } from "../src/react-app/domains/session/chat/disconnected-chat";
import { transcriptKey } from "../src/react-app/domains/session/sync/session-sync";

// Bun has no browser DOM. Sanitization is outside this cache/rendering test.
const previousSanitize = Object.getOwnPropertyDescriptor(DOMPurify, "sanitize");
beforeAll(() => Object.defineProperty(DOMPurify, "sanitize", { value: (html: string) => html, configurable: true }));
afterAll(() => {
  if (previousSanitize) Object.defineProperty(DOMPurify, "sanitize", previousSanitize);
  else Reflect.deleteProperty(DOMPurify, "sanitize");
});

test("disconnected chats show their cached conversation without fetching or enabling edits", () => {
  const cache = new QueryClient();
  const messages: UIMessage[] = [
    { id: "question", role: "user", parts: [{ type: "text", text: "Read my document" }] },
    { id: "answer", role: "assistant", parts: [{ type: "text", text: "Here is your summary" }] },
  ];
  cache.setQueryData(transcriptKey("workspace", "chat"), messages);
  const html = renderToStaticMarkup(<MemoryRouter><QueryClientProvider client={cache}>
    <DisconnectedChat workspaceId="workspace" sessionId="chat" />
  </QueryClientProvider></MemoryRouter>);
  expect(html).toContain("Read my document");
  expect(html).toContain("Here is your summary");
  expect(html).not.toContain("Pulling in the latest messages");
  expect(cache.isFetching()).toBe(0);
  expect(html).toContain("disabled");
  cache.clear();
});

test("a different workspace cannot display another chat's cached messages", () => {
  const cache = new QueryClient();
  cache.setQueryData<UIMessage[]>(transcriptKey("workspace", "chat"), [
    { id: "private", role: "user", parts: [{ type: "text", text: "Other workspace history" }] },
  ]);
  const html = renderToStaticMarkup(<MemoryRouter><QueryClientProvider client={cache}>
    <DisconnectedChat workspaceId="other-workspace" sessionId="chat" />
  </QueryClientProvider></MemoryRouter>);
  expect(html).not.toContain("Other workspace history");
  expect(cache.isFetching()).toBe(0);
  cache.clear();
});
