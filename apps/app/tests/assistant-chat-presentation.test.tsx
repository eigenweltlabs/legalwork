import { expect, test } from "bun:test";
import type { ToolPart } from "@legalwork/types/opencode-view";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import DOMPurify from "dompurify";
import { assistantHasVisibleContent, assistantChatMessages, assistantProjectFileTab, assistantReactions, linkedAssistantFiles } from "../src/components/chat/assistant-chat-presentation";
import { useSessionActivityStore } from "../src/react-app/domains/session/status/session-activity-store";
import { usePanelTabStore } from "../src/react-app/domains/session/panel/panel-tab-store";
import { MessageList } from "../src/components/chat/message-list";
import { AssistantSharedFileCard, AssistantLinkedFileCards } from "../src/components/chat/assistant-chat-cards";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { OpenTargetProvider } from "../src/lib/target-provider";
import { resolveHrefOpenTarget, type OpenTarget } from "../src/react-app/domains/session/artifacts/open-target";
import { parseDynamicToolUIParts } from "../src/react-app/domains/session/sync/parse-tool-parts";

const user: UIMessage = { id: "user", role: "user", parts: [{ type: "text", text: "Please check the matters" }] };
const tool = (name: string, output: unknown): DynamicToolUIPart => ({ type: "dynamic-tool", toolName: name, toolCallId: name, state: "output-available", input: {}, output });
const shared = tool("legalwork_assistant_share_file", { ok: true, file: { path: "briefings/today.md", title: "Morning briefing", size: 1200 } });
const activity: UIMessage = { id: "activity", role: "assistant", parts: [
  tool("read", "File read"), tool("write", { path: "briefings/today.md" }), { type: "reasoning", text: "Internal thoughts" },
  { type: "file", mediaType: "text/markdown", filename: "today.md", url: "briefings/today.md" },
  tool("legalwork_assistant_react", { ok: true, reaction: { messageId: "user", emoji: "👍" } }),
] };
const response: UIMessage = { id: "response", role: "assistant", parts: [{ type: "text", text: "Your briefing is ready." }, shared] };

test("a verified Code Mode heart renders on the bubble even when the script discards its output", () => {
  const reaction = { ok: true, reaction: { messageId: user.id, emoji: "❤️" } };
  const metadata = { toolCalls: [{ tool: "legalwork_assistant_react", status: "completed" }], legalworkToolResults: [{ tool: "legalwork_assistant_react", input: { emoji: "❤️" }, output: reaction }] };
  const part = { id: "part", sessionID: "chat", messageID: "reply", type: "tool", tool: "execute", callID: "call", state: { status: "completed", input: { code: "discarded" }, output: "done", title: "", metadata, time: { start: 1, end: 2 } } } satisfies ToolPart;
  const reply: UIMessage = { id: "reply", role: "assistant", parts: parseDynamicToolUIParts(part) };
  expect(assistantReactions([user, reply]).get(user.id)).toBe("❤️");
  expect(render([user, reply], "ready")).toContain('data-assistant-reaction=""');
  const fake: UIMessage = { ...reply, parts: parseDynamicToolUIParts({ ...part, state: { ...part.state, output: JSON.stringify(reaction), metadata: { toolCalls: metadata.toolCalls } } }) };
  expect(assistantReactions([user, fake]).size).toBe(0);
});

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

function render(messages: UIMessage[], status: "ready" | "submitted" | "streaming" | "retrying", assistantChat = true, assistantTyping?: boolean) {
  const query = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  const noop = () => {};
  try {
    return renderToStaticMarkup(<QueryClientProvider client={query}><MemoryRouter><OpenTargetProvider onOpenTarget={noop}><MessageListProvider assistantChat={assistantChat} workspaceId="fixture" sessionId="chat"
      showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={0} dispatchAction={noop} setPrompt={noop} onRevertToUserMessage={noop} onForkAtMessage={noop} onEditUserMessage={noop}>
      <MessageList showWelcome={false} messages={messages} status={status} assistantTyping={assistantTyping} />
    </MessageListProvider></OpenTargetProvider></MemoryRouter></QueryClientProvider>);
  } finally { query.clear(); }
}

test("an outgoing bubble is visible before delivery, without canonical message edit actions", () => {
  const pending = render([{ ...user, metadata: { localOutgoing: true } }], "ready");
  expect(pending).toContain("Please check the matters");
  expect(pending).toContain('data-user-message-bubble=""');
  expect(pending).not.toContain('aria-label="Edit message"');
  expect(render([user], "ready")).toContain('aria-label="Edit message"');
});

