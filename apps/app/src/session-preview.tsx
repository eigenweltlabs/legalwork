/** @jsxImportSource react */
// Dev-only fixture: deliberately absent from the production Vite inputs.
// Uses the real session, composer, navigation, files, and Memory Drive views.
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";

import {
  createLegalworkServerClient,
  type LegalworkServerClient,
  type LegalworkSessionSnapshot,
  type LegalworkWorkspaceDirectoryEntry,
  type LegalMemoryTreeFile,
} from "@/app/lib/legalwork-server";
import type { WorkspaceInfo } from "@/app/lib/desktop";
import type { ComposerDraft, WorkspaceSessionGroup } from "@/app/types";
import { Toaster, toast } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { initLocale, setLocale } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { SessionPage } from "@/react-app/domains/session/chat/session-page";
import { ProviderAuthModal } from "@/react-app/domains/connections/provider-auth";
import { AiPlansOverlay } from "@/react-app/domains/onboarding/ai-plans-overlay";
import type { AiPlansVariant } from "@/app/lib/eigenwelt-access";
import { seedSessionState, snapshotKey, transcriptKey } from "@/react-app/domains/session/sync/session-sync";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { LocalProvider } from "@/react-app/kernel/local-provider";
import { ShellConfigProvider } from "@/react-app/shell/shell-config";
import { ReloadCoordinatorProvider } from "@/react-app/shell/reload-coordinator";
import { WorkspaceProvider } from "@/react-app/shell/workspace-provider";
import "./app/index.css";
import { WorkflowsPreview } from "./workflows-preview";
import { AppHome } from "@/react-app/domains/session/home/app-home";
import { submitHomeMessage, type PendingHomeMessage } from "@/react-app/domains/session/home/home-submission";
import { providerUsageLimitErrorText } from "@/app/lib/provider-usage-limit";
import { usageLimitFixture } from "@/react-app/design-system/usage-limit-fixture";

if (!import.meta.env.DEV) throw new Error("The session fixture is available only in development.");
initLocale();

const now = Date.now();
const previewParams = new URLSearchParams(window.location.search);
if (previewParams.has("lang")) setLocale(previewParams.get("lang") === "de" ? "de" : "en");
if (previewParams.has("theme")) document.documentElement.dataset.theme = previewParams.get("theme") === "dark" ? "dark" : "light";
const limitParam = previewParams.get("limit");
const limitPlan = limitParam === "sync" || limitParam === "plus" || limitParam === "pro" ? limitParam : null;
const model = { providerID: previewParams.get("provider") ?? "openai", modelID: "Preview model" };
const limitFixture = usageLimitFixture(limitPlan, previewParams.get("role") !== "member", model.providerID);
const upgradePreview = previewParams.get("upgrade");
const topUpPreview = previewParams.get("topup");
const intentPreview = previewParams.get("intent");
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
const welcomeId = "visual-welcome";
const reply = "I've reviewed the sample terms and organized the key points.\n\n### Review priorities\n\n1. **Liability:** confirm the agreed cap applies consistently.\n2. **Termination:** align the notice periods for both parties.\n3. **Data handling:** make the return and deletion process explicit.\n\nThe next step is to compare these points against your standard playbook. This is a simulated response for visual review.";
const snapshots = new Map<string, LegalworkSessionSnapshot>();
const queryClient = getReactQueryClient();
queryClient.setDefaultOptions({ queries: { retry: false, refetchOnWindowFocus: false } });

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
  queryClient.setQueryData(snapshotKey(workspace.id, item.session.id), item);
  seedSessionState(workspace.id, item);
}

saveSnapshot(snapshot(welcomeId, "New task"));
saveSnapshot(snapshot("visual-review", "Review supplier agreement", "Review the supplier agreement against our standard playbook and highlight the clauses that need attention."));
saveSnapshot(snapshot("visual-board", "Prepare board meeting notes", "Help me organize the open legal topics for next week's board meeting."));
saveSnapshot(snapshot("visual-policy", "Update the privacy policy", "Summarize the changes we need to make to the privacy policy."));
if (limitParam) {
  const item = snapshot("visual-limit", "Review supplier agreement", "Review the supplier agreement and highlight the clauses that need attention.");
  saveSnapshot({
    ...item,
    messages: item.messages.map(message => message.info.role === "assistant" ? {
      ...message, parts: [], info: { ...message.info, error: { name: "UnknownError", data: { message: providerUsageLimitErrorText(model.providerID) } } },
    } : message),
  });
  if (previewParams.has("continued")) {
    const previous = snapshots.get("visual-limit");
    const continued = snapshot("visual-limit", "Review supplier agreement", "Hallo?");
    saveSnapshot({ ...continued, messages: [...(previous?.messages ?? []), ...continued.messages] });
  }
}

