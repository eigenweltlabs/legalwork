/** @jsxImportSource react */
import { useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  Folder,
  FolderPlus,
  Loader2,
  Plus,
} from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { createClient, unwrap } from "@/app/lib/opencode";
import { getDisplaySessionTitle } from "@/app/lib/session-title";
import { readLegalworkServerSettings } from "@/app/lib/legalwork-server";
import { resolveWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { writeLastSessionFor } from "@/react-app/shell/session-memory";
import { t } from "@/i18n";
import { fetchDocumentPath, officeCoversTopRightCorner, officeHostName, openLegalworkApp } from "./office";
import { useWordServerClient } from "./use-word-server-client";

// Compact variants of the platform's pill buttons (see
// react-app/domains/workspace/modal-styles.ts) sized for the narrow pane.
const panePillBase =
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.18)] disabled:cursor-not-allowed disabled:opacity-60";
const panePillPrimary = `${panePillBase} bg-dls-accent text-[var(--dls-accent-fg)] hover:bg-[var(--dls-accent-hover)]`;
const panePillGhost = `${panePillBase} border border-dls-border bg-dls-surface text-dls-secondary hover:bg-dls-hover hover:text-dls-text`;

export const paneIconButtonClass =
  "flex size-7 shrink-0 items-center justify-center rounded-lg text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.18)] disabled:cursor-not-allowed disabled:opacity-50";

const paneInputClass =
  "w-full rounded-xl border border-dls-border bg-dls-hover px-3 py-2 text-[13px] text-dls-text placeholder:text-dls-secondary focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.12)] disabled:cursor-not-allowed disabled:opacity-60";

function paneShell(children: ReactNode) {
  return <div className="flex h-dvh flex-col overflow-hidden bg-dls-surface text-dls-text">{children}</div>;
}

function PaneHeader(props: { title: string; onBack?: () => void; action?: ReactNode }) {
  // Keep the top-right corner free of Office's floating info button on Mac.
  const reserveCorner = officeCoversTopRightCorner();
  return (
    <div
      className={`flex h-11 shrink-0 items-center gap-1 border-b border-dls-border px-2 ${reserveCorner ? "pr-11" : ""}`}
    >
      {props.onBack ? (
        <button
          type="button"
          className={paneIconButtonClass}
          aria-label={t("word_addin.back")}
          onClick={props.onBack}
        >
          <ChevronLeft size={16} />
        </button>
      ) : null}
      <div className="min-w-0 flex-1 truncate px-1 text-sm font-medium">{props.title}</div>
      {props.action}
    </div>
  );
}

