/** @jsxImportSource react */
// Dev-only fixture: deliberately absent from the production Vite inputs.
// Uses the real session, composer, navigation, files, and Memory Drive views.
import { useState } from "react";
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
import { initLocale } from "@/i18n";
import { SessionPage } from "@/react-app/domains/session/chat/session-page";
import { seedSessionState, snapshotKey, transcriptKey } from "@/react-app/domains/session/sync/session-sync";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { LocalProvider } from "@/react-app/kernel/local-provider";
import { ShellConfigProvider } from "@/react-app/shell/shell-config";
import { ReloadCoordinatorProvider } from "@/react-app/shell/reload-coordinator";
import { WorkspaceProvider } from "@/react-app/shell/workspace-provider";
import "./app/index.css";

if (!import.meta.env.DEV) throw new Error("The session fixture is available only in development.");
initLocale();

const now = Date.now();
const model = { providerID: "openai", modelID: "Preview model" };
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
const previewNotice = () => toast("Visual preview", { description: "This action needs the running desktop app or a connected service." });

// Unimplemented operations point only at the reserved .invalid domain. No
// existing server connection or provider credential is used by this fixture.
const fixtureClient: LegalworkServerClient = {
  ...createLegalworkServerClient({ baseUrl: "https://legalwork-preview.invalid", token: "visual-fixture" }),
  getSessionSnapshot: async (_workspaceId, sessionId) => {
    const item = snapshots.get(sessionId);
    if (!item) throw new Error("Unknown preview session");
    return { item };
  },
  getConfig: async () => ({ opencode: {}, legalwork: {} }),
  getVoiceRealtimeCapability: async () => ({ supported: false, providerId: null, model: null, reason: "Voice is unavailable in the visual fixture." }),
  getUserEnvStatus: async () => ({ runtimeKey: "visual-fixture", pendingChanges: false }),
  listUserEnv: async () => ({ items: [] }),
  listSkills: async () => ({ items: [] }),
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
  const [selectedSessionId, setSelectedSessionId] = useState(welcomeId);
  const [revision, setRevision] = useState(0);
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
          selectedSessionId={selectedSessionId} selectedWorkspaceId={workspace.id} selectedWorkspaceDisplay={workspace}
          selectedWorkspaceRoot={workspace.path} runtimeWorkspaceId={workspace.id} workspaces={[workspace, otherWorkspace]}
          clientConnected legalworkServerStatus="connected" legalworkServerClient={fixtureClient}
          legalworkServerToken="visual-fixture" opencodeBaseUrl="https://legalwork-preview.invalid/opencode"
          developerMode={false} headerStatus="Ready" busyHint={null} startupPhase="ready" providerConnectedIds={[model.providerID]}
          hasUsableModel mcpConnectedCount={0} onOpenSettings={previewNotice} todos={[]} sessionLoadingById={() => false}
          onRenameSession={(id, title) => {
            const item = snapshots.get(id);
            if (item) saveSnapshot({ ...item, session: { ...item.session, title } });
            setRevision((value) => value + 1);
          }}
          sidebar={{
            workspaceSessionGroups: groups, selectedWorkspaceId: workspace.id, selectedSessionId, developerMode: false,
            sessionStatusById: {}, connectingWorkspaceId: null, workspaceConnectionStateById: {}, newTaskDisabled: false,
            sidebarHydratedFromCache: true, startupPhase: "ready", onSelectWorkspace: previewNotice,
            onOpenSession: (_workspaceId, id) => setSelectedSessionId(id), onCreateTaskInWorkspace: newTask,
            onOpenRenameWorkspace: previewNotice, onRevealWorkspace: previewNotice, onForgetWorkspace: previewNotice,
            onOpenCreateWorkspace: previewNotice, onCreateTaskInNewWorkspace: previewNotice,
            onShowLearnings: previewNotice, onShowWorkflows: previewNotice, onShowExtensions: previewNotice, onShowRecorder: previewNotice,
          }}
          surface={{
            workspaceRoot: workspace.path, developerMode: false, modelLabel: "Preview model", onModelClick: previewNotice,
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
