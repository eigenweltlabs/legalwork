import { afterEach, expect, test } from "bun:test";
import { QueryObserver } from "@tanstack/react-query";
import type { SessionInfo, SessionMessageAssistant } from "@opencode/client";
import type { UIMessage } from "ai";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import {
  __disposeWorkspaceSessionSyncForTest,
  ensureWorkspaceSessionSync,
  snapshotKey,
  trackWorkspaceSessionSync,
  seedSessionState,
  transcriptKey,
} from "../src/react-app/domains/session/sync/session-sync";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  getReactQueryClient().clear();
});

/** Protocol regression fixture; no model calls or claims of real-engine capability parity. */
test("upstream oversized-event rejection reconnects and recovers complete tool output from authoritative JSON", async () => {
  const output = "x".repeat(16 * 1024 * 1024 + 1024);
  const tokens = {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  };
  const session: SessionInfo = {
    id: "session-oversize",
    projectID: "project",
    location: { directory: "/fixture" },
    title: "Oversize",
    time: { created: 1, updated: 2 },
    cost: 0,
    tokens,
  };
  const message: SessionMessageAssistant = {
    id: "assistant",
    type: "assistant",
    agent: "legalwork",
    model: { id: "fixture", providerID: "fixture" },
    time: { created: 1, completed: 2 },
    content: [
      {
        type: "tool",
        id: "tool",
        name: "read",
        time: { created: 1, completed: 2 },
        state: {
          status: "completed",
          input: {},
          content: [{ type: "text", text: output }],
        },
      },
    ],
  };
  let connections = 0;
  let reads = 0;
  const encoder = new TextEncoder();
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/api/event")) {
        connections++;
        const connection = connections;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "server.connected", id: `connection-${connection}`, data: {} })}\n\n`,
                ),
              );
              if (connection === 1)
                controller.enqueue(
                  encoder.encode(
                    `data: ${JSON.stringify({ type: "session.tool.success", id: "oversized", created: 2, data: { sessionID: session.id, assistantMessageID: "assistant", id: "tool", content: [{ type: "text", text: output }], executed: true } })}\n\n`,
                  ),
                );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (path.endsWith("/snapshot")) {
        reads++;
        return Response.json({
          item: {
            session,
            messages: [message],
            todos: [],
            status: { type: "idle" },
          },
        });
      }
      if (
        path.endsWith("/api/permission/request") ||
        path.endsWith("/api/form")
      )
        return Response.json({ location: { directory: "/fixture" }, data: [] });
      return new Response(null, { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  const baseUrl = server.url.origin;
  const workspaceId = "native-stream";
  const api = createLegalworkServerClient({ baseUrl, token: "fixture" });
  const cache = getReactQueryClient();
  const observer = new QueryObserver(cache, {
    queryKey: snapshotKey(workspaceId, session.id),
    queryFn: async () => {
      const { item } = await api.getSessionSnapshot(workspaceId, session.id);
      seedSessionState(workspaceId, item);
      return item;
    },
  });
  cleanups.push(observer.subscribe(() => {}));
  await observer.refetch();
  const input = {
    workspaceId,
    baseUrl: `${baseUrl}/workspace/${workspaceId}/opencode`,
    legalworkToken: "fixture",
  };
  cleanups.push(ensureWorkspaceSessionSync(input));
  cleanups.push(trackWorkspaceSessionSync(input, session.id));
  cleanups.push(() => __disposeWorkspaceSessionSyncForTest(input));
  // A local test watchdog bounds only a broken fixture, never agent execution.
  const deadline = Date.now() + 8000;
  while (connections < 2 || reads < 3) {
    if (Date.now() > deadline)
      throw new Error(
        `Recovery did not complete: connections=${connections}, reads=${reads}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const transcript = cache.getQueryData<UIMessage[]>(
    transcriptKey(workspaceId, session.id),
  );
  expect(
    transcript?.[0].parts.find((part) => part.type === "dynamic-tool"),
  ).toMatchObject({ output });
  expect(connections).toBeGreaterThanOrEqual(2);
  expect(reads).toBeGreaterThanOrEqual(3);
}, 10_000);