const files: LegalworkWorkspaceDirectoryEntry[] = [
  { name: "Contracts", path: "Contracts", kind: "dir" },
  { name: "Policies", path: "Policies", kind: "dir" },
  { name: "Board materials", path: "Board materials", kind: "dir" },
  { name: "review-notes.md", path: "review-notes.md", kind: "file", size: 4820, updatedAt: now },
  { name: "Supplier agreement.docx", path: "Supplier agreement.docx", kind: "file", size: 28450, updatedAt: now },
  { name: "Due diligence checklist.xlsx", path: "Due diligence checklist.xlsx", kind: "file", size: 18200, updatedAt: now },
  { name: "Annual report.pdf", path: "Annual report.pdf", kind: "file", size: 2480000, updatedAt: now },
  { name: ".workspace.json", path: ".workspace.json", kind: "file", size: 320, updatedAt: now },
];
const memoryFiles: LegalMemoryTreeFile[] = files.filter((file) => file.kind === "file" && !file.name.startsWith(".")).map((file) => ({
  source_object_id: file.path, source_id: "visual-drive", name: file.name, path: file.path,
  mime_type: null, size_bytes: file.size ?? null, mtime: new Date(now).toISOString(), document_id: file.path,
}));
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
const fixtureClient: LegalworkServerClient = {
  ...createLegalworkServerClient({ baseUrl: "https://legalwork-preview.invalid", token: "visual-fixture" }),
  eigenweltEntitlements: async () => limitFixture.entitlements,
  eigenweltUsage: async () => {
    if (failNextUsageRead) { failNextUsageRead = false; throw new Error("Simulated usage refresh failure"); }
    return limitFixture.usage;
  },
  eigenweltUsageAction: async (_workspaceId, action) => {
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
        limitFixture.usage = { ...limitFixture.usage, me, members: [me], walletCents: topUpPending.amountCents };
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
  listWorkspaceDirectory: async (_workspaceId, path) => ({
    path, entries: path ? files.filter((file) => file.kind === "file").map((file) => ({ ...file, path: `${path}/${file.name}` })) : files, truncated: false,
  }),
  readWorkspaceFile: async (_workspaceId, path) => ({ path, content: `# Review notes\n\n${reply}`, bytes: reply.length, updatedAt: now }),
  downloadWorkspaceFile: async (_workspaceId, path) => {
    if (!path.endsWith(".md")) throw new Error("Binary documents are illustrative. Open review-notes.md to inspect the document panel.");
    return { data: await new Blob([`# Review notes\n\n${reply}`]).arrayBuffer(), contentType: "text/markdown", filename: "review-notes.md", updatedAt: now };
  },
  statWorkspaceFile: async (_workspaceId, path) => ({ ok: true, path, exists: true, kind: "file", size: 4820, updatedAt: now }),
  writeWorkspaceBinaryFile: async (_workspaceId, payload) => ({ ok: true, path: payload.path, bytes: payload.data.byteLength, updatedAt: now }),
  storageRoots: async () => ({ roots: [{ id: "visual-cloud", name: "Northstar cloud files", kind: "s3", writable: true }] }),
  storageChildren: async () => ({ entries: [{ name: "Cloud review.md", path: "Cloud review.md", kind: "file", size: 4820, modifiedAt: null }], nextCursor: null }),
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
  const [selectedSessionId, setSelectedSessionId] = useState(limitParam ? "visual-limit" : welcomeId);
  const [revision, setRevision] = useState(0);
  const [showWorkflows, setShowWorkflows] = useState(new URLSearchParams(window.location.search).has("workflows"));
  const [showHome, setShowHome] = useState(previewParams.has("home"));
  const [homeProject, setHomeProject] = useState<string | null>(workspace.id);
  const pendingHome = useRef<PendingHomeMessage>({ sessionId: null, uploads: new Map() });
  const failHome = useRef(previewParams.has("home-fail"));
  const groups: WorkspaceSessionGroup[] = [
    { workspace, status: "ready", sessions: Array.from(snapshots.values()).map((item) => item.session) },
    { workspace: otherWorkspace, status: "ready", sessions: [] },
  ];
  const newTask = () => {
    queryClient.setQueryData(transcriptKey(workspace.id, welcomeId), []);
    saveSnapshot(snapshot(welcomeId, "New task"));
    setSelectedSessionId(welcomeId);
    setRevision((value) => value + 1);
  };
  const sendDraft = (draft: ComposerDraft, sessionId: string) => {
    const previous = snapshots.get(sessionId);
    const next = snapshot(sessionId, draft.text.slice(0, 44) || "Sample review", draft.text);
    saveSnapshot({ ...next, messages: [...(previous?.messages ?? []), ...next.messages] });
    setRevision((value) => value + 1);
  };

  return (
    <div className="flex h-dvh flex-col" data-preview-revision={revision}>
      <div className="shrink-0 border-b border-border bg-muted/40 px-4 py-1.5 text-center text-[11px] text-muted-foreground">
        Interactive visual preview · Sample data and simulated replies · No connected services
      </div>
      <div className="min-h-0 flex-1">
        <SessionPage
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
          /> : showWorkflows ? <WorkflowsPreview /> : undefined}
          selectedSessionId={selectedSessionId} selectedWorkspaceId={workspace.id} selectedWorkspaceDisplay={{ ...workspace, displayName: "Northstar Legal" }}
          selectedWorkspaceRoot={workspace.path} runtimeWorkspaceId={workspace.id} workspaces={[workspace, otherWorkspace]}
          clientConnected legalworkServerStatus="connected" legalworkServerClient={fixtureClient}
          legalworkServerToken="visual-fixture" opencodeBaseUrl="https://legalwork-preview.invalid/opencode"
          developerMode={false} headerStatus="Ready" busyHint={null} startupPhase="ready" providerConnectedIds={[model.providerID]}
          mcpConnectedCount={0} onOpenSettings={previewNotice} onStartProjectRecording={previewNotice} todos={[]} sessionLoadingById={() => false}
          onRenameSession={(id, title) => {
            const item = snapshots.get(id);
            if (item) saveSnapshot({ ...item, session: { ...item.session, title } });
            setRevision((value) => value + 1);
          }}
          sidebar={{
            workspaceSessionGroups: groups, selectedWorkspaceId: workspace.id, selectedSessionId, developerMode: false,
            sessionStatusById: {}, connectingWorkspaceId: null, workspaceConnectionStateById: {}, newChatDisabled: false,
            sidebarHydratedFromCache: true, startupPhase: "ready", onSelectWorkspace: previewNotice,
            onOpenSession: (_workspaceId, id) => { setShowWorkflows(false); setSelectedSessionId(id); }, onCreateChatInWorkspace: newTask,
            onOpenRenameWorkspace: previewNotice, onRevealWorkspace: previewNotice, onForgetWorkspace: previewNotice,
            onOpenCreateWorkspace: previewNotice, onCreateChatInNewWorkspace: previewNotice,
            onShowEvals: previewNotice, onShowWorkflows: () => setShowWorkflows(true), onShowExtensions: previewNotice, onShowRecorder: previewNotice,
            activeNav: showWorkflows ? "workflows" : null,
          }}
          surface={{
            workspaceRoot: workspace.path, developerMode: false, modelLabel: model.providerID === "eigenwelt" ? "LegalWork AI" : "ChatGPT", onModelClick: previewNotice,
            onChooseAiPlan: async () => previewNotice(),
            modelPickerOpen: false, modelSelectorLocked: true, selectedModel: model, onModelPickerOpenChange: () => {}, onModelChange: () => {},
            onSendDraft: sendDraft, onDraftChange: () => {}, attachmentsEnabled: false, attachmentsDisabledReason: "Use the connected app to upload files.",
            modelVariantLabel: "Standard", modelVariant: null, onModelVariantChange: () => {}, agentLabel: "Assistant", selectedAgent: null,
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
createRoot(root).render(
  <QueryClientProvider client={queryClient}>
    <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <LocalProvider>
          <ShellConfigProvider>
            <ReloadCoordinatorProvider>
              <WorkspaceProvider client={null} selectedWorkspaceRoot={workspace.path}>
                <MemoryRouter>
                  <SessionPreview />
                  <PlansPreview />
                  <Toaster />
                </MemoryRouter>
              </WorkspaceProvider>
            </ReloadCoordinatorProvider>
          </ShellConfigProvider>
        </LocalProvider>
      </TooltipProvider>
    </MotionConfig>
  </QueryClientProvider>,
);
