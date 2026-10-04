import { expect, test } from "bun:test";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import {
  __applySessionSyncEventForTest,
  __createWorkspaceSessionSyncForTest,
  snapshotKey,
  trackWorkspaceSessionSync,
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

test("a structured Anthropic spend cap stops the first retry and persists provider recovery", async () => {
  let aborts = 0;
  const persisted: unknown[] = [];
  const sessionId = "anthropic-spend-session";
  const workspaceId = "anthropic-spend-workspace";
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/messages")) {
        return Response.json({ items: [{ info: { id: "anthropic-turn", role: "assistant", providerID: "anthropic" }, parts: [] }] });
      }
      if (url.pathname.endsWith("/usage-limit")) {
        persisted.push(await request.json());
        return Response.json({ ok: true });
      }
      if (url.pathname.endsWith("/abort")) {
        aborts++;
        return Response.json(true);
      }
      return Response.json({ item: { id: sessionId, directory: "/project/anthropic" } });
    },
  });
  const input = { workspaceId, baseUrl: new URL(`/workspace/${workspaceId}/opencode`, server.url).toString(), legalworkToken: "test" };
  const dispose = __createWorkspaceSessionSyncForTest(input);
  const query = getReactQueryClient();
  const error = {
    statusCode: 429,
    message: "The provider has changed its wording.",
    isRetryable: true,
    responseBody: JSON.stringify({ type: "error", error: { type: "rate_limit_error", details: { error_code: "enforced_spend_limit_reached" } } }),
  };
  try {
    const event = { type: "session.next.retried", properties: { sessionID: sessionId, attempt: 1, error } };
    __applySessionSyncEventForTest(input, event);
    __applySessionSyncEventForTest(input, event);
    // The legacy prose event must not override or race away the structured decision.
    __applySessionSyncEventForTest(input, { type: "session.status", properties: { sessionID: sessionId, status: { type: "retry", attempt: 1, message: "You've hit your usage limit", next: Date.now() + 1000 } } });
    for (let attempt = 0; attempt < 50 && !persisted.length; attempt++) await Bun.sleep(10);
    expect(aborts).toBe(1);
    expect(persisted).toEqual([{ messageId: "anthropic-turn" }]);
    expect(useComposerStateStore.getState().pausedQueues[sessionId]).toBe(true);
    const messages = query.getQueryData<UIMessage[]>(transcriptKey(workspaceId, sessionId));
    const text = messages?.at(-1)?.parts.find(part => part.type === "text");
    expect(text?.type === "text" && providerFromUsageLimitError(text.text)).toBe("anthropic");
  } finally {
    dispose();
    server.stop(true);
    query.clear();
  }
});

test("Anthropic throttling stays retryable even when prose mentions a usage limit", async () => {
  let aborts = 0;
  let messageReads = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.endsWith("/messages")) {
        messageReads++;
        return Response.json({ items: [{ info: { id: "throttled-turn", role: "assistant", providerID: "anthropic" }, parts: [] }] });
      }
      if (path.endsWith("/abort")) { aborts++; return Response.json(true); }
      return Response.json({ item: { id: "anthropic-rate-session", directory: "/project/anthropic" } });
    },
  });
  const input = { workspaceId: "anthropic-rate-workspace", baseUrl: new URL("/workspace/anthropic-rate-workspace/opencode", server.url).toString(), legalworkToken: "test" };
  const dispose = __createWorkspaceSessionSyncForTest(input);
  const message = "You've hit your usage limit; retry shortly.";
  try {
    __applySessionSyncEventForTest(input, {
      type: "session.next.retried",
      properties: { sessionID: "anthropic-rate-session", attempt: 1, error: { message, statusCode: 429, isRetryable: true, responseHeaders: { "retry-after": "2" }, responseBody: JSON.stringify({ type: "error", error: { type: "rate_limit_error", message } }) } },
    });
    __applySessionSyncEventForTest(input, { type: "session.status", properties: { sessionID: "anthropic-rate-session", status: { type: "retry", attempt: 1, message, next: Date.now() + 1000 } } });
    for (let attempt = 0; attempt < 50 && !messageReads; attempt++) await Bun.sleep(10);
    expect(messageReads).toBeGreaterThan(0);
    expect(aborts).toBe(0);
    expect(useComposerStateStore.getState().pausedQueues["anthropic-rate-session"]).not.toBe(true);
  } finally {
    dispose();
    server.stop(true);
  }
});

test("a terminal Anthropic billing failure immediately shows recovery and pauses follow-ups", () => {
  const input = { workspaceId: "anthropic-billing-workspace", baseUrl: "http://127.0.0.1:1", legalworkToken: "test" };
  const dispose = __createWorkspaceSessionSyncForTest(input);
  const release = trackWorkspaceSessionSync(input, "anthropic-billing-session");
  const query = getReactQueryClient();
  try {
    query.setQueryData(snapshotKey(input.workspaceId, "anthropic-billing-session"), { session: { id: "anthropic-billing-session" }, messages: [{ info: { id: "billing-turn", role: "assistant", providerID: "anthropic" } }] });
    __applySessionSyncEventForTest(input, {
      type: "session.error",
      properties: { sessionID: "anthropic-billing-session", error: { name: "APIError", data: { statusCode: 402, message: "Payment cannot be completed.", isRetryable: false, responseBody: JSON.stringify({ type: "error", error: { type: "billing_error" } }) } } },
    });
    expect(useComposerStateStore.getState().pausedQueues["anthropic-billing-session"]).toBe(true);
    const messages = query.getQueryData<UIMessage[]>(transcriptKey(input.workspaceId, "anthropic-billing-session"));
    const text = messages?.at(-1)?.parts.find(part => part.type === "text");
    expect(text?.type === "text" && providerFromUsageLimitError(text.text)).toBe("anthropic");
  } finally {
    release();
    dispose();
    query.clear();
  }
});
