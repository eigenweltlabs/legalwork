import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { AiPlansOverlay } from "../src/react-app/domains/onboarding/ai-plans-overlay";
import type { EngineProjectStatus } from "@legalwork/types/engine-project";
import { createLegalworkServerClient, LegalworkServerError } from "../src/app/lib/legalwork-server";
import { currentLocale, setLocale } from "../src/i18n";
import en from "../src/i18n/locales/en";
import de from "../src/i18n/locales/de";
import { approveReviewedEngineProject, changedEngineProjectStatus, EngineProjectApproval, EngineProjectApprovalNotice, EngineProjectRecoveryNotice, engineProjectRecoveryRefetchInterval, engineProjectStatusQueryKey } from "../src/react-app/domains/workspace/engine-project-approval";

const reviewed: EngineProjectStatus = {
  state: "approval_required", required: true, directory: "/fixture/matter",
  approvalScope: [{ directory: "/fixture", configPaths: ["/fixture/opencode.json"] }],
  plugins: [
    { target: "already-trusted", sources: ["/fixture/opencode.json"], approved: true },
    { target: "new-plugin", sources: ["/fixture/matter/.opencode/plugin.ts"], approved: false },
  ], projection: {},
};

test("AI setup keeps the project's approval review inside its covering dialog", () => {
  const client = createLegalworkServerClient({ baseUrl: "http://fixture.invalid" });
  const cache = new QueryClient();
  cache.setQueryData(engineProjectStatusQueryKey(client, "matter"), reviewed);
  try {
    const html = renderToStaticMarkup(<QueryClientProvider client={cache}><AiPlansOverlay
      mode="onboarding" variant="new" account={null} serverReady
      projectApproval={<EngineProjectApproval client={client} workspaceId="matter" />}
      onStartSignIn={async () => ({ authorizeUrl: "", sessionId: "" })}
      onWaitSignIn={async () => ({ connected: false })}
      onSignedIn={() => {}} onBringOwnModel={() => {}} onOpenBilling={() => {}}
      onCheckModels={async () => false}
    /></QueryClientProvider>);
    expect(html).toContain('data-testid="ai-plans-overlay"');
    expect(html).toContain('aria-label="Allow automation from this project?"');
    expect(html).toContain("/fixture/opencode.json");
    expect(html).toContain("/fixture/matter/.opencode/plugin.ts");
    expect(html).toContain("Allow project automation");
  } finally { cache.clear(); }
});

test("approval review exposes inherited execution scope, future edits and pending plugin origins", () => {
  const html = renderToStaticMarkup(<EngineProjectApprovalNotice status={reviewed} onApprove={() => {}} onRefresh={() => {}} />);
  expect(html).toContain("/fixture/matter");
  expect(html).toContain("/fixture/opencode.json");
  expect(html).toContain("/fixture/matter/.opencode/plugin.ts");
  expect(html).toContain("new-plugin");
  expect(html).not.toContain("already-trusted");
  expect(html).toContain("future edits");
  expect(html).toContain("includes version updates");
  expect(html).toContain("browse files before approving");
  const conflict = renderToStaticMarkup(<EngineProjectApprovalNotice status={{ ...reviewed, state: "configuration_conflict", projection: { diagnostic: "Existing authored file is incompatible" } }} onApprove={() => {}} onRefresh={() => {}} />);
  expect(conflict).toContain("Existing authored file is incompatible");
  expect(conflict).not.toContain("Allow project automation</button>");
});

test("a changed plugin declaration is presented for another explicit approval; it is never automatically accepted", async () => {
  const updated: EngineProjectStatus = { ...reviewed, plugins: [...reviewed.plugins, { target: "/external/new.ts", sources: ["/fixture/opencode.json"], approved: false }] };
  const submitted: unknown[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    submitted.push(await request.json());
    return submitted.length === 1
      ? Response.json({ code: "project_plugin_approval_changed", message: "Review new plugin", details: updated }, { status: 409 })
      : Response.json({ ...updated, state: "ready" });
  } });
  try {
    const client = createLegalworkServerClient({ baseUrl: server.url.origin, token: "nonsecret-fixture" });
    let refreshed: EngineProjectStatus | undefined;
    try { await approveReviewedEngineProject(client, "matter", reviewed); }
    catch (error) { refreshed = changedEngineProjectStatus(error); }
    expect(submitted).toEqual([{ directory: "/fixture/matter", pluginTargets: ["new-plugin"] }]);
    expect(refreshed).toEqual(updated);
    if (!refreshed) throw new Error("Expected updated review scope");
    expect(renderToStaticMarkup(<EngineProjectApprovalNotice status={refreshed} onApprove={() => {}} onRefresh={() => {}} />)).toContain("/external/new.ts");
    // This second call represents another human click after the new review.
    await approveReviewedEngineProject(client, "matter", refreshed);
    expect(submitted).toHaveLength(2);
    expect(submitted[1]).toEqual({ directory: "/fixture/matter", pluginTargets: ["new-plugin", "/external/new.ts"] });
  } finally { server.stop(true); }
});

