import { providerListQueryKey } from "@/react-app/infra/provider-list-query";
import { ProjectFileImportContext } from "./react-app/domains/workspace/use-project-file-import";
import { WorkspaceWindowButton } from "./react-app/domains/session/panel/workspace-window-button";
import { DocumentDiscardDialog } from "./react-app/domains/session/artifacts/document-discard-dialog";
import { projectFileTab } from "./react-app/domains/workspace/project-file-tab";
import type { ProjectFileLink } from "@legalwork/types/project-files";
import type { WikiVault } from "@legalwork/types/wiki";
import type { ViewInput, ViewOwner, ViewRecord } from "@legalwork/types/views";
import { useViewGenerationStore, viewDraftTab, viewGenerationId, type ViewGeneration } from "./react-app/domains/views/view-generation";
import { sameViewOwner, viewInput } from "./react-app/domains/views/view-save";
import type { ToolPart } from "@opencode-ai/sdk/v2/client";
import { registerEmptySession } from "./react-app/domains/session/sidebar/session-list-visibility";
import { projectViewFromPath, workspaceSessionRoute } from "./react-app/shell/workspace-routes";
/** @jsxImportSource react */
// Dev-only fixture: deliberately absent from the production Vite inputs.
// Uses the real session, composer, navigation, files, and Memory Drive views.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";

import {
  createLegalworkServerClient,
  LegalworkServerError,
  type LegalworkServerClient,
  type LegalworkSessionSnapshot,
  type LegalworkTask,
  type LegalworkWorkspaceDirectoryEntry,
  type LegalMemoryTreeFile,
} from "@/app/lib/legalwork-server";
import type { WorkspaceInfo } from "@/app/lib/desktop";
import type { ComposerDraft, WorkspaceSessionGroup } from "@/app/types";
import { Toaster, toast } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { initLocale, setLocale } from "@/i18n";
import { SavedReviewSchema } from "@legalwork/types/reviews";
import { usePanelTabStore, workspacePanelKey } from "@/react-app/domains/session/panel/panel-tab-store";
import { useSessionInboxStore } from "@/react-app/domains/session/sidebar/session-inbox-store";
import { requestPanelTab } from "@/react-app/domains/session/panel/panel-tab-request";
import { useLocale } from "@/i18n/use-locale";
import { SessionPage } from "@/react-app/domains/session/chat/session-page";
import { ProviderAuthModal } from "@/react-app/domains/connections/provider-auth";
import { AiPlansOverlay } from "@/react-app/domains/onboarding/ai-plans-overlay";
import type { AiPlansVariant } from "@/app/lib/eigenwelt-access";
import { seedSessionState, snapshotKey, transcriptKey } from "@/react-app/domains/session/sync/session-sync";
import { seedPermissionState, seedQuestionState } from "@/react-app/domains/session/sync/interaction-state";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { eigenweltEntitlementsQueryKey } from "@/react-app/domains/connections/eigenwelt-entitlements";
import { LocalProvider } from "@/react-app/kernel/local-provider";
import { LegalworkControlProvider } from "@/react-app/shell/control/control-provider";
import { ShellConfigProvider } from "@/react-app/shell/shell-config";
import { ReloadCoordinatorProvider } from "@/react-app/shell/reload-coordinator";
import { WorkspaceProvider } from "@/react-app/shell/workspace-provider";
import "./app/index.css";
import { WorkflowsPreview } from "./workflows-preview";
import { TasksPane } from "@/react-app/domains/tasks/tasks-pane";
import { CalendarView } from "@/react-app/domains/calendar/calendar-view";
import { AppHome } from "@/react-app/domains/session/home/app-home";
import { submitHomeMessage, type PendingHomeMessage } from "@/react-app/domains/session/home/home-submission";
import { providerUsageLimitErrorText } from "@/app/lib/provider-usage-limit";
import { organizationRequestLimit, usageLimitFixture } from "@/react-app/design-system/usage-limit-fixture";

if (!import.meta.env.DEV) throw new Error("The session fixture is available only in development.");
initLocale();

const now = Date.now();
const previewParams = new URLSearchParams(window.location.search);
const dashboardExplorer = previewParams.has("dashboard-explorer");
const platform = previewParams.get("platform");
const captionHeight = previewParams.has("tall-titlebar") ? 64 : 44;
if (platform === "mac" || platform === "windows") document.documentElement.classList.add("legalwork-electron", `legalwork-platform-${platform}`);
if (previewParams.has("lang")) setLocale(previewParams.get("lang") === "de" ? "de" : "en");
if (previewParams.has("theme")) document.documentElement.dataset.theme = previewParams.get("theme") === "dark" ? "dark" : "light";
// `?subscription=ended&role=member` previews expiry without connected services.
const subscriptionPreview = previewParams.get("subscription") === "ended";
const trialPreview = previewParams.has("trial");
const limitParam = previewParams.get("limit") ?? (subscriptionPreview ? "pro" : trialPreview ? "plus" : null);
const limitPlan = limitParam === "sync" || limitParam === "plus" || limitParam === "pro" ? limitParam : null;
const model = { providerID: previewParams.get("provider") ?? (trialPreview ? "eigenwelt" : "openai"), modelID: previewParams.has("composer-layout") ? "GPT-5.6 Terra" : "Preview model" };
const requestTooLarge = previewParams.has("requestTooLarge");
const limitFixture = usageLimitFixture(limitPlan, previewParams.get("role") !== "member", model.providerID, requestTooLarge);
const upgradePreview = previewParams.get("upgrade");
const topUpPreview = previewParams.get("topup") ?? (trialPreview ? "success" : null);
const intentPreview = requestTooLarge ? "request" : previewParams.get("intent");
let topUpPending: { operationId: string; amountCents: number } | null = null;
let topUpReadyAt = 0;
let failNextUsageRead = false;
let hostedUpgrade: { plan: "plus" | "pro"; readyAt: number } | null = null;
if (upgradePreview) limitFixture.usage.me.blockedReason = "wallet_empty";
if (topUpPreview) {
  limitFixture.usage.walletCents = 0;
  limitFixture.usage.me.blockedReason = "wallet_empty";
  limitFixture.usage.me.extraUsedCents = 0;
  limitFixture.usage.me.extraRemainingCents = 0;
}
if (intentPreview === "personal" || intentPreview === "organization" || intentPreview === "enable") {
  limitFixture.usage.me.blockedReason = intentPreview === "personal" ? "member_limit" : intentPreview === "organization" ? "organization_limit" : "extra_disabled";
  if (intentPreview !== "personal") limitFixture.usage.me.extraUsedCents = 0;
  if (intentPreview === "organization") limitFixture.usage.orgExtraLimitCents = limitFixture.usage.orgExtraUsedCents;
  if (intentPreview === "enable") limitFixture.usage.extraEnabled = false;
}
const workspace: WorkspaceInfo = {
  id: "visual-workspace", name: "Northstar Legal", displayName: "Northstar Legal",
  path: "/workspaces/northstar-legal", preset: "starter", workspaceType: "local",
};
const otherWorkspace: WorkspaceInfo = {
  ...workspace, id: "visual-personal", name: "Personal", displayName: "Personal", path: "/workspaces/personal",
};
const fixtureWiki: WikiVault = { id: "visual-wiki", workspaceId: "visual-wiki-workspace", name: "Firm knowledge", root: "/synthetic/wiki", allowInProjects: true, sync: null, writable: true, pageCount: 0, totalBytes: 0, syncStatus: { state: "local", lastSyncedAt: null, error: null, conflicts: [] } };
const wikiWorkspace: WorkspaceInfo = { ...workspace, id: fixtureWiki.workspaceId, name: fixtureWiki.name, displayName: fixtureWiki.name, path: fixtureWiki.root, preset: "wiki" };
const fixtureWorkspaces = [workspace, otherWorkspace, ...(dashboardExplorer ? [wikiWorkspace] : []), ...(previewParams.has("many-destinations") ? Array.from({ length: 18 }, (_, index) => ({ ...otherWorkspace, id: `visual-destination-${index}`, name: `Project ${String(index + 1).padStart(2, "0")}`, displayName: `Project ${String(index + 1).padStart(2, "0")}`, path: `/synthetic/project-${index}` })) : [])];
const welcomeId = "visual-welcome";
const reply = "I've reviewed the sample terms and organized the key points.\n\n### Review priorities\n\n1. **Liability:** confirm the agreed cap applies consistently.\n2. **Termination:** align the notice periods for both parties.\n3. **Data handling:** make the return and deletion process explicit.\n\nThe next step is to compare these points against your standard playbook. This is a simulated response for visual review.";
const snapshots = new Map<string, LegalworkSessionSnapshot>();
const queryClient = getReactQueryClient();
queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });
if (trialPreview && limitFixture.entitlements.entitlements) {
  const endsAt = new Date(now + 3 * 86_400_000).toISOString();
  limitFixture.usage.trial = { endsAt };
  limitFixture.usage.billingInterval = previewParams.has("annual") ? "year" : "month";
  limitFixture.usage.me.allowanceCents = limitPlan === "pro" ? 7000 : 2900;
  limitFixture.usage.me.extraLimitCents = 0;
  limitFixture.usage.me.baseExtraLimitCents = 0;
  limitFixture.usage.me.resetsAt = endsAt;
  limitFixture.usage.extraEnabled = false;
  limitFixture.usage.me.blockedReason = "extra_disabled";
  limitFixture.entitlements.entitlements.subscriptionStatus = "trialing";
  limitFixture.entitlements.entitlements.trialEndsAt = endsAt;
  queryClient.setQueryData(eigenweltEntitlementsQueryKey(), limitFixture.entitlements);
}
if (subscriptionPreview && limitFixture.entitlements.account && limitFixture.entitlements.entitlements) {
  limitFixture.entitlements.account.orgRole = limitFixture.usage.isAdmin ? "org:admin" : "org:member";
  limitFixture.entitlements.entitlements.subscriptionStatus = "canceled";
  limitFixture.entitlements.entitlements.features = [];
  limitFixture.usage.enabled = false;
  limitFixture.usage.me.blockedReason = null;
  queryClient.setQueryData(eigenweltEntitlementsQueryKey(), limitFixture.entitlements);
}
if (previewParams.has("review-checks")) {
  for (const directory of [workspace.path, otherWorkspace.path]) queryClient.setQueryData(providerListQueryKey({ baseUrl: "https://legalwork-preview.invalid/opencode", directory }), {
    all: [{ id: model.providerID, name: "Preview models", source: "api", models: { [model.modelID]: { id: model.modelID, name: model.modelID, capabilities: { reasoning: false } }, "Drafting model": { id: "Drafting model", name: "Drafting model", capabilities: { reasoning: false } } } }], connected: [model.providerID], default: { [model.providerID]: model.modelID },
  });
}
let copyFailed = false;
async function previewCopyDelay() {
  if (!previewParams.has("review-checks")) return;
  await new Promise(resolve => setTimeout(resolve, 2000));
  if (!copyFailed) { copyFailed = true; throw new Error("Simulated interrupted copy. Retry to finish."); }
}