function PaneNotice(props: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <p className="text-xs leading-relaxed text-dls-secondary">{props.message}</p>
      {props.onRetry ? (
        // Load failures usually mean the desktop app is not running, so
        // offer to launch it alongside the retry.
        <div className="flex items-center gap-2">
          <button type="button" className={panePillPrimary} onClick={() => openLegalworkApp()}>
            {t("word_addin.open_legalwork")}
          </button>
          <button type="button" className={panePillGhost} onClick={props.onRetry}>
            {t("word_addin.retry")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function formatSessionTime(updated: number | undefined): string {
  if (!updated || !Number.isFinite(updated)) return "";
  const date = new Date(updated);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

function folderNameFromPath(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function parentFolderOfFile(filePath: string): string | null {
  const index = filePath.lastIndexOf("/");
  return index > 0 ? filePath.slice(0, index) : null;
}

export function WordWorkspacesScreen() {
  const client = useWordServerClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  // Falls back to a typed path when the server has no native dialog
  // (standalone CLI server without the desktop app).
  const [pickerSupported, setPickerSupported] = useState(true);
  const [picking, setPicking] = useState(false);

  const workspaces = useQuery({
    queryKey: ["word-addin", "workspaces"],
    queryFn: () => client.listWorkspaces(),
  });
  const items = workspaces.data?.items ?? [];

  // Folder of the open Office document (null while unsaved or cloud-hosted),
  // offered as a one-click "create workspace here" shortcut.
  const documentFolder = useQuery({
    queryKey: ["word-addin", "document-folder"],
    queryFn: async () => {
      const docPath = await fetchDocumentPath();
      if (!docPath || /^https?:\/\//i.test(docPath)) return null;
      return parentFolderOfFile(docPath);
    },
    enabled: creating,
  });
  const fileFolder = documentFolder.data ?? null;
  const fileFolderIsWorkspace = Boolean(
    fileFolder &&
      items.some((workspace) => (workspace.path ?? "").toLowerCase() === fileFolder.toLowerCase()),
  );

  const openWorkspace = (workspaceId: string) => {
    // Mirrors the app sidebar: make the workspace active server-side, but do
    // not block navigation on it.
    client.activateWorkspace(workspaceId).catch(() => undefined);
    navigate(`/w/${encodeURIComponent(workspaceId)}/sessions`);
  };

  const createWorkspace = useMutation({
    mutationFn: (input: { folderPath: string; name: string }) =>
      client.createLocalWorkspace({ folderPath: input.folderPath, name: input.name, preset: "starter" }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["word-addin", "workspaces"] });
      setCreating(false);
      setName("");
      setNameTouched(false);
      setFolderPath("");
      if (result.activeId) openWorkspace(result.activeId);
    },
    onError: (error: unknown) => {
      toast.warning(error instanceof Error ? error.message : String(error));
    },
  });

  const pickFolder = async () => {
    setPicking(true);
    try {
      const result = await client.pickWorkspaceFolder({
        title: t("word_addin.new_workspace"),
        // So the desktop app can hand focus back to this Office app after
        // the dialog closes.
        returnFocusTo: officeHostName() ?? undefined,
      });
      if (!result.supported) {
        setPickerSupported(false);
        return;
      }
      if (result.path) {
        setFolderPath(result.path);
        if (!nameTouched || !name.trim()) setName(folderNameFromPath(result.path));
      }
    } catch (error) {
      toast.warning(error instanceof Error ? error.message : String(error));
    } finally {
      setPicking(false);
    }
  };

  const submitDisabled = !name.trim() || !folderPath.trim() || createWorkspace.isPending;

  return paneShell(
    <>
      <PaneHeader
        title={t("word_addin.workspaces_title")}
        action={
          <button
            type="button"
            className={paneIconButtonClass}
            aria-label={t("word_addin.new_workspace")}
            onClick={() => setCreating((current) => !current)}
          >
            <FolderPlus size={15} />
          </button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {creating ? (
          <form
            className="space-y-2 border-b border-dls-border p-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!submitDisabled) {
                createWorkspace.mutate({ folderPath: folderPath.trim(), name: name.trim() });
              }
            }}
          >
            <div className="text-[13px] font-medium text-dls-text">{t("word_addin.new_workspace")}</div>
            {fileFolder && !fileFolderIsWorkspace ? (
              <button
                type="button"
                disabled={createWorkspace.isPending}
                className="group flex w-full items-center gap-2.5 rounded-2xl border border-dls-border bg-dls-surface p-2.5 text-left transition-all duration-150 hover:bg-dls-hover hover:shadow-[0_2px_12px_-4px_rgba(0,0,0,0.06)] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.16)] disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() =>
                  createWorkspace.mutate({ folderPath: fileFolder, name: folderNameFromPath(fileFolder) })
                }
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-hover text-dls-secondary transition-colors group-hover:text-dls-accent">
                  {createWorkspace.isPending ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : (
                    <FileText size={15} />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-medium leading-snug text-dls-text">
                    {t("word_addin.create_in_file_folder")}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-dls-secondary">{fileFolder}</span>
                </span>
              </button>
            ) : null}
            {folderPath && pickerSupported ? (
              <div className="flex items-center gap-2.5 rounded-2xl border border-dls-border bg-dls-surface p-2.5">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-emerald-3 text-emerald-11">
                  <Check size={15} strokeWidth={2.5} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium text-dls-text">
                    {folderNameFromPath(folderPath)}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-dls-secondary">{folderPath}</span>
                </span>
                <button
                  type="button"
                  className={panePillGhost}
                  disabled={picking || createWorkspace.isPending}
                  onClick={() => void pickFolder()}
                >
                  {picking ? <Loader2 size={13} className="animate-spin" /> : null}
                  {t("dashboard.change")}
                </button>
              </div>
            ) : pickerSupported ? (
              <button
                type="button"
                disabled={picking || createWorkspace.isPending}
                className="group flex w-full items-center gap-2.5 rounded-2xl border border-dashed border-dls-border bg-dls-hover p-2.5 text-left transition-all duration-150 hover:border-[rgba(var(--dls-accent-rgb),0.35)] hover:bg-dls-surface focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb),0.16)] disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void pickFolder()}
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-dls-border bg-dls-surface text-dls-secondary transition-colors group-hover:text-dls-accent">
                  {picking ? <Loader2 size={15} className="animate-spin" /> : <FolderPlus size={15} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12px] font-medium text-dls-text">
                    {t("word_addin.choose_folder")}
                  </span>
                  <span className="block truncate text-[10px] text-dls-secondary">
                    {t("word_addin.no_folder_selected")}
                  </span>
                </span>
              </button>
            ) : (
              <input
                className={paneInputClass}
                value={folderPath}
                placeholder={t("word_addin.workspace_folder")}
                onChange={(event) => {
                  const next = event.target.value;
                  setFolderPath(next);
                  if (!nameTouched) setName(next.trim() ? folderNameFromPath(next) : "");
                }}
              />
            )}
            <input
              className={paneInputClass}
              value={name}
              placeholder={t("word_addin.workspace_name")}
              onChange={(event) => {
                setNameTouched(true);
                setName(event.target.value);
              }}
            />
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className={panePillGhost} onClick={() => setCreating(false)}>
                {t("word_addin.cancel")}
              </button>
              <button type="submit" className={panePillPrimary} disabled={submitDisabled}>
                {createWorkspace.isPending ? t("word_addin.creating") : t("word_addin.create")}
              </button>
            </div>
          </form>
        ) : null}
        {workspaces.isLoading ? (
          <PaneNotice message={t("word_addin.loading")} />
        ) : workspaces.isError ? (
          <PaneNotice message={t("word_addin.load_failed")} onRetry={() => void workspaces.refetch()} />
        ) : items.length === 0 ? (
          <PaneNotice message={t("word_addin.no_workspaces")} />
        ) : (
          <ul className="space-y-1 p-2">
            {items.map((workspace) => (
              <li key={workspace.id}>
                <button
                  type="button"
                  className="group flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-dls-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.16)]"
                  onClick={() => openWorkspace(workspace.id)}
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-dls-border bg-dls-hover text-dls-secondary transition-colors group-hover:bg-dls-surface">
                    <Folder size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-dls-text">
                      {workspace.name || workspace.id}
                    </span>
                    <span className="block truncate font-mono text-[10px] text-dls-secondary">
                      {workspace.path}
                    </span>
                  </span>
                  <ChevronRight
                    size={14}
                    className="shrink-0 text-dls-secondary opacity-0 transition-opacity group-hover:opacity-100"
                  />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>,
  );
}

export function WordSessionsScreen() {
  const { workspaceId = "" } = useParams();
  const client = useWordServerClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const workspaces = useQuery({
    queryKey: ["word-addin", "workspaces"],
    queryFn: () => client.listWorkspaces(),
  });
  const workspace = workspaces.data?.items.find((item) => item.id === workspaceId);
  const workspaceName = workspace?.name ?? "";

  // Mirrors the app's "New Task": create a real (empty) session and open it,
  // so the user lands in the composer instead of the passive session picker.
  const createSession = useMutation({
    mutationFn: async () => {
      if (!workspace) throw new Error(t("word_addin.load_failed"));
      const settings = readLegalworkServerSettings();
      const endpoint = resolveWorkspaceEndpoint(workspace, {
        baseUrl: settings.urlOverride ?? window.location.origin,
        token: settings.token ?? "",
      });
      if (!endpoint?.token) throw new Error(t("word_addin.load_failed"));
      const opencodeClient = createClient(
        endpoint.opencodeBaseUrl,
        workspace.path?.trim() || undefined,
        { token: endpoint.token, mode: "legalwork" },
      );
      return unwrap(
        await opencodeClient.session.create({ directory: workspace.path?.trim() || undefined }),
      );
    },
    onSuccess: (session) => {
      writeLastSessionFor(workspaceId, session.id);
      void queryClient.invalidateQueries({ queryKey: ["word-addin", "sessions", workspaceId] });
      navigate(`/workspace/${encodeURIComponent(workspaceId)}/session/${encodeURIComponent(session.id)}`);
    },
    onError: (error: unknown) => {
      toast.warning(error instanceof Error ? error.message : String(error));
    },
  });

  const sessions = useQuery({
    queryKey: ["word-addin", "sessions", workspaceId],
    queryFn: () => client.listSessions(workspaceId, { roots: true, limit: 100 }),
    enabled: Boolean(workspaceId),
  });
  const items = [...(sessions.data?.items ?? [])].sort(
    (left, right) => (right.time?.updated ?? 0) - (left.time?.updated ?? 0),
  );

  return paneShell(
    <>
      <PaneHeader
        title={workspaceName || t("word_addin.sessions_title")}
        onBack={() => navigate("/")}
        action={
          <button
            type="button"
            className={paneIconButtonClass}
            aria-label={t("word_addin.new_session")}
            disabled={createSession.isPending || !workspace}
            onClick={() => createSession.mutate()}
          >
            {createSession.isPending ? (
              <Loader2 size={15} className="animate-spin" />
            ) : (
              <Plus size={15} />
            )}
          </button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sessions.isLoading ? (
          <PaneNotice message={t("word_addin.loading")} />
        ) : sessions.isError ? (
          <PaneNotice message={t("word_addin.load_failed")} onRetry={() => void sessions.refetch()} />
        ) : items.length === 0 ? (
          <PaneNotice message={t("word_addin.no_sessions")} />
        ) : (
          <ul className="space-y-0.5 p-2">
            {items.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-dls-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.16)]"
                  onClick={() =>
                    navigate(
                      `/workspace/${encodeURIComponent(workspaceId)}/session/${encodeURIComponent(session.id)}`,
                    )
                  }
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] text-dls-text">
                    {getDisplaySessionTitle(session.title)}
                  </span>
                  <span className="shrink-0 text-[10px] text-dls-secondary">
                    {formatSessionTime(session.time?.updated)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>,
  );
}
