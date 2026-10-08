import { expect, test } from "bun:test";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { assistantChatMessages, assistantProjectFileTab, assistantReactions, linkedAssistantFiles } from "../src/components/chat/assistant-chat-presentation";
import { usePanelTabStore } from "../src/react-app/domains/session/panel/panel-tab-store";
import { MessageList } from "../src/components/chat/message-list";
import { AssistantLinkedFileCards } from "../src/components/chat/assistant-chat-cards";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { OpenTargetProvider } from "../src/lib/target-provider";

const user: UIMessage = { id: "user", role: "user", parts: [{ type: "text", text: "Please check the matters" }] };
const tool = (name: string, output: unknown): DynamicToolUIPart => ({ type: "dynamic-tool", toolName: name, toolCallId: name, state: "output-available", input: {}, output });
const shared = tool("legalwork_assistant_share_file", { ok: true, file: { path: "briefings/today.md", title: "Morning briefing", size: 1200 } });
const activity: UIMessage = { id: "activity", role: "assistant", parts: [
  tool("read", "File read"), tool("write", { path: "briefings/today.md" }), { type: "reasoning", text: "Internal thoughts" },
  { type: "file", mediaType: "text/markdown", filename: "today.md", url: "briefings/today.md" },
  tool("legalwork_assistant_react", { ok: true, reaction: { messageId: "user", emoji: "👍" } }),
] };
const response: UIMessage = { id: "response", role: "assistant", parts: [{ type: "text", text: "Your briefing is ready." }, shared] };

test("an explicitly linked briefing gets one card, without promoting reads, bare paths, websites or task links", () => {
  const linked: UIMessage = { ...response, parts: [{ type: "text", text: "Saved: [briefings/today.md](briefings/today.md). [Open again](briefings/today.md). [Task](legalworktask://task-id) [Website](https://example.com/file.pdf). I also read notes/private.md. ` [example](hidden.md) `" }] };
  expect(linkedAssistantFiles([user, activity, linked], [])).toEqual([{ path: "briefings/today.md", title: "Open again" }]);
  expect(linkedAssistantFiles([linked, response], [])).toEqual([]);
  const cards = renderToStaticMarkup(<OpenTargetProvider onOpenTarget={() => {}}><AssistantLinkedFileCards messages={[user, linked]} /></OpenTargetProvider>);
  expect(cards.match(/data-assistant-file-card/g)).toHaveLength(1);
});

test("only deliberate file cards survive, tool/file noise is hidden and source messages remain intact", () => {
  expect(assistantChatMessages([user, activity, response, { ...response, id: "retry", parts: [shared] }])).toEqual([user, response]);
  expect(activity.parts).toHaveLength(5);
  expect(assistantReactions([user, activity]).get("user")).toBe("👍");
  expect(assistantReactions([activity]).size).toBe(0);
  expect(assistantReactions([user, { ...activity, parts: [tool("legalwork_assistant_react", { ok: false })] }]).size).toBe(0);
  expect(assistantChatMessages([user, { ...response, parts: [{ ...shared, state: "input-available", output: undefined }] }])).toEqual([user]);
});

function render(messages: UIMessage[], status: "ready" | "submitted" | "streaming", assistantChat = true) {
  const query = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const noop = () => {};
  try {
    return renderToStaticMarkup(<QueryClientProvider client={query}><MemoryRouter><OpenTargetProvider onOpenTarget={noop}><MessageListProvider assistantChat={assistantChat} workspaceId="fixture" sessionId="chat"
      showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={0} dispatchAction={noop} setPrompt={noop} onRevertToUserMessage={noop} onForkAtMessage={noop} onEditUserMessage={noop}>
      <MessageList showWelcome={false} messages={messages} status={status} />
    </MessageListProvider></OpenTargetProvider></MemoryRouter></QueryClientProvider>);
  } finally { query.clear(); }
}