function snapshot(id: string, title: string, prompt?: string): LegalworkSessionSnapshot {
  const turn = snapshots.get(id)?.messages.length ?? 0;
  const userId = `${id}-user-${turn}`;
  const assistantId = `${id}-assistant-${turn}`;
  return {
    session: { id, title, slug: id, projectID: workspace.id, directory: workspace.path, version: "1", time: { created: now, updated: now } },
    status: { type: "idle" }, todos: [],
    messages: prompt ? [
      {
        info: { id: userId, sessionID: id, role: "user", time: { created: now - 60_000 }, agent: "build", model },
        parts: [{ id: `${userId}-text`, sessionID: id, messageID: userId, type: "text", text: prompt }],
      },
      {
        info: {
          id: assistantId, sessionID: id, role: "assistant", parentID: userId,
          time: { created: now - 59_000, completed: now - 55_000 }, providerID: model.providerID, modelID: model.modelID,
          mode: "build", agent: "build", path: { cwd: workspace.path, root: workspace.path }, cost: 0,
          tokens: { input: 420, output: 180, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop",
        },
        parts: [{ id: `${assistantId}-text`, sessionID: id, messageID: assistantId, type: "text", text: reply }],
      },
    ] : [],
  };
}

function saveSnapshot(item: LegalworkSessionSnapshot) {
  snapshots.set(item.session.id, item);
  const projectId = item.session.directory === otherWorkspace.path ? otherWorkspace.id : workspace.id;
  queryClient.setQueryData(snapshotKey(projectId, item.session.id), item);
  seedSessionState(projectId, item);
}

saveSnapshot(snapshot(welcomeId, "New task"));
// Open the same untouched chat in two preview windows to exercise list visibility.
const emptyChatId = previewParams.has("empty-chat") ? `visual-empty-${previewParams.get("empty-chat")}` : null;
if (emptyChatId) { registerEmptySession(emptyChatId); saveSnapshot(snapshot(emptyChatId, "New chat visibility check")); }
saveSnapshot(snapshot("visual-review", "Review supplier agreement", "Review the supplier agreement against our standard playbook and highlight the clauses that need attention."));
saveSnapshot(snapshot("visual-board", "Prepare board meeting notes", "Help me organize the open legal topics for next week's board meeting."));
saveSnapshot(snapshot("visual-policy", "Update the privacy policy", "Summarize the changes we need to make to the privacy policy."));

// `?statusStates` lines up one chat per sidebar indicator, each named after the
// state it stands for, so the whole vocabulary can be compared in one look.
const statusStateRows = ["idle", "thinking", "responding", "waiting", "compacting", "error", "unread"] as const;
const statusStatesById: Record<string, string> = {};
if (previewParams.has("statusStates")) {
  for (const state of statusStateRows) {
    saveSnapshot(snapshot(`visual-state-${state}`, state));
    // `idle` draws nothing and `unread` comes from the inbox store below.
    if (state !== "idle" && state !== "unread") statusStatesById[`visual-state-${state}`] = state;
  }
  useSessionInboxStore.setState({
    trackingStartedAt: 1,
    entries: { "visual-state-unread": { workspaceId: workspace.id, sessionId: "visual-state-unread", updatedAt: 2, assistantAt: 2 } },
    readAt: {},
  });
}
if (limitParam) {
  const item = snapshot("visual-limit", "Review supplier agreement", "Review the supplier agreement and highlight the clauses that need attention.");
  saveSnapshot({
    ...item,
    messages: item.messages.map(message => message.info.role === "assistant" ? {
      ...message, parts: [], info: { ...message.info, error: subscriptionPreview ? {
        name: "APIError", data: { statusCode: 403, providerID: "eigenwelt", message: "Forbidden",
          responseBody: '{"error":{"message":"team not allowed to access model","type":"team_model_access_denied"}}' },
      } : { name: "UnknownError", data: { message: providerUsageLimitErrorText(model.providerID, requestTooLarge ? organizationRequestLimit : null) } } },
    } : message),
  });
  if (previewParams.has("continued")) {
    const previous = snapshots.get("visual-limit");
    const continued = snapshot("visual-limit", "Review supplier agreement", "Hallo?");
    saveSnapshot({ ...continued, messages: [...(previous?.messages ?? []), ...continued.messages] });
  }
}

// `?subagentApprovals` exercises the real descendant selectors and approval
// panels. Decisions are simulated locally, like the rest of this fixture.
const subagentApprovals = new URLSearchParams(window.location.search).has("subagentApprovals");
if (subagentApprovals) {
  for (const { id, parentID, title } of [
    { id: "visual-research", parentID: "visual-review", title: "Research contract history" },
    { id: "visual-reference", parentID: "visual-research", title: "Compare policy references" },
  ]) {
    const item = snapshot(id, title);
    saveSnapshot({ ...item, session: { ...item.session, parentID } });
    seedPermissionState(workspace.id, id, [{
      id: `approval-${id}`, sessionID: id, permission: "external_directory",
      patterns: ["/Shared/Client precedents/*"], metadata: { path: "/Shared/Client precedents", description: "Read the precedents used for this review" }, always: [],
    }]);
  }
  for (const { id, title, running } of [
    { id: "visual-drafting", title: "Draft review summary", running: true },
    { id: "visual-completed", title: "Check liability clauses", running: false },
  ]) {
    const item = snapshot(id, title, running ? undefined : "Check the liability clauses.");
    saveSnapshot({ ...item, session: { ...item.session, parentID: "visual-review" }, status: { type: running ? "busy" : "idle" } });
  }
  const parent = snapshots.get("visual-review");
  if (parent) saveSnapshot({ ...parent, messages: parent.messages.map(message => {
    if (message.info.role !== "assistant") return message;
    const tools: ToolPart[] = [
      { id: "visual-research", title: "Research contract history", completed: false },
      { id: "visual-drafting", title: "Draft review summary", completed: false },
      { id: "visual-completed", title: "Check liability clauses", completed: true },
    ].map(agent => ({
      type: "tool", id: `tool-${agent.id}`, callID: `call-${agent.id}`, messageID: message.info.id, sessionID: parent.session.id, tool: "task",
      state: agent.completed ? {
        status: "completed", input: { description: agent.title, prompt: "Review the assigned clauses", subagent_type: "general" }, metadata: { sessionId: agent.id }, title: agent.title, output: "Review completed.", time: { start: now - 60_000, end: now - 30_000 },
      } : {
        status: "running", input: { description: agent.title, prompt: "Review the assigned clauses", subagent_type: "general" }, metadata: { sessionId: agent.id }, time: { start: now - 60_000 },
      },
    }));
    return { ...message, parts: [...tools, ...message.parts] };
  }) });
  seedQuestionState(workspace.id, "visual-reference", [{
    id: "reference-question", sessionID: "visual-reference", questions: [{
      header: "Reference version", question: "Which policy version should I use for the comparison?",
      options: [{ label: "Current policy", description: "Use the approved policy" }, { label: "Draft policy", description: "Compare against the latest draft" }],
    }],
  }]);
  seedPermissionState(workspace.id, "visual-board", [{
    id: "unrelated-approval", sessionID: "visual-board", permission: "bash", patterns: ["echo unrelated"], metadata: {}, always: [],
  }]);
  // Each workspace chat owns its reply handlers. Simulate the transport so
  // approvals still exercise those handlers when chats are split or moved.
  const originalFetch = globalThis.fetch.bind(globalThis);
  const requestIds = new Set(["approval-visual-research", "approval-visual-reference", "reference-question", "unrelated-approval"]);
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const reply = url.pathname.match(/^\/opencode\/(?:permission|question)\/([^/]+)\/reply$/);
    if (url.hostname === "legalwork-preview.invalid" && request.method === "POST" && reply && requestIds.has(reply[1]!)) {
      return Promise.resolve(Response.json(true));
    }
    return originalFetch(input, init);
  };
}

