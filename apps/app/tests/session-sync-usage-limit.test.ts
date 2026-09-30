import { expect, test } from "bun:test";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
  snapshotKey,
  transcriptKey,
} from "../src/react-app/domains/session/sync/session-sync";
import { useComposerStateStore } from "../src/react-app/domains/session/surface/composer-state-store";
import { providerFromUsageLimitError } from "../src/app/lib/provider-usage-limit";
import type { UIMessage } from "ai";

test("the first quota retry aborts a background task in its workspace and pauses follow-ups", async () => {
  const aborts: URL[] = [];
  const persisted: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/messages")) {
        return Response.json({ items: [{ info: { id: "assistant-turn", role: "assistant", providerID: "openai" }, parts: [] }] });
      }
      if (url.pathname === "/workspace/quota-workspace/sessions/quota-session/usage-limit") {
        persisted.push(await request.json());
        return Response.json({ ok: true });
      }
      if (url.pathname.endsWith("/abort")) {
        aborts.push(url);
        return Response.json(true);
      }
      return Response.json({
        id: "quota-session",
        directory: "/project/quota",
        model: { providerID: "openai" },
      });
    },
  });
  const input = {
    workspaceId: "quota-workspace",
    baseUrl: new URL("/workspace/quota-workspace/opencode", server.url).toString(),
    legalworkToken: "test",
  };
  const dispose = __createWorkspaceSessionSyncForTest(input);
  const query = getReactQueryClient();
  query.setQueryData(snapshotKey(input.workspaceId, "quota-session"), {
    session: { id: "quota-session", directory: "/project/quota" },
    messages: [
      {
        info: { id: "previous-turn", role: "assistant", providerID: "anthropic" },
      },
    ],
  });
  const event = {
    type: "session.status",
    properties: {
      sessionID: "quota-session",
      status: {
        type: "retry",
        attempt: 1,
        message: "usage_limit_reached",
        next: Date.now() + 1000,
      },
    },
  };
  try {
    __applySessionSyncEventForTest(input, event);
    __applySessionSyncEventForTest(input, event);
    for (let attempt = 0; attempt < 30 && !persisted.length; attempt++)
      await Bun.sleep(10);
    expect(aborts).toHaveLength(1);
    expect(persisted).toEqual([{ messageId: "assistant-turn" }]);
    expect(aborts[0].searchParams.get("directory")).toBe("/project/quota");
    expect(useComposerStateStore.getState().pausedQueues["quota-session"]).toBe(
      true,
    );
    const messages = query.getQueryData<UIMessage[]>(
      transcriptKey(input.workspaceId, "quota-session"),
    );
    const text = messages?.at(-1)?.parts.find((part) => part.type === "text");
    expect(
      text?.type === "text" && providerFromUsageLimitError(text.text),
    ).toBe("openai");
  } finally {
    dispose();
    server.stop(true);
    query.clear();
  }
});

test("temporary throttling does not abort the task", async () => {
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      calls++;
      return Response.json(true);
    },
  });
  const input = {
    workspaceId: "rate-workspace",
    baseUrl: server.url.toString(),
    legalworkToken: "test",
  };
  const dispose = __createWorkspaceSessionSyncForTest(input);
  try {
    __applySessionSyncEventForTest(input, {
      type: "session.status",
      properties: {
        sessionID: "rate-session",
        status: {
          type: "retry",
          attempt: 1,
          message: "Rate limit exceeded",
          next: Date.now() + 1000,
        },
      },
    });
    await Bun.sleep(30);
    expect(calls).toBe(0);
  } finally {
    dispose();
    server.stop(true);
  }
});