test("the messenger keeps reactions and file cards, hides typing during tools and omits branch/revert actions", () => {
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

test("typing sits after the acknowledgement only while the next bubble's text is being written", () => {
  // Trusted fixture prose only; the Bun renderer has no browser DOM.
  const sanitize = Object.getOwnPropertyDescriptor(DOMPurify, "sanitize");
  Object.defineProperty(DOMPurify, "sanitize", { value: (html: string) => html, configurable: true });
  try {
    const acknowledgement: UIMessage = { id: "ack", role: "assistant", parts: [{ type: "text", text: "I will take care of it and let you know when done." }] };
    const messages = [user, acknowledgement];
    expect(render(messages, "streaming", true)).not.toContain('data-assistant-typing=""');
    // The surface buffers incomplete text, passing its typing state separately.
    const html = render(messages, "streaming", true, true);
    expect(html.match(/data-assistant-typing/g)).toHaveLength(1);
    const afterAcknowledgement = html.slice(html.indexOf("I will take care of it"));
    expect(afterAcknowledgement).toContain('data-assistant-typing=""');
    expect(afterAcknowledgement).not.toContain('aria-label="Copy message"');
    expect(afterAcknowledgement).not.toContain("my-2");
    for (const status of ["ready", "retrying"] satisfies Array<"ready" | "retrying">) {
      expect(render(messages, status, true, true)).not.toContain('data-assistant-typing=""');
    }
    expect(render(messages, "submitted", true)).not.toContain('data-assistant-typing=""');
    const streaming: UIMessage = { ...acknowledgement, parts: [{ type: "text", text: "The result", state: "streaming" }] };
    expect(render([user, streaming], "streaming")).toContain('data-assistant-typing=""');
  } finally {
    if (sanitize) Object.defineProperty(DOMPurify, "sanitize", sanitize);
    else Reflect.deleteProperty(DOMPurify, "sanitize");
  }
});

test("submitted, thinking and delegated work never create a typing bubble", () => {
  const reasoning: UIMessage = { id: "reasoning", role: "assistant", parts: [{ type: "reasoning", text: "Preparing the response", state: "streaming" }] };
  for (const messages of [[user], [user, reasoning], [user, activity]]) {
    for (const status of ["submitted", "streaming"] satisfies Array<"submitted" | "streaming">) {
      const html = render(messages, status);
      expect(html).not.toContain('data-assistant-typing=""');
      expect(html).not.toContain("Preparing the response");
    }
    // Finished, stopped and pending user interactions all present ready state.
    expect(render(messages, "ready")).not.toContain('data-assistant-typing=""');
    expect(render(messages, "retrying")).not.toContain('data-assistant-typing=""');
    expect(render(messages, "streaming", false)).not.toContain('data-assistant-typing=""');
  }
  try {
    useSessionActivityStore.getState().setError("fixture", "chat", "Response failed");
    expect(render([user], "streaming", true, true)).not.toContain('data-assistant-typing=""');
  } finally { useSessionActivityStore.getState().clearError("fixture", "chat"); }
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


test("saved reports and dashboards have a deliberate document card without internal filenames", () => {
  const path = "Reports/11111111-1111-4111-8111-111111111111.view.json";
  const card = tool("legalwork_assistant_share_file", { ok: true, file: { path, title: "Morning briefing", documentType: "report", size: 400 } });
  const saved = tool("legalwork_assistant_save_report", { ok: true, path });
  expect(assistantChatMessages([user, { ...response, parts: [saved, card] }])[1].parts).toEqual([card]);
  const kinds: Array<"report" | "dashboard"> = ["report", "dashboard"];
  for (const documentType of kinds) {
    const html = renderToStaticMarkup(<OpenTargetProvider onOpenTarget={() => {}}><AssistantSharedFileCard file={{ path, title: "Morning briefing", documentType }} /></OpenTargetProvider>);
    expect(html).toContain('aria-label="Open: Morning briefing"');
    expect(html).not.toContain(".view.json");
    expect(html).not.toContain('disabled=""');
  }
});

test("linked saved views use their verified document type and open the rendered view", () => {
  for (const documentType of ["dashboard", "report"] satisfies Array<"dashboard" | "report">) {
    const path = "Moved/11111111-1111-4111-8111-111111111111.view.json";
    const targets: OpenTarget[] = [{ id: `file:${path.toLowerCase()}`, kind: "file", value: path, name: "11111111-1111-4111-8111-111111111111.view.json", preview: "view", documentType, confidence: 95, reason: "link", exists: true }];
    const linked: UIMessage = { ...response, parts: [{ type: "text", text: `[Your day](${path}) is ready.` }] };
    const html = renderToStaticMarkup(<OpenTargetProvider openTargets={targets} onOpenTarget={() => {}}><AssistantLinkedFileCards messages={[linked]} /></OpenTargetProvider>);
    expect(html).toContain(documentType === "dashboard" ? ">Dashboard<" : ">Report<");
    expect(html).toContain('aria-label="Open: Your day"');
    expect(html).not.toContain(">JSON<");
    expect(html).not.toContain(".view.json");
    expect(resolveHrefOpenTarget(path, targets)).toMatchObject({ value: path, preview: "view", documentType });
  }
});


test("date dividers require visible content, not empty days or background activity", () => {
  expect(assistantHasVisibleContent([])).toBe(false);
  expect(assistantHasVisibleContent([activity])).toBe(false);
  expect(assistantHasVisibleContent([{ ...response, parts: [{ type: "text", text: " \n" }] }])).toBe(false);
  expect(assistantHasVisibleContent([user])).toBe(true);
  expect(assistantHasVisibleContent([response])).toBe(true);
  expect(assistantHasVisibleContent([{ ...response, parts: [shared] }])).toBe(true);
  expect(assistantHasVisibleContent([{ ...user, parts: [{ type: "file", mediaType: "image/png", url: "image.png" }] }])).toBe(true);
});