const explorerDashboard: ViewRecord = {
  version: 1, id: "11111111-1111-4111-8111-111111111111", title: "Matter overview", mode: "dashboard", catalog: "legalwork-1",
  owner: { kind: "workspace", id: workspace.id }, revision: "fixture-1", updatedAt: now, queries: {},
  program: 'root = Stack([Heading("Matter overview",1),Text("Synthetic project dashboard"),Stack([Metric("Open matters",12),Metric("Due this week",3)],2),Card("Priorities",[Table([{matter:"Supplier agreement",status:"In review"},{matter:"Office lease",status:"Ready"}],[{field:"matter",label:"Matter"},{field:"status",label:"Status"}])])])',
};
const explorerDashboardPath = `Dashboards/${explorerDashboard.id}.view.json`;
const explorerViews = new Map([[explorerDashboard.id, explorerDashboard]]);
function saveExplorerView(owner: ViewOwner, input: ViewInput, id = crypto.randomUUID()): ViewRecord {
  const view = { ...input, owner, id, revision: crypto.randomUUID(), updatedAt: Date.now() };
  explorerViews.set(id, view);
  if (owner.kind === "workspace") {
    const folder = input.mode === "dashboard" ? "Dashboards" : "Reports";
    if (!files.some(file => file.path === folder)) files.push({ name: folder, path: folder, kind: "dir", empty: false });
    const path = `${folder}/${id}.view.json`;
    if (!files.some(file => file.path === path)) files.push({ name: `${id}.view.json`, path, kind: "file", size: 850, updatedAt: view.updatedAt });
  }
  return view;
}
let files: LegalworkWorkspaceDirectoryEntry[] = [
  { name: "Contracts", path: "Contracts", kind: "dir" },
  { name: "Policies", path: "Policies", kind: "dir" },
  { name: "Board materials", path: "Board materials", kind: "dir" },
  { name: "review-notes.md", path: "review-notes.md", kind: "file", size: 4820, updatedAt: now },
  { name: "Supplier agreement.docx", path: "Supplier agreement.docx", kind: "file", size: 28450, updatedAt: now },
  { name: "Due diligence checklist.xlsx", path: "Due diligence checklist.xlsx", kind: "file", size: 18200, updatedAt: now },
  { name: "Annual report.pdf", path: "Annual report.pdf", kind: "file", size: 2480000, updatedAt: now },
  { name: ".workspace.json", path: ".workspace.json", kind: "file", size: 320, updatedAt: now },
];
if (dashboardExplorer) files.unshift(
  { name: "Dashboards", path: "Dashboards", kind: "dir", empty: false },
  { name: `${explorerDashboard.id}.view.json`, path: explorerDashboardPath, kind: "file", size: 850, updatedAt: now },
);
const memoryFiles: LegalMemoryTreeFile[] = files.filter((file) => file.kind === "file" && !file.name.startsWith(".")).map((file) => ({
  source_object_id: file.path, source_id: "visual-drive", name: file.name, path: file.path,
  mime_type: null, size_bytes: file.size ?? null, mtime: new Date(now).toISOString(), document_id: file.path,
}));
if (new URLSearchParams(window.location.search).get("memory") === "large") {
  memoryFiles.push(...Array.from({ length: 196 }, (_, index) => ({ source_object_id: `synthetic-${index}`, source_id: "visual-drive", name: `Synthetic file ${String(index + 1).padStart(3, "0")}.pdf`, path: `Synthetic file ${index + 1}.pdf`, mime_type: "application/pdf", size_bytes: 1000, mtime: new Date(now).toISOString(), document_id: `synthetic-${index}` })));
}
const previewNotice = () => { toast("Visual preview", { description: "This action needs the running desktop app or a connected service." }); };

// `?plans=new|signed-out|ended|no-models|onboarding` lays the plan screen over
// the session. Sign-in and upgrades are simulated: nothing leaves the page
// except a blank tab where the platform would open.
const PLAN_VARIANTS: AiPlansVariant[] = ["new", "signed-out", "ended", "no-models"];
const plansParam = new URLSearchParams(window.location.search).get("plans");
const initialPlans: { variant: AiPlansVariant; onboarding: boolean } | null =
  plansParam === "onboarding"
    ? { variant: "new", onboarding: true }
    : PLAN_VARIANTS.includes(plansParam as AiPlansVariant)
      ? { variant: plansParam as AiPlansVariant, onboarding: false }
      : null;
const previewAccount = { email: "anna.berg@kanzlei-berg.de", firmName: "Kanzlei Berg" };
const previewDelay = (ms: number, cancelled: () => boolean) =>
  new Promise<boolean>((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (cancelled()) resolve(false);
      else if (Date.now() - started >= ms) resolve(true);
      else window.setTimeout(tick, 200);
    };
    tick();
  });

