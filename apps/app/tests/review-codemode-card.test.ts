import { expect, test } from "bun:test";
import type { SessionInfo, SessionMessageAssistantTool } from "@opencode/client";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { projectMessages, projectSession, projectTool } from "../src/app/lib/opencode-view";
import { isReviewCardTool, reviewCardIdentity } from "../src/components/chat/review/review-tool";
import { getAssistantRenderGroups, groupAssistantToolRuns } from "../src/components/chat/utils";
import { parseDynamicToolUIPart } from "../src/react-app/domains/session/sync/parse-tool-parts";
import { snapshotToUIMessages } from "../src/react-app/domains/session/sync/usechat-adapter";

const card = {
  ok: true,
  workspaceId: "workspace",
  review: { id: "101ec043-4ef0-4df7-88b6-4690869e8830", name: "Test review", status: "running", completed: 0, total: 48, documents: 4, columns: 12 },
};
const session: SessionInfo = {
  id: "session", projectID: "project", location: { directory: "/fixture" },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 3 },
};
function nativeTool(options: { output?: string; toolCalls?: unknown; name?: string } = {}): SessionMessageAssistantTool {
  return {
    type: "tool", name: options.name ?? "execute", id: "start-review",
    time: { created: 1, ran: 2, completed: 3 },
    state: {
      status: "completed",
      input: { code: 'return await tools.legalwork_review_start({reviewId:"101ec043-4ef0-4df7-88b6-4690869e8830",revision:0});' },
      content: [{ type: "text", text: options.output ?? JSON.stringify(card) }],
      metadata: { toolCalls: options.toolCalls ?? [{ tool: "legalwork_review_start", status: "completed", input: { reviewId: card.review.id, revision: 0 } }] },
    },
  };
}
function livePart(tool = nativeTool()) {
  const part = parseDynamicToolUIPart(projectTool(session.id, "message", tool));
  if (!part) throw new Error("Expected a completed tool part");
  return part;
}

test("a native execute review result becomes a widget in live updates and reloaded history", () => {
  const tool = nativeTool();
  const history = snapshotToUIMessages({
    session: projectSession(session), todos: [], status: { type: "idle" },
    messages: projectMessages(session.id, [{
      id: "message", type: "assistant", time: { created: 1, completed: 3 },
      model: { providerID: "fixture", id: "model" }, agent: "legalwork",
      cost: 0, tokens: session.tokens, content: [tool],
    }]),
  });
  for (const parts of [[livePart(tool)], history[0].parts]) {
    for (const thinking of [false, true]) {
      const groups = getAssistantRenderGroups(parts, thinking);
      expect(groups.map(group => group.kind)).toEqual(["review"]);
      expect(groups[0]).toMatchObject({ kind: "review", part: { output: JSON.stringify(card) } });
    }
  }
  expect(reviewCardIdentity(livePart(tool))).toBe(`workspace:${card.review.id}`);
  expect(tool.name).toBe("execute");
});

test("review-looking output or model-authored code alone cannot attest a review action", () => {
  for (const toolCalls of [
    [], {}, [null, "legalwork_review_start", {}],
    [{ tool: "legalwork_review_files", status: "completed" }],
    [{ tool: "legalwork_review_start", status: "error" }],
    [{ tool: "legalwork_review_start", status: "running" }],
    [{ tool: "legalwork_review_start" }],
  ]) {
    const part = livePart(nativeTool({ toolCalls }));
    expect(isReviewCardTool(part)).toBe(false);
    expect(getAssistantRenderGroups([part], false)[0].kind).toBe("tools");
  }
  expect(isReviewCardTool(livePart(nativeTool({ name: "other" })))).toBe(false);
});

test("executed review actions require a valid successful card payload", () => {
  for (const output of ["not JSON", "{}", JSON.stringify({ ...card, ok: false }), JSON.stringify({ ...card, review: { ...card.review, id: "invalid" } })]) {
    const part = livePart(nativeTool({ output }));
    expect(isReviewCardTool(part)).toBe(false);
    expect(reviewCardIdentity(part)).toBeNull();
  }
});

test("direct create and executed start deduplicate across prose into the existing review widget", () => {
  const created: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "legalwork_review_create", toolCallId: "create-review",
    state: "output-available", input: {}, output: { ...card, review: { ...card.review, status: "draft" } },
  };
  const started = livePart();
  const messages: UIMessage[] = [
    { id: "created", role: "assistant", parts: [created] },
    { id: "prose", role: "assistant", parts: [{ type: "text", text: "Starting the review." }] },
    { id: "started", role: "assistant", parts: [started] },
  ];
  for (const thinking of [false, true]) {
    const groups = groupAssistantToolRuns(messages.map((message, index) => ({ message, index })), thinking)
      .flatMap(item => getAssistantRenderGroups(item.message.parts, thinking));
    expect(groups.filter(group => group.kind === "review")).toEqual([{ kind: "review", part: started }]);
    expect(groups.some(group => group.kind === "text")).toBe(true);
  }
});
