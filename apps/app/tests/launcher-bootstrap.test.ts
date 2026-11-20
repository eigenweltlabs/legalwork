import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { LegalworkServerError, type LegalworkWorkspaceInfo } from "../src/app/lib/legalwork-server";
import { launcherBootstrapQueries } from "../src/react-app/launcher/launcher-bootstrap";

test("Assistant access failure leaves project navigation available and can be retried independently", async () => {
  const project: LegalworkWorkspaceInfo = { id: "project", name: "Matter", path: "/matter", preset: "project", workspaceType: "local" };
  const failure = new LegalworkServerError(403, "assistant_subscription_required", "Assistant subscription required");
  let assistantCalls = 0;
  const queries = launcherBootstrapQueries({
    baseUrl: "http://localhost:1234",
    assistantConversationCurrent: async () => { assistantCalls++; throw failure; },
    listWorkspaces: async () => ({ items: [project, { ...project, id: "wiki", preset: "wiki" }, { ...project, id: "assistant", preset: "main-assistant" }] }),
  });
  const cache = new QueryClient();
  try {
    const [assistant, workspaces] = await Promise.allSettled([cache.fetchQuery(queries.assistant), cache.fetchQuery(queries.workspaces)]);
    expect(assistant).toEqual({ status: "rejected", reason: failure });
    expect(workspaces).toEqual({ status: "fulfilled", value: [project] });
    expect(assistantCalls).toBe(1);
    await expect(cache.fetchQuery(queries.assistant)).rejects.toBe(failure);
    expect(assistantCalls).toBe(2);
    expect(cache.getQueryData(queries.workspaces.queryKey)).toEqual([project]);
  } finally { cache.clear(); }
});

test("bootstrap waits for a connection and retries transient errors only once", () => {
  const queries = launcherBootstrapQueries(null);
  expect(queries.assistant.enabled).toBe(false);
  expect(queries.workspaces.enabled).toBe(false);
  expect(queries.assistant.retry(0, new Error("Connection lost"))).toBe(true);
  expect(queries.assistant.retry(1, new Error("Connection lost"))).toBe(false);
  expect(queries.workspaces.retry(0, new LegalworkServerError(401, "unauthorized", "Sign in"))).toBe(false);
});