test("the messenger keeps reactions and file cards, delays initial typing and omits branch/revert actions", () => {
  const pending = render([user, activity], "streaming");
  expect(pending).not.toContain('data-assistant-typing=""');
  expect(pending).toContain('data-assistant-reaction=""');
  expect(pending).not.toContain("Read files");
  expect(pending).not.toContain("Internal thoughts");
  expect(pending).not.toContain("today.md");
  expect(render([user], "submitted")).not.toContain('data-assistant-typing=""');
  expect(pending).not.toContain('aria-label="Branch in new chat"');
  expect(pending).not.toContain('aria-label="Revert"');
  expect(render([user], "ready", false)).toContain('aria-label="Branch in new chat"');
  expect(render([user], "ready", false)).toContain('aria-label="Revert"');
  const done = render([user, activity, { ...response, parts: [shared] }], "ready");
  expect(done).toContain('data-assistant-file-card=""');
  expect(done).toContain("Morning briefing");
  expect(done).toContain(">Open<");
  expect(done.match(/data-assistant-file-card/g)).toHaveLength(1);
  expect(done).not.toContain('data-assistant-typing=""');
  expect(render([user, activity], "streaming", false)).not.toContain('data-assistant-typing=""');
});

test("delegated attachments render as named cards without displaying their storage paths or opening the UI", () => {
  const path = "Files/Assistant/share/1-Agreement.pdf";
  const html = render([{ ...user, parts: [{ type: "text", text: "Review the supplier agreement.", providerMetadata: { opencode: {
    legalworkAssistantSender: { name: "Johannes", icon: "cat" },
    legalworkSharedFiles: [{ name: "Agreement.pdf", path, bytes: 800 }],
  } } }] }], "ready", false);
  expect(html).toContain("Sent by Johannes");
  expect(html).toContain("Review the supplier agreement.");
  expect(html).toContain("Shared with this project");
  expect(html).toContain("Agreement.pdf");
  expect(html.match(/data-assistant-file-card/g)).toHaveLength(1);
  expect(html).toContain(">Open<");
  expect(html).not.toContain(path);
  expect(html).not.toContain("1-Agreement.pdf");
});

test("a project result keeps the chat link and a file card scoped to the original project", () => {
  const file = { path: "reports/review.md", title: "Provider-side review", size: 200,
    source: { workspaceId: "aster", workspaceRoot: "/projects/Aster", projectName: "Project Aster" } };
  const projectCard = tool("legalwork_assistant_share_file", { ok: true, file });
  const result: UIMessage = { ...response, parts: [{ type: "text", text: "The [provider-side review](/workspace/aster/session/review) is ready." }, projectCard] };
  const html = render([user, { ...result, parts: [projectCard] }], "ready");
  expect(assistantChatMessages([result])[0].parts[0]).toEqual(result.parts[0]);
  expect(html).toContain("Provider-side review");
  expect(html).toContain("Project Aster");
  expect(html.match(/data-assistant-file-card/g)).toHaveLength(1);
  expect(html).not.toContain(file.source.workspaceRoot);

  // A same-named file in the Assistant must never be substituted for the project output.
  const tab = assistantProjectFileTab(file);
  expect(tab).toMatchObject({ value: file.path, preview: "markdown", source: file.source });
  expect(tab?.id).not.toBe(`file:${file.path}`);
  const store = usePanelTabStore.getState();
  if (!tab) throw new Error("Expected a project file tab");
  store.openTab("assistant-fixture", tab);
  store.syncTranscriptArtifacts("assistant-fixture", []);
  expect(usePanelTabStore.getState().sessions["assistant-fixture"].tabs).toEqual([tab]);
  store.clearSession("assistant-fixture");

  const otherCard = tool("legalwork_assistant_share_file", { ok: true, file: { ...file, source: { ...file.source, workspaceId: "other" } } });
  expect(assistantChatMessages([{ ...response, parts: [projectCard, projectCard, otherCard] }])[0].parts).toEqual([projectCard, otherCard]);
});