function PlansPreview() {
  const [plans, setPlans] = useState(initialPlans);
  const [providersOpen, setProvidersOpen] = useState(previewParams.get("connect") === "openai");
  const upgradeChecks = useRef(0);
  if (!plans) return null;
  const close = () => window.setTimeout(() => setPlans(null), 1_200);
  return (
    <>
      <AiPlansOverlay
        mode={plans.onboarding ? "onboarding" : "gate"}
        variant={plans.variant}
        account={plans.variant === "new" ? null : previewAccount}
        serverReady
        onStartSignIn={async () => ({ authorizeUrl: "about:blank", sessionId: "preview" })}
        onWaitSignIn={async (_sessionId, opts) => {
          const done = await previewDelay(8_000, opts.cancelled);
          return done ? { connected: true } : { connected: false, cancelled: true };
        }}
        onSignedIn={close}
        onBringOwnModel={() => setProvidersOpen(true)}
        onOpenBilling={previewNotice}
        onCheckModels={async () => {
          // The third check finds the upgraded plan.
          upgradeChecks.current += 1;
          if (upgradeChecks.current < 3) return false;
          close();
          return true;
        }}
        onUseOtherAccount={async () => setPlans({ ...plans, variant: "new" })}
        onBack={plans.onboarding ? previewNotice : undefined}
        onOpenUpdates={previewNotice}
      />
      {providersOpen ? (
        <ProviderAuthModal
          open
          allowChatGptSubscription={limitPlan !== null}
          loading={false}
          submitting={false}
          error={null}
          preferredProviderId={previewParams.get("connect") === "openai" ? "openai" : undefined}
          providers={[
            { id: "openai", name: "OpenAI", env: [] },
            { id: "anthropic", name: "Anthropic", env: [] },
            { id: "mistral", name: "Mistral", env: [] },
          ]}
          connectedProviderIds={[]}
          authMethods={{
            openai: [{ type: "oauth", label: "ChatGPT Plus/Pro (browser)", methodIndex: 0 }, { type: "api", label: "API key", methodIndex: 1 }],
            anthropic: [{ type: "api", label: "API key" }],
            mistral: [{ type: "api", label: "API key" }],
          }}
          onSelect={async (providerId, methodIndex) => {
            throw new Error(`Preview only: ${providerId} sign-in method ${methodIndex} selected. No account is connected.`);
          }}
          onSubmitApiKey={async () => {
            // A connected provider makes a model usable: the plan screen goes.
            setProvidersOpen(false);
            setPlans(null);
          }}
          onSubmitCustomProvider={async () => {
            setProvidersOpen(false);
            setPlans(null);
          }}
          onSubmitOAuth={async () => ({ connected: false })}
          onClose={() => setProvidersOpen(false)}
        />
      ) : null}
    </>
  );
}

