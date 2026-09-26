import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider, QueryObserver } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { SavedReviewSchema, type ReviewCell, type SavedReview } from "@legalwork/types/reviews";
import { ReviewProgressCard, ReviewToolCard } from "../src/components/chat/review/review-card";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { reviewKey } from "../src/react-app/domains/reviews/review-ui";
import { reviewCardQueryOptions } from "../src/components/chat/review/review-card-query";
import { parseReviewCard, reviewCardProgress } from "../src/components/chat/review/review-tool";
import { isSessionIndexRoute, workspaceReviewsRoute } from "../src/react-app/shell/workspace-routes";

const id = "101ec043-4ef0-4df7-88b6-4690869e8830";
const card = parseReviewCard({ ok: true, workspaceId: "project", review: { id, name: "NDA review", status: "running", completed: 0, total: 4, documents: 1, columns: 4 } });
if (!card) throw new Error("Invalid test fixture");
const reference = card;
function saved(status: SavedReview["status"], states: ReviewCell["status"][]): SavedReview {
  return SavedReviewSchema.parse({ id, name: "NDA review", revision: 1, createdAt: 1, updatedAt: 1,
    settings: { mode: "jev", jev: { providerId: "firm", model: "jev" }, llm: null }, columns: [],
    documents: [{ id: "doc", name: "nda.txt", path: "nda.txt", sourceHash: null, status: "ready" }],
    cells: states.map((status, index) => ({ documentId: "doc", columnKey: String(index), status })), status, runId: null,
  });
}
function markup(review: SavedReview, available = true) {
  return renderToStaticMarkup(<MemoryRouter><ReviewProgressCard progress={reviewCardProgress(reference, review)} href={workspaceReviewsRoute(reference.workspaceId, id)} available={available} /></MemoryRouter>);
}

function fullCard(review: SavedReview) {
  const cache = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } });
  cache.setQueryData(reviewKey(reference.workspaceId, id), review);
  const noop = () => {};
  const html = renderToStaticMarkup(<QueryClientProvider client={cache}><MemoryRouter>
    <MessageListProvider workspaceId={reference.workspaceId} sessionId="chat" showThinking={false} developerMode={false}
      displaySuggestions={false} providerConnectedCount={1} dispatchAction={noop} setPrompt={noop}
      onRevertToUserMessage={noop} onForkAtMessage={noop} onEditUserMessage={noop}>
      <ReviewToolCard part={{ type: "dynamic-tool", toolName: "legalwork_review_start", toolCallId: "start", state: "output-available", input: {}, output: reference }} />
    </MessageListProvider>
  </MemoryRouter></QueryClientProvider>);
  cache.clear(); return html;
}

test("fully processed cards have no continue action, including answers needing attention", () => {
  for (const review of [saved("complete", ["complete"]), saved("needs_review", ["complete", "needs_review"]), saved("cancelled", ["complete", "needs_review"])]) {
    review.runId = "completed-run";
    const html = fullCard(review);
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain("Open review");
    expect(html).not.toContain("<footer");
    expect(html).not.toContain("Continue review");
  }
  expect(fullCard(saved("needs_review", ["complete", "needs_review"]))).toContain("Needs attention: 1");
});

test("unfinished cards keep start, continue and stop actions", () => {
  expect(fullCard(saved("draft", ["pending"]))).toContain("Run review");
  const stopped = saved("cancelled", ["complete", "pending"]); stopped.runId = "stopped-run";
  expect(fullCard(stopped)).toContain("Continue review");
  expect(fullCard(saved("running", ["complete", "running"]))).toContain("Stop");
  // Keep cancellation available while the final result is being saved.
  expect(fullCard(saved("running", ["complete"]))).toContain("Stop");
});

test("the whole card links to its exact review and keeps completed progress visible", () => {
  const running = markup(saved("running", ["complete", "needs_review", "running", "queued"]));
  expect(running).toContain(`href="/workspace/project/reviews?review=${id}"`);
  expect(running).toContain('aria-label="Open review: NDA review"');
  expect(running).toContain('role="progressbar"');
  expect(running).toContain('aria-valuenow="50"');
  expect(running).toContain("Cells processed: 2 / 4");
  expect(running).toContain("1 running · 1 queued");
  expect(running).toContain("Needs attention: 1");
  const completed = markup(saved("complete", ["complete", "complete"]));
  expect(completed).toContain('aria-valuenow="100"');
  expect(completed).toContain("Complete");
  expect(completed).not.toContain("queued");
});

test("opening a review is never redirected back to the workspace's remembered chat", () => {
  for (const path of [workspaceReviewsRoute("project"), workspaceReviewsRoute("project", id).split("?")[0], "/workspace/project/project", "/workspace/project/tasks", "/workspace/project/settings", "/workspace/project/session/existing-session"])
    expect(isSessionIndexRoute(path)).toBe(false);
  for (const path of ["/session", "/workspace/project/session", "/workspace/project/session/", "/workspace/project%20name/session"])
    expect(isSessionIndexRoute(path)).toBe(true);
});

test("stopped, blocked and errored reviews do not falsely imply every cell succeeded", () => {
  const review = saved("cancelled", ["complete", "error", "blocked", "queued"]);
  const progress = reviewCardProgress(reference, review);
  expect(progress).toMatchObject({ done: 2, total: 4, percent: 50, attention: 2 });
  expect(markup(review)).toContain("Stopped");
  expect(markup(review)).toContain("Needs attention: 2");
  expect(markup(review, false)).not.toContain('href=');
});

test("mounting a start card refreshes even a fresh cached draft, then follows saved progress", async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  let server = saved("running", ["running", "queued"]);
  let calls = 0;
  const options = reviewCardQueryOptions({ getReview: async () => { calls++; return server; } }, reference.workspaceId, id);
  cache.setQueryData(options.queryKey, saved("draft", ["pending", "pending"]));
  const observer = new QueryObserver(cache, { ...options, staleTime: Infinity });
  const seen: number[] = [];
  let unwatch = () => {};
  await new Promise<void>(resolve => {
    unwatch = observer.subscribe(result => {
      if (result.data) seen.push(reviewCardProgress(reference, result.data).percent);
      if (result.data?.status === "running") resolve();
    });
  });
  expect(calls).toBe(1);
  server = saved("running", ["complete", "running"]);
  await observer.refetch();
  server = saved("complete", ["complete", "complete"]);
  await observer.refetch();
  expect(seen).toContain(0); expect(seen).toContain(50); expect(seen.at(-1)).toBe(100);
  unwatch(); cache.clear();
});

test("failed cards offer retry instead of rerunning completed results", () => {
  const html = fullCard(saved("needs_review", ["complete", "error"]));
  expect(html).toContain("Retry failed cells");
  expect(html).not.toContain("Continue review");
});
