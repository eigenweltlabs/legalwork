/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import DOMPurify from "dompurify";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { parseProviderUsageLimit } from "@legalwork/types/provider-usage-limit";
import { MessageList } from "../src/components/chat/message-list";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { webSearchUsageLimitError } from "../src/components/chat/web-search-usage-limit";
import { OpenTargetProvider } from "../src/lib/target-provider";
import { ProviderLimitMessage } from "../src/react-app/domains/connections/usage-control/provider-limit-message";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { parseDynamicToolUIPart } from "../src/react-app/domains/session/sync/parse-tool-parts";
import type { ToolPart } from "../src/app/lib/opencode-view";
import { currentLocale, setLocale } from "../src/i18n";

const limit = { reason: "wallet_empty", requiredMicros: 1, availableMicros: 0 };
const search: DynamicToolUIPart = { type: "dynamic-tool", toolName: "legalwork_websearch", toolCallId: "search", input: {},
  state: "output-error", errorText: "Web search is blocked. Eigenwelt usage limit: " + JSON.stringify(limit) };

test("direct and Code Mode search failures retain Eigenwelt billing identity independently of the chat model", () => {
  const nested: DynamicToolUIPart = { ...search, toolName: "execute", callProviderMetadata: { opencode: { failedTools: ["legalwork_websearch"] } } };
  const completed: ToolPart = { id: "nested", messageID: "assistant", sessionID: "chat", type: "tool", tool: "execute", callID: "nested",
    state: { status: "completed", input: {}, output: search.errorText, title: "Search", time: { start: 1, end: 2 },
      metadata: { error: true, toolCalls: [{ tool: "legalwork_websearch", status: "error" }] } } };
  const mapped = parseDynamicToolUIPart(completed);
  if (!mapped) throw new Error("Missing Code Mode activity");
  for (const part of [search, nested, mapped]) {
    expect(parseProviderUsageLimit(webSearchUsageLimitError([part]))).toEqual({ providerId: "eigenwelt", limit });
  }
  expect(webSearchUsageLimitError([{ ...search, toolName: "legalwork_webfetch" }])).toBeNull();
  expect(webSearchUsageLimitError([{ ...search, toolName: "execute" }])).toBeNull();
  const success: ToolPart = { ...completed, state: { ...completed.state, metadata: { toolCalls: [{ tool: "legalwork_websearch", status: "completed" }] } } };
  const successfulSearch = parseDynamicToolUIPart(success);
  expect(successfulSearch && webSearchUsageLimitError([successfulSearch])).toBeNull();
  expect(webSearchUsageLimitError([{ ...search, errorText: "Too many requests" }])).toBeNull();
  expect(webSearchUsageLimitError([{ ...search, errorText: 'Eigenwelt usage limit: {"reason":"wallet_empty","requiredMicros":1,"availableMicros":2}' }])).toBeNull();
});

test("a collapsed failed search shows the existing recovery controls once outside tool details", () => {
  const messages: UIMessage[] = [{ id: "user", role: "user", parts: [{ type: "text", text: "Search public law" }] },
    { id: "assistant", role: "assistant", parts: [search, { ...search, toolCallId: "search-again" }] },
    { id: "reply", role: "assistant", parts: [{ type: "text", text: "Search needs more allowance." }] }];
  const cache = new QueryClient(), noop = () => {};
  const seen: string[] = [];
  const scopes: Array<"web-search" | undefined> = [];
  const sanitize = Object.getOwnPropertyDescriptor(DOMPurify, "sanitize");
  // Only trusted fixture prose: Bun's server renderer has no browser DOM.
  Object.defineProperty(DOMPurify, "sanitize", { value: (html: string) => html, configurable: true });
  try {
  const html = renderToStaticMarkup(<QueryClientProvider client={cache}><MemoryRouter><OpenTargetProvider openTargets={[]} onOpenTarget={noop}>
    <MessageListProvider workspaceId="matter" sessionId="chat" showThinking={false} developerMode={false} displaySuggestions={false}
      providerConnectedCount={1} dispatchAction={noop} setPrompt={noop} onRevertToUserMessage={noop} onForkAtMessage={noop} onEditUserMessage={noop}>
      <MessageList messages={messages} status="ready" renderUsageLimit={(error, _messageId, scope) => { seen.push(error); scopes.push(scope); return <button>Request more usage</button>; }} />
    </MessageListProvider></OpenTargetProvider></MemoryRouter></QueryClientProvider>);
  expect(seen).toHaveLength(1);
  expect(scopes).toEqual(["web-search"]);
  expect(parseProviderUsageLimit(seen[0])).toEqual({ providerId: "eigenwelt", limit });
  expect(html).toContain("Request more usage");
  expect(html).not.toContain("Eigenwelt usage limit:");
  } finally {
    cache.clear();
    if (sanitize) Object.defineProperty(DOMPurify, "sanitize", sanitize);
    else Reflect.deleteProperty(DOMPurify, "sanitize");
  }
});

test("the positive-balance admission check shows an exhausted limit rather than a request-size estimate", () => {
  const cache = new QueryClient();
  try {
    const client = createLegalworkServerClient({ baseUrl: "http://127.0.0.1:4321", token: "fixture" });
    const render = (requiredMicros: number) => renderToStaticMarkup(<QueryClientProvider client={cache}>
      <ProviderLimitMessage client={client} workspaceId="matter" plan="plus" providerId="eigenwelt"
        limit={{ reason: "member_limit", requiredMicros, availableMicros: 0 }} />
    </QueryClientProvider>);
    expect(render(1)).toContain("Personal usage limit reached");
    expect(render(10000)).toContain("Personal spending limit too low for this request");
  } finally { cache.clear(); }
});

test("search recovery names the web search limit and its separate Eigenwelt allowance in both shipped languages", () => {
  const cache = new QueryClient();
  const previousLocale = currentLocale();
  try {
    const client = createLegalworkServerClient({ baseUrl: "http://127.0.0.1:4321", token: "fixture" });
    const render = (scope?: "web-search") => renderToStaticMarkup(<QueryClientProvider client={cache}>
      <ProviderLimitMessage client={client} workspaceId="matter" plan="plus" providerId="eigenwelt" scope={scope}
        limit={{ reason: "member_limit", requiredMicros: 1, availableMicros: 0 }} />
    </QueryClientProvider>);
    setLocale("en");
    const search = render("web-search");
    expect(search).toContain("Web search limit reached");
    expect(search).toContain("Web search uses your Eigenwelt allowance and spending limits.");
    expect(search).toContain("Your chat model provider has separate usage limits.");
    expect(render()).toContain("Personal usage limit reached");
    expect(render()).not.toContain("Your chat model provider has separate usage limits.");
    setLocale("de");
    expect(render("web-search")).toContain("Nutzungslimit für die Websuche erreicht");
    expect(render("web-search")).toContain("Für den Anbieter Ihres Chatmodells gelten separate Nutzungslimits.");
  } finally { setLocale(previousLocale); cache.clear(); }
});