// Unimplemented operations point only at the reserved .invalid domain. No
// existing server connection or provider credential is used by this fixture.
const previewReview = SavedReviewSchema.parse({
  id: "11111111-1111-4111-8111-111111111111", name: "Supplier terms", revision: 1, createdAt: now, updatedAt: now,
  settings: { mode: "llm", jev: null, llm: { providerId: model.providerID, model: model.modelID } }, status: "draft", runId: null,
  columns: [{ key: "notice", kind: "text", label: "Notice period", question: "What notice is required?" }],
  documents: [{ id: "memo", name: "review-notes.md", path: "review-notes.md", status: "ready", sourceHash: null }], cells: [],
});
const previewTask: LegalworkTask = {
    id: "visual-task", projectId: workspace.id, origin: "desktop", title: "Review supplier notice", description: "Check the notice period against the playbook.",
    status: "open", priority: 2, tags: [], dueDate: null, assigneeUserId: null, assigneeName: null, createdByUserId: null,
    endpointId: null, endpointName: null, submissionId: null, assignmentNote: null, workflowHubItemId: null, workflowVersion: null,
    cloudRunId: null, lastLocalRunAt: null, attachments: previewParams.has("attachment-review") ? [{ id: "fixture-docx", filename: "Attachment review.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 4820, cached: true }] : [], createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    deletedAt: null, sync: { orgId: null, syncedAt: null, pending: false, error: null }, sessions: [], createdSession: null,
  };
const previewTasks = new Map([[previewTask.id, previewTask]]);
// Synthetic documents are shared only by preview windows on this dev origin.
function previewFile(path: string): { content: string; updatedAt: number } {
  const saved = localStorage.getItem(`legalwork:synthetic-file:${path}`);
  return saved ? JSON.parse(saved) : { content: `# Review notes\n\n${reply}`, updatedAt: now };
}
const fixtureClient: LegalworkServerClient = {
  ...createLegalworkServerClient({ baseUrl: "https://legalwork-preview.invalid", token: "visual-fixture" }),
  ...(dashboardExplorer ? {
    listWorkspaces: async () => ({ items: fixtureWorkspaces }),
    listWikis: async () => ({ items: [fixtureWiki] }),
    wikiContributions: async () => ({ items: [], unavailableProjects: [] }),
    wikiSnapshot: async () => ({ wiki: fixtureWiki, pages: [], assets: [], folders: ["Dashboards"], warnings: [] }),
    listViews: async (owner: ViewOwner) => ({ items: [...explorerViews.values()].filter(view => sameViewOwner(view.owner, owner)).map(view => ({ ...view, path: `${view.mode === "dashboard" ? "Dashboards" : "Reports"}/${view.id}.view.json` })), issues: [] }),
    readView: async (owner: ViewOwner, id: string) => { const view = explorerViews.get(id); if (!view || !sameViewOwner(view.owner, owner)) throw new LegalworkServerError(404, "view_not_found", "Synthetic dashboard not found"); return view; },
    createView: async (owner: ViewOwner, input: ViewInput) => saveExplorerView(owner, input),
    updateView: async (owner: ViewOwner, id: string, change: { baseRevision: string; input: ViewInput }) => {
      if (explorerViews.get(id)?.revision !== change.baseRevision) throw new LegalworkServerError(409, "view_revision_conflict", "Synthetic dashboard changed on disk");
      return saveExplorerView(owner, change.input, id);
    },
  } : {}),
  reviewLibrary: async (_workspaceId, language) => ({ entries: [{
    id: "11111111-1111-4111-8111-111111111112", kind: "set", version: 1,
    name: "Supplier terms", description: "Compare notice requirements across supplier agreements.",
    tags: [], language, source: "builtin", columns: previewReview.columns, updatedAt: now,
  }] }),
  getReview: async (_workspaceId, id) => ({ ...previewReview, id }),
  listReviews: async () => ({ reviews: [{ ...previewReview, documents: previewReview.documents.length, columns: previewReview.columns.length, total: previewReview.documents.length * previewReview.columns.length, completed: previewReview.cells.length }] }),
  queryReviewRows: async () => ({ revision: previewReview.revision, documentIds: previewReview.documents.map(document => document.id) }),
  editReview: async (_workspaceId, _id, input) => {
    previewReview.documents = (input.files ?? previewReview.documents.map(document => document.path)).map(path =>
      previewReview.documents.find(document => document.path === path) ?? { id: path, name: path.split("/").at(-1) ?? path, path, status: "ready", sourceHash: null, completedPages: 0, pageCount: 0, error: null });
    previewReview.revision++;
    return { ...previewReview };
  },
  getReviewSession: async () => ({ sessionId: null }),
  openReviewSession: async () => ({ sessionId: "visual-contract", prefill: true }),
  listTaskMembers: async () => ({ members: [] }), listTaskTags: async () => ({ tags: [] }),
  getTask: async (_workspaceId, id) => ({ task: previewTasks.get(id) ?? previewTask, submission: null, notes: [], conflicts: [] }),
  listTasks: async () => ({ tasks: [...previewTasks.values()], nextCursor: null }),
  createTask: async (_workspaceId, input) => {
    const task: LegalworkTask = { ...previewTask, ...input, id: crypto.randomUUID() };
    previewTasks.set(task.id, task); return { ok: true, task };
  },
  downloadTaskAttachment: async () => ({ data: await fetch(new URL("../scripts/fixtures/legal-review.docx", import.meta.url)).then(response => response.arrayBuffer()), filename: "Attachment review.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
  listTaskEndpoints: async () => ({ endpoints: [] }),
  taskSyncStatus: async () => ({ connected: false, orgId: null, accountUserId: null, pending: 0, lastSyncAt: null, error: null, signedOut: false }),
  getProjectDetails: async () => ({ version: 1, revision: 1, fields: [] }),
  calendarOccurrences: async () => ({ occurrences: [] }),
  calendarItems: async () => ({ items: [], conflicts: [] }),
  calendarSubscription: async () => ({ available: false, url: null, lastSyncedAt: null }),
  sessionMessageQueue: async (workspaceId, sessionId) => ({ workspaceId, sessionId, revision: 0, paused: false, entries: [], completedIds: [] }),

  eigenweltEntitlements: async () => limitFixture.entitlements,
  eigenweltUsage: async () => {
    if (failNextUsageRead) { failNextUsageRead = false; throw new Error("Simulated usage refresh failure"); }
    return limitFixture.usage;
  },
  eigenweltUsageAction: async (_workspaceId, action) => {
    if (trialPreview && action.action === "trialSubscription") {
      const quoteId = "215d5d04-97a9-431e-9ae7-67112023a0d4";
      if (action.preview) return { quoteId, recurringAmountCents: previewParams.has("annual") ? limitPlan === "pro" ? 82800 : 34800 : limitPlan === "pro" ? 8900 : 3900, seatCount: 1, amountCents: previewParams.has("annual") ? limitPlan === "pro" ? 98532 : 41412 : limitPlan === "pro" ? 10591 : 4641, billingInterval: limitFixture.usage.billingInterval };
      const allowance = limitPlan === "pro" ? 7000 : 3000;
      const me = { ...limitFixture.usage.me, allowanceCents: allowance, remainingCents: allowance, availableMicros: allowance*10_000, blockedReason: null };
      limitFixture.usage = { ...limitFixture.usage, trial: null, me, members: [me] };
      return { status: "paid", quoteId };
    }
    if (intentPreview && (action.action === "increaseLimit" || action.action === "enableExtraUsage")) {
      const previous = limitFixture.usage;
      const personal = action.action === "increaseLimit" && action.scope === "personal";
      const organization = action.action === "increaseLimit" && action.scope === "organization";
      const me = { ...previous.me,
        baseExtraLimitCents: personal ? action.limitCents : previous.me.baseExtraLimitCents,
        extraLimitCents: personal ? action.limitCents : previous.me.extraLimitCents,
        inheritsLimit: personal ? false : previous.me.inheritsLimit,
      };
      const orgLimit = organization ? action.limitCents : previous.orgExtraLimitCents;
      const wallet = previewParams.get("intentRecovery") === "blocked" ? 0 : previous.walletCents ?? 0;
      me.extraRemainingCents = Math.max(0, Math.min(me.extraLimitCents - me.extraUsedCents, orgLimit === null ? Infinity : orgLimit - (previous.orgExtraUsedCents ?? 0), wallet));
      me.availableMicros = (me.remainingCents + me.extraRemainingCents) * 10_000;
      me.blockedReason = me.extraRemainingCents > 0 ? null : "wallet_empty";
      limitFixture.usage = { ...previous, me, members: [me], orgExtraLimitCents: orgLimit, walletCents: wallet,
        extraEnabled: action.action === "enableExtraUsage" || previous.extraEnabled };
      failNextUsageRead = previewParams.get("intentRecovery") === "refresh-failed";
      return { ok: true };
    }
    if (action.action === "paymentDetails") {
      if (topUpPending && Date.now() >= topUpReadyAt) {
        const me = { ...limitFixture.usage.me,
          extraRemainingCents: topUpPreview === "blocked" ? 0 : topUpPending.amountCents,
          blockedReason: topUpPreview === "blocked" ? "member_limit" : null,
        };
        limitFixture.usage = { ...limitFixture.usage, me: { ...me, extraLimitCents: topUpPending.amountCents }, members: [me], extraEnabled: true, walletCents: topUpPending.amountCents };
        topUpPending = null;
      }
      return {
        card: { id: "visual-card", brand: "visa", last4: "4242", expMonth: 9, expYear: 2027 },
        pendingTopUps: topUpPending ? [topUpPending] : [],
      };
    }
    // Explicit dev-only simulation. No payment service, account, or credentials are used.
    if (action.action === "topUp" && topUpPreview) {
      topUpPending = { operationId: action.operationId, amountCents: action.amountCents };
      topUpReadyAt = Date.now() + (topUpPreview === "delayed" ? 10_000 : 0);
      failNextUsageRead = topUpPreview === "refresh-failed";
      return { status: "paid", operationId: action.operationId };
    }
    if (action.action === "memberChange" && action.preview) return {
      quoteId: "visual-quote", amountCents: 1500, recurringAmountCents: 12800, billingInterval: "month",
      paymentMethodRequired: previewParams.has("no-card"),
    };
    if (action.action === "cancelMemberChange" && upgradePreview) {
      hostedUpgrade = null;
      return { status: "canceled", quoteId: action.quoteId };
    }
    if (action.action === "resumeMemberChange" && hostedUpgrade && Date.now() < hostedUpgrade.readyAt)
      return { status: "processing", quoteId: action.quoteId };
    if (action.action === "memberChange" && action.hostedPayment && action.target.kind === "plan" &&
        (action.target.plan === "plus" || action.target.plan === "pro")) {
      // Offline simulation of an in-progress invoice payment. It never opens Stripe.
      hostedUpgrade = { plan: action.target.plan, readyAt: Date.now() + (upgradePreview === "payment-pending" ? Infinity : 15_000) };
      return { status: "processing", quoteId: "visual-quote" };
    }
    if (action.action === "memberChange" && !action.preview && upgradePreview && action.target.kind === "plan" && action.target.plan !== "none") {
      const used = limitFixture.usage.me.allowanceCents - limitFixture.usage.me.remainingCents;
      const updated = usageLimitFixture(action.target.plan, true, model.providerID);
      const remaining = upgradePreview === "blocked" ? 0 : Math.max(0, updated.usage.me.allowanceCents - used);
      updated.usage.me.remainingCents = remaining;
      updated.usage.me.blockedReason = remaining > 0 ? null : "wallet_empty";
      if (updated.entitlements.entitlements) {
        updated.entitlements.entitlements.usage.remainingCents = remaining;
        updated.entitlements.entitlements.usage.dailyRemainingCents = remaining;
      }
      limitFixture.usage = updated.usage;
      limitFixture.entitlements = updated.entitlements;
      failNextUsageRead = upgradePreview === "refresh-failed";
      return { ok: true };
    }
    if (action.action === "resumeMemberChange" && hostedUpgrade) {
      const updated = usageLimitFixture(hostedUpgrade.plan, true, model.providerID);
      limitFixture.usage = updated.usage;
      limitFixture.entitlements = updated.entitlements;
      hostedUpgrade = null;
      return { ok: true };
    }
    throw new Error("Billing changes and payments are disabled in this visual preview.");
  },
  getSessionSnapshot: async (_workspaceId, sessionId) => {
    const item = snapshots.get(sessionId);
    if (!item) throw new Error("Unknown preview session");
    return { item };
  },
  getConfig: async () => ({ opencode: {}, legalwork: {} }),
  getVoiceRealtimeCapability: async () => ({ supported: false, providerId: null, model: null, reason: "Voice is unavailable in the visual fixture." }),
  getUserEnvStatus: async () => ({ runtimeKey: "visual-fixture", pendingChanges: false }),
  listUserEnv: async () => ({ items: [] }),
  listSkills: async () => ({ items: [], skipped: [] }),
  listMcp: async () => ({ items: [] }),
  resolveArtifacts: async () => ({ items: [] }),
  searchContents: async (_workspaceId, kind, query) => ({ items: kind === "files" ? files.filter(file => file.kind === "file" && file.name.toLowerCase().includes(query.toLowerCase())).map(file => ({ kind, id: file.path, workspaceId: workspace.id, title: file.name, path: file.path, excerpt: "Synthetic project file", updatedAt: now })) : [] }),
  applyWorkspaceFileOperations: async (_workspaceId, operations) => operations.map(operation => {
    if (operation.type === "mkdir") files = [...files, { path: operation.path, name: operation.path.split("/").at(-1)!, kind: "dir" }];
    else if (operation.type === "rename") {
      if (files.some(file => file.path === operation.to)) return { ok: false, message: "A synthetic file already has that name." };
      files = files.map(file => file.path === operation.from ? { ...file, path: operation.to, name: operation.to.split("/").at(-1)! } : file);
    } else files = files.filter(file => file.path !== operation.path);
    return { ok: true };
  }),
  projectFileLinks: async (id) => ({ links: JSON.parse(localStorage.getItem(`legalwork:synthetic-links:${id}`) ?? "[]") }),
  updateProjectFileLink: async (id, input) => {
    const links: ProjectFileLink[] = JSON.parse(localStorage.getItem(`legalwork:synthetic-links:${id}`) ?? "[]");
    const next = "remove" in input ? links.filter(link => link.id !== input.id) : [...links.filter(link => link.id !== input.id), { ...input, id: input.id ?? crypto.randomUUID(), createdAt: Date.now() }];
    localStorage.setItem(`legalwork:synthetic-links:${id}`, JSON.stringify(next));
    return { links: next };
  },
  importProjectFile: async (_id, path, _source, data) => {
    await previewCopyDelay();
    if (files.some(file => file.path === path)) throw new LegalworkServerError(409, "file_exists", "A synthetic file already has that name.");
    const updatedAt = Date.now();
    files.push({ name: path.split("/").at(-1)!, path, kind: "file", size: data.byteLength });
    localStorage.setItem(`legalwork:synthetic-file:${path}`, JSON.stringify({ content: new TextDecoder().decode(data), updatedAt }));
    return { ok: true, path, bytes: data.byteLength, updatedAt };
  },
  listWorkspaceDirectory: async (_workspaceId, path) => ({
    path, entries: files.filter(file => file.path.slice(0, Math.max(0, file.path.lastIndexOf("/"))) === path), truncated: false,
  }),
  readWorkspaceFile: async (_workspaceId, path) => ({ path, ...previewFile(path), bytes: previewFile(path).content.length }),
  writeWorkspaceFile: async (_workspaceId, payload) => {
    const previous = previewFile(payload.path);
    if (payload.baseContent !== undefined && payload.baseContent !== previous.content) throw new LegalworkServerError(409, "conflict", "Synthetic file changed in another window.");
    const saved = { content: payload.content, updatedAt: Date.now() };
    localStorage.setItem(`legalwork:synthetic-file:${payload.path}`, JSON.stringify(saved));
    return { ok: true, path: payload.path, bytes: payload.content.length, ...saved };
  },
  downloadWorkspaceFile: async (_workspaceId, path) => {
    if (path.endsWith(".pdf")) return { data: await fetch(new URL("../scripts/fixtures/workspace-preview.pdf", import.meta.url)).then(response => response.arrayBuffer()), contentType: "application/pdf", filename: path, updatedAt: now };
    if (path.endsWith(".md")) return { data: await new Blob([previewFile(path).content]).arrayBuffer(), contentType: "text/markdown", filename: path, updatedAt: previewFile(path).updatedAt };
    if (!path.endsWith(".docx")) throw new Error("Open review-notes.md or a DOCX to inspect the synthetic document panel.");
    const saved = localStorage.getItem(`legalwork:synthetic-binary:${path}`);
    const fixture = saved ? JSON.parse(saved) : null;
    const data = fixture ? Uint8Array.from(atob(fixture.data), character => character.charCodeAt(0)).buffer : await fetch(new URL("../scripts/fixtures/legal-review.docx", import.meta.url)).then(response => response.arrayBuffer());
    return { data, contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: path, updatedAt: fixture?.updatedAt ?? now };
  },
  statWorkspaceFile: async (_workspaceId, path) => ({ ok: true, path, exists: true, kind: "file", size: 4820, updatedAt: path.endsWith(".docx") ? JSON.parse(localStorage.getItem(`legalwork:synthetic-binary:${path}`) ?? "null")?.updatedAt ?? now : previewFile(path).updatedAt, fileId: `synthetic:${path}` }),
  writeWorkspaceBinaryFile: async (_workspaceId, payload) => {
    if (previewParams.has("review-checks")) await new Promise(resolve => setTimeout(resolve, Number(previewParams.get("save-delay") ?? 2500)));
    const updatedAt = Date.now();
    localStorage.setItem(`legalwork:synthetic-binary:${payload.path}`, JSON.stringify({ data: btoa(Array.from(new Uint8Array(payload.data), byte => String.fromCharCode(byte)).join("")), updatedAt }));
    return { ok: true, path: payload.path, bytes: payload.data.byteLength, updatedAt };
  },
  storageRoots: async () => ({ roots: [{ id: "visual-cloud", name: "Northstar cloud files", kind: "s3", writable: true }] }),
  storageChildren: async () => ({ entries: [{ name: "Cloud review.md", path: "Cloud review.md", kind: "file", size: 4820, modifiedAt: null }] }),
  checkoutStorageFile: async () => ({ localPath: ".legalwork/storage/Cloud review.md", contentType: "text/markdown", version: "1", size: 4820, updatedAt: now, writable: true, localWritable: true }),
  legalMemoryTreeRoots: async () => ({ roots: [{ source_id: "visual-drive", display_name: "Northstar shared drive", kind: "gdrive", project_id: null, status: "ready", files: memoryFiles.length }] }),
  legalMemoryTreeChildren: async (_workspaceId, payload) => ({
    source_id: payload.source_id, path: payload.path ?? "", folders: [], files: memoryFiles,
    pagination: { total: memoryFiles.length, offset: 0, limit: 200, returned: memoryFiles.length, has_more: false },
  }),
  legalMemoryTreeSearch: async (_workspaceId, payload) => ({ files: memoryFiles.filter((file) => file.name.toLowerCase().includes(payload.query.toLowerCase())) }),
  legalMemoryOpen: async (_workspaceId, payload) => {
    if (!payload.document_id.endsWith(".md")) throw new Error("Open review-notes.md to inspect the preview document.");
    return { ok: true, path: payload.document_id, bytes: reply.length, mimeType: "text/markdown" };
  },
};

function SessionPreview() {
  // Repaint on language change, the way AppRoot does in the real app.
  useLocale();
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(window.location.hash.includes("view=workspace") ? null : subagentApprovals ? "visual-review" : limitParam ? "visual-limit" : emptyChatId ?? welcomeId);
  const [activeWorkspace, setActiveWorkspace] = useState(workspace);
  const location = useLocation();
  const navigate = useNavigate();
  const projectPage = projectViewFromPath(location.pathname);
  const [revision, setRevision] = useState(0);
  const [projectOrder, setProjectOrder] = useState([workspace.id, otherWorkspace.id]);
  const [showWorkflows, setShowWorkflows] = useState(new URLSearchParams(window.location.search).has("workflows"));
  useEffect(() => {
    const projectRoute = location.pathname.match(/^\/(?:workspace|wikis)\/([^/]+)/);
    const routedWorkspace = projectRoute && fixtureWorkspaces.find(item => item.id === decodeURIComponent(projectRoute[1]));
    if (routedWorkspace) setActiveWorkspace(routedWorkspace);
    if (location.pathname.startsWith("/wikis/")) { setSelectedSessionId(null); setShowHome(false); setShowWorkflows(false); return; }
    if (location.pathname === "/home") { setShowHome(true); setShowWorkflows(false); return; }
    const route = location.pathname.match(/^\/workspace\/[^/]+\/session(?:\/([^/]+))?$/);
    if (projectPage) { setShowHome(false); setShowWorkflows(false); }
    if (!route) return;
    setSelectedSessionId(route[1] ? decodeURIComponent(route[1]) : null);
    setShowWorkflows(false); setShowHome(false);
  }, [location.pathname, location.search, location.key]);
  const [showHome, setShowHome] = useState(previewParams.has("home"));
  const [homeProject, setHomeProject] = useState<string | null>(workspace.id);
  const pendingHome = useRef<PendingHomeMessage>({ sessionId: null, uploads: new Map() });
  const failHome = useRef(previewParams.has("home-fail"));
  const groups: WorkspaceSessionGroup[] = [
    { workspace, status: "ready", sessions: Array.from(snapshots.values()).map((item) => item.session).filter(session => session.directory !== otherWorkspace.path) },
    { workspace: otherWorkspace, status: "ready", sessions: Array.from(snapshots.values()).map(item => item.session).filter(session => session.directory === otherWorkspace.path) },
  ];
  const newTask = (projectId = activeWorkspace.id) => {
    const id = `visual-new-${crypto.randomUUID()}`;
    registerEmptySession(id);
    queryClient.setQueryData(transcriptKey(projectId, id), []);
    const created = snapshot(id, "New task");
    const owner = projectId === workspace.id ? workspace : otherWorkspace;
    saveSnapshot({ ...created, session: { ...created.session, directory: owner.path } });
    navigate(`/workspace/${projectId}/session/${id}`);
    setSelectedSessionId(id);
    setRevision((value) => value + 1);
    return id;
  };
  const sendDraft = (draft: ComposerDraft, sessionId: string) => {
    const previous = snapshots.get(sessionId);
    const next = snapshot(sessionId, draft.resolvedText.slice(0, 44) || "Sample review", draft.resolvedText);
    next.session.directory = previous?.session.directory ?? activeWorkspace.path;
    saveSnapshot({ ...next, messages: [...(previous?.messages ?? []), ...next.messages] });
    setRevision((value) => value + 1);
  };
  const openDashboardPreview = (mode: "new" | "edit" | "conflict" | "wiki") => {
    const callId = crypto.randomUUID();
    const id = viewGenerationId(fixtureClient.baseUrl, welcomeId, callId);
    const current = explorerViews.get(explorerDashboard.id)!;
    const generation: ViewGeneration = {
      serverUrl: fixtureClient.baseUrl, workspaceId: workspace.id, sessionId: welcomeId, toolCallId: callId,
      title: "Matter overview", program: current.program, status: "preview",
      preview: { status: "preview", owner: mode === "wiki" ? { kind: "wiki", id: "visual-wiki" } : current.owner,
        input: { ...viewInput(current), title: mode === "new" ? "New matter dashboard" : current.title },
        ...(mode === "edit" || mode === "conflict" ? { target: { viewId: current.id, baseRevision: mode === "conflict" ? "outdated" : current.revision } } : {}),
      },
    };
    useViewGenerationStore.getState().update(id, generation);
    requestPanelTab(viewDraftTab(id, generation), { kind: "workspace", workspaceId: workspace.id });
  };

  return (
    <div className="flex h-dvh flex-col" data-preview-revision={revision}>
      {platform === "windows" && <>
        {captionHeight === 64 && <style>{"html.legalwork-electron.legalwork-platform-windows .lw-window-frame { --lw-window-bar-height: 64px; }"}</style>}
        <div data-preview-caption-controls aria-hidden style={{ height: captionHeight }} className="fixed right-0 top-0 z-[2147483647] flex w-[138px] items-center justify-around bg-background text-foreground"><span>−</span><span>□</span><span>×</span></div>
      </>}
      <div className="shrink-0 border-b border-border bg-muted/40 px-4 py-1.5 text-center text-[11px] text-muted-foreground">
        Interactive visual preview · Sample data and simulated replies · No connected services
        {dashboardExplorer && <span className="ml-3 inline-flex gap-3">
          <button onClick={() => openDashboardPreview("new")}>New dashboard preview</button>
          <button onClick={() => openDashboardPreview("edit")}>Updated preview</button>
          <button onClick={() => openDashboardPreview("conflict")}>Conflicting preview</button>
          <button onClick={() => openDashboardPreview("wiki")}>Wiki preview</button>
        </span>}
        {previewParams.has("unified") && <span className="ml-3 inline-flex gap-3">
          <button onClick={() => requestPanelTab({ id: `review:${previewReview.id}`, type: "review", reviewId: previewReview.id, label: previewReview.name })}>Open sample review</button>
          <button onClick={() => requestPanelTab({ id: "task:visual-task", type: "task", taskId: "visual-task", label: "Review supplier notice" })}>Open sample task</button>
          <button onClick={() => setShowWorkflows(true)}>Open workflow library</button>
          <WorkspaceWindowButton workspaceId={workspace.id} openWindow={async (_id, _tab, mode) => { toast.success(mode === "empty" ? "Preview: empty workspace window" : "Preview: copied workspace window"); }} />
          <button onClick={() => {
            usePanelTabStore.getState().openTab(workspacePanelKey(otherWorkspace.id), projectFileTab({ projectId: workspace.id, workspaceId: workspace.id, path: "Annual report.pdf", name: "Annual report.pdf" }));
            navigate(`/workspace/${otherWorkspace.id}/session?view=workspace`);
          }}>Open cross-project PDF</button>
        </span>}
      </div>
      <div className="min-h-0 flex-1">
        <SessionPage
          projectsPage={location.pathname === "/projects"}
          projectPage={projectPage}
          projectTasksView={(embedded, inWorkspace) => <TasksPane embedded={embedded} client={fixtureClient} workspaceId={activeWorkspace.id} projectId={activeWorkspace.id} detailMode={inWorkspace ? "panel" : "inline"} onOpenInProject={(_projectId, task) => { usePanelTabStore.getState().openTab(workspacePanelKey(activeWorkspace.id), { id: `task:${task.id}`, type: "task", taskId: task.id, label: task.title }); navigate(`/workspace/${activeWorkspace.id}/session?view=workspace`); }} baseUrl={fixtureClient.baseUrl} token="visual-fixture" workspaces={[workspace, otherWorkspace]} defaultModel={model} onOpenSession={(_workspaceId, id) => setSelectedSessionId(id)} />}
          projectCalendarView={<CalendarView client={fixtureClient} workspaceId={activeWorkspace.id} projectId={activeWorkspace.id} projectName={activeWorkspace.name} />}
          homePage={showHome}
          workflowLibraryView={<WorkflowsPreview active={showWorkflows} workspaceId={activeWorkspace.id} reviewClient={fixtureClient} />}
          mainView={showHome ? <AppHome
            workspaces={[workspace, otherWorkspace]} projectId={homeProject}
            onProjectChange={(id) => { setHomeProject(id); pendingHome.current = { sessionId: null, uploads: new Map() }; }} onCreateProject={previewNotice}
            disabled={false} providerConnectedCount={1} onConnect={previewNotice}
            selectedModel={model} modelLocked onModelChange={() => {}}
            modelVariant={null} modelVariantLabel="Standard" modelBehaviorOptions={[]} onModelVariantChange={() => {}}
            onSend={async (text, attachments) => {
              const files = attachments.flatMap(({ source }) => source instanceof File ? [source] : []);
              const references = attachments.flatMap(({ source }) => source instanceof File ? [] : [source]);
              const delay = () => new Promise<void>((resolve) => window.setTimeout(resolve, Number(previewParams.get("home-delay") ?? 1_500)));
              const id = await submitHomeMessage({
                workspaceId: homeProject || workspace.id, text, files, references, attachments, pending: pendingHome.current,
                client: fixtureClient, referenceClient: fixtureClient,
                createSession: async () => { await delay(); return { id: "visual-home-chat" }; },
                sendPrompt: async (id, prompt) => {
                  await delay();
                  if (failHome.current) { failHome.current = false; throw new Error("Simulated connection failure. Please try again."); }
                  saveSnapshot(snapshot(id, text.slice(0, 44) || "File review", prompt));
                },
              });
              setSelectedSessionId(id);
              setShowHome(false);
            }}
          /> : showWorkflows ? <WorkflowsPreview reviewClient={fixtureClient} /> : undefined}
          selectedSessionId={selectedSessionId} selectedWorkspaceId={activeWorkspace.id} selectedWorkspaceDisplay={{ ...activeWorkspace, displayName: activeWorkspace.displayName ?? activeWorkspace.name }}
          selectedWorkspaceRoot={activeWorkspace.path} runtimeWorkspaceId={activeWorkspace.id} workspaces={fixtureWorkspaces}
          wikiWorkspace={activeWorkspace.id === wikiWorkspace.id ? fixtureWiki : undefined}
          wiki={dashboardExplorer ? { client: fixtureClient, serverUrl: fixtureClient.baseUrl, workspaceId: activeWorkspace.id, workspaces: fixtureWorkspaces, selectedWikiId: fixtureWiki.id, onOpenWiki: wiki => navigate(`/wikis/${wiki.workspaceId}`), onOpenWikiSession: async () => { previewNotice(); } } : undefined}
          clientConnected legalworkServerStatus="connected" legalworkServerClient={fixtureClient} environmentClient={fixtureClient}
          legalworkServerToken="visual-fixture" opencodeBaseUrl="https://legalwork-preview.invalid/opencode"
          developerMode={false} headerStatus="Ready" busyHint={null} startupPhase="ready" providerConnectedIds={[model.providerID]}
          mcpConnectedCount={0} onOpenSettings={previewNotice} onStartProjectRecording={previewNotice} todos={[]} sessionLoadingById={() => false}
          onCreateProjectSession={() => { newTask(); }}
          onArchiveSession={(id, archived) => {
            const item = snapshots.get(id);
            if (item) saveSnapshot({ ...item, session: { ...item.session, time: { ...item.session.time, archived: archived ? Date.now() : undefined } } });
            setRevision(value => value + 1);
          }}
          onOpenInteractionSession={setSelectedSessionId}
          onRenameSession={(id, title) => {
            const item = snapshots.get(id);
            if (item) saveSnapshot({ ...item, session: { ...item.session, title } });
            setRevision((value) => value + 1);
          }}
          sidebar={{
            workspaceSessionGroups: activeWorkspace.id === wikiWorkspace.id ? [{ workspace: wikiWorkspace, status: "ready", sessions: [] }] : projectOrder.flatMap(id => groups.filter(group => group.workspace.id === id)), onReorderWorkspaces: setProjectOrder, selectedWorkspaceId: activeWorkspace.id, selectedSessionId, developerMode: false,
            sessionStatusById: statusStatesById, connectingWorkspaceId: null, workspaceConnectionStateById: {}, newChatDisabled: false,
            sidebarHydratedFromCache: true, startupPhase: "ready", onSelectWorkspace: id => {
              setActiveWorkspace(id === workspace.id ? workspace : otherWorkspace);
              setSelectedSessionId(id === workspace.id ? welcomeId : null); setShowWorkflows(false);
            },
            onOpenSession: (workspaceId, id) => { setActiveWorkspace(workspaceId === workspace.id ? workspace : otherWorkspace); setShowWorkflows(false); setSelectedSessionId(id); navigate(workspaceSessionRoute(workspaceId, id)); }, onCreateChatInWorkspace: newTask,
            onOpenRenameWorkspace: previewNotice, onRevealWorkspace: previewNotice, onForgetWorkspace: previewNotice,
            onOpenCreateWorkspace: previewNotice, onCreateChatInNewWorkspace: previewNotice,
            onShowProjects: () => { setShowHome(false); setShowWorkflows(false); navigate("/projects"); },
            onShowChats: () => { setShowHome(true); setShowWorkflows(false); }, onShowEvals: previewNotice, onShowWorkflows: () => { setShowHome(false); setShowWorkflows(true); navigate("/workflows"); }, onShowExtensions: previewNotice, onShowRecorder: previewNotice,
            activeNav: showWorkflows ? "workflows" : activeWorkspace.id === wikiWorkspace.id ? "wikis" : null,
          }}
          surface={{
            workspaceRoot: activeWorkspace.path, developerMode: false, modelLabel: model.providerID === "eigenwelt" ? "LegalWork AI" : "ChatGPT", onModelClick: previewNotice,
            onChooseAiPlan: async plan => {
              if (!subscriptionPreview) { previewNotice(); return; }
              await new Promise<void>(resolve => window.setTimeout(resolve, 1_500));
              const updated = usageLimitFixture(plan, true, model.providerID);
              if (updated.entitlements.account) updated.entitlements.account.orgRole = "org:admin";
              limitFixture.entitlements = updated.entitlements;
              limitFixture.usage = updated.usage;
              queryClient.setQueryData(eigenweltEntitlementsQueryKey(), updated.entitlements);
            },
            modelPickerOpen: false, modelSelectorLocked: !previewParams.has("composer-layout") && !previewParams.has("review-checks"), selectedModel: model, onModelPickerOpenChange: () => {}, onModelChange: () => {},
            onSendDraft: sendDraft, onDraftChange: () => {}, attachmentsEnabled: false, attachmentsDisabledReason: "Use the connected app to upload files.",
            modelVariantLabel: "Standard", modelVariant: null, onModelVariantChange: () => {}, agentLabel: "Assistant", selectedAgent: null,
            modelBehaviorOptions: previewParams.has("composer-layout") ? [{ value: null, label: "Reasoning effort", isDefault: true }, { value: "high", label: "High" }] : [],
            listAgents: async () => [], onSelectAgent: () => {}, listCommands: async () => [],
            recentFiles: files.map((file) => file.path), searchFiles: async (query) => files.filter((file) => file.name.toLowerCase().includes(query.toLowerCase())).map((file) => file.path),
            isRemoteWorkspace: false, isSandboxWorkspace: false, providerConnectedCount: 1,
          }}
        />
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Preview root element not found");
const previewRoot = createRoot(root);
if (import.meta.hot) import.meta.hot.dispose(() => previewRoot.unmount());
previewRoot.render(
  <QueryClientProvider client={queryClient}>
    <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <LocalProvider>
          <ShellConfigProvider>
            <ReloadCoordinatorProvider>
              <WorkspaceProvider client={null} selectedWorkspaceRoot={workspace.path} workspaces={fixtureWorkspaces.map(item => ({ ...item, displayNameResolved: item.displayName ?? item.name }))} baseUrl="https://legalwork-preview.invalid" token="visual-fixture" opencodeBaseUrl="https://legalwork-preview.invalid/opencode" onOpenSession={previewNotice}>
                <MemoryRouter initialEntries={[window.location.hash.slice(1) || "/"]}>
                  <LegalworkControlProvider>
                    <ProjectFileImportContext value={async (_projectId, imported, folder) => { await previewCopyDelay(); return { files: await Promise.all(imported.map(async file => {
                      const path = folder ? `${folder}/${file.name}` : file.name;
                      if (files.some(entry => entry.path === path)) return { name: file.name, path, status: "already_here" };
                      files = [...files, { name: file.name, path, kind: "file", size: file.size }];
                      localStorage.setItem(`legalwork:synthetic-file:${path}`, JSON.stringify({ content: await file.text(), updatedAt: Date.now() }));
                      return { name: file.name, path, status: "copied" };
                    })) }; }}><SessionPreview /></ProjectFileImportContext>
                    <PlansPreview />
                    <Toaster /><DocumentDiscardDialog />
                  </LegalworkControlProvider>
                </MemoryRouter>
              </WorkspaceProvider>
            </ReloadCoordinatorProvider>
          </ShellConfigProvider>
        </LocalProvider>
      </TooltipProvider>
    </MotionConfig>
  </QueryClientProvider>,
);
