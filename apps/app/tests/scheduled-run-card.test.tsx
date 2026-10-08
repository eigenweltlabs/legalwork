import { expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { scheduledRunOf, ScheduledRunCard } from "../src/components/chat/scheduled-run-card";
import { MessageListProvider } from "../src/components/chat/message-list-provider";

const message: UIMessage = { id: "morning", role: "user", parts: [{ type: "text", text: "[Scheduled task: Morning briefing]\n\nCheck all matters.\nKeep every instruction." }] };
test("scheduled envelopes become cards without altering or losing their stored instructions", () => {
  expect(scheduledRunOf(message)).toEqual({ title: "Morning briefing", prompt: "Check all matters.\nKeep every instruction." });
  expect(scheduledRunOf({ ...message, role: "assistant" })).toBeNull();
  expect(scheduledRunOf({ ...message, parts: [{ type: "text", text: "Please explain [Scheduled task: Morning briefing]" }] })).toBeNull();
});

test("run instructions are collapsed by default, including for historical or deleted schedules", () => {
  const query = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const noop = () => {};
  const html = renderToStaticMarkup(<QueryClientProvider client={query}><MemoryRouter><MessageListProvider workspaceId="fixture" sessionId="chat" readOnly
    showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={0} dispatchAction={noop} setPrompt={noop} onRevertToUserMessage={noop} onForkAtMessage={noop} onEditUserMessage={noop}>
    <ScheduledRunCard run={{ title: "Morning briefing", prompt: "Original instructions" }} created={null} />
  </MessageListProvider></MemoryRouter></QueryClientProvider>);
  expect(html).toContain('data-scheduled-run=""');
  expect(html).toContain("Morning briefing");
  expect(html).toContain("Original instructions");
  expect(html).toContain("<details");
  expect(html).not.toContain('open=""');
  query.clear();
});