test("recovery and approval appear together, while held chat identities stay private", () => {
  const client = createLegalworkServerClient({ baseUrl: "http://fixture.invalid", token: "nonsecret-fixture" });
  const cache = new QueryClient();
  const status: EngineProjectStatus = { ...reviewed, recovery: {
    mode: "recovery", heldSessionIds: ["private-held-chat"], waitingForOtherProjects: true,
    error: { code: "recovery_pending", message: "Review this project's saved changes before continuing." },
  } };
  cache.setQueryData(engineProjectStatusQueryKey(client, "matter"), status);
  try {
    const html = renderToStaticMarkup(<QueryClientProvider client={cache}><EngineProjectApproval client={client} workspaceId="matter" /></QueryClientProvider>);
    expect(html).toContain("Earlier interrupted work is paused");
    expect(html).toContain("Waiting for another project to be reviewed");
    expect(html).toContain("Other chats remain available");
    expect(html).toContain("Review this project&#x27;s saved changes before continuing.");
    expect(html).toContain("Try recovery again");
    expect(html).toContain("Allow project automation");
    expect(html).not.toContain("private-held-chat");
    expect(html).not.toContain("recovery_pending");
  } finally { cache.clear(); }
});

test("healthy projects remain usable while waiting; promotion and successful service have distinct notices", () => {
  const ready: EngineProjectStatus = { ...reviewed, state: "ready", recovery: {
    mode: "recovery", heldSessionIds: [], waitingForOtherProjects: true,
  } };
  const waiting = renderToStaticMarkup(<EngineProjectRecoveryNotice status={ready} onRetry={() => {}} />);
  expect(waiting).toContain("You can continue working here.");
  expect(waiting).not.toContain("work is paused");
  const promoting: EngineProjectStatus = { ...ready, recovery: { mode: "promoting", heldSessionIds: [], waitingForOtherProjects: false } };
  const promotion = renderToStaticMarkup(<EngineProjectRecoveryNotice status={promoting} onRetry={() => {}} />);
  expect(promotion).toContain("The connection is being updated");
  expect(promotion).not.toContain("Try recovery again");
  const service: EngineProjectStatus = { ...ready, recovery: { mode: "service", heldSessionIds: [], waitingForOtherProjects: false } };
  expect(renderToStaticMarkup(<EngineProjectRecoveryNotice status={service} onRetry={() => {}} />)).toBe("");
  expect(renderToStaticMarkup(<EngineProjectRecoveryNotice status={reviewed} onRetry={() => {}} />)).toBe("");
  expect(engineProjectRecoveryRefetchInterval(ready)).toBeGreaterThan(0);
  expect(engineProjectRecoveryRefetchInterval(promoting)).toBeGreaterThan(0);
  expect(engineProjectRecoveryRefetchInterval(service)).toBe(false);
  expect(engineProjectRecoveryRefetchInterval(reviewed)).toBe(false);
  expect(engineProjectRecoveryRefetchInterval(undefined)).toBe(false);
});

test("recovery text is translated in German, including a disabled in-progress retry", () => {
  const previous = currentLocale();
  setLocale("de");
  try {
    const status: EngineProjectStatus = { ...reviewed, recovery: { mode: "recovery", heldSessionIds: ["held"], waitingForOtherProjects: true } };
    const html = renderToStaticMarkup(<EngineProjectRecoveryNotice status={status} pending onRetry={() => {}} />);
    expect(html).toContain("Zuvor unterbrochene Arbeit ist pausiert");
    expect(html).toContain("Sie können hier weiterarbeiten.");
    expect(html).toContain("Wiederherstellung wird geprüft");
    expect(html).toContain("disabled");
    const keys = Object.keys(en).filter(key => key.startsWith("engine_project.recovery_"));
    expect(Object.keys(de).filter(key => key.startsWith("engine_project.recovery_"))).toEqual(keys);
    for (const key of keys) {
      expect(Object.entries(de).find(([name]) => name === key)?.[1]).not.toBe(Object.entries(en).find(([name]) => name === key)?.[1]);
    }
  } finally { setLocale(previous); }
});

test("typed recovery retry uses the selected server, encoded project, and existing authorization", async () => {
  const submitted: Array<{ path: string; method: string; authorization: string | null; text: string }> = [];
  const recovered: EngineProjectStatus = { ...reviewed, state: "ready", recovery: { mode: "service", heldSessionIds: [], waitingForOtherProjects: false } };
  let denied = false;
  const server = Bun.serve({ port: 0, async fetch(request) {
    submitted.push({ path: new URL(request.url).pathname, method: request.method, authorization: request.headers.get("authorization"), text: await request.text() });
    return denied ? Response.json({ code: "workspace_write_forbidden", message: "Only collaborators can retry recovery." }, { status: 403 }) : Response.json(recovered);
  } });
  try {
    const client = createLegalworkServerClient({ baseUrl: server.url.origin, token: "nonsecret-recovery-fixture" });
    expect(await client.retryEngineRecovery("matter /&")).toEqual(recovered);
    expect(submitted).toEqual([{ path: "/workspace/matter%20%2F%26/engine-project/retry-recovery", method: "POST", authorization: "Bearer nonsecret-recovery-fixture", text: "" }]);
    denied = true;
    let error: unknown;
    try { await client.retryEngineRecovery("matter /&"); } catch (failure) { error = failure; }
    expect(error).toBeInstanceOf(LegalworkServerError);
    expect(error).toMatchObject({ status: 403, code: "workspace_write_forbidden" });
    expect(submitted).toHaveLength(2);
    expect(submitted.every(request => request.path.endsWith("/engine-project/retry-recovery"))).toBe(true);
  } finally { server.stop(true); }
});
