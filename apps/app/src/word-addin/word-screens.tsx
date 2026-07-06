/** @jsxImportSource react */
import { useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, FolderPlus, Plus } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createClient, unwrap } from "@/app/lib/opencode";
import { getDisplaySessionTitle } from "@/app/lib/session-title";
import { readLegalworkServerSettings } from "@/app/lib/legalwork-server";
import { resolveWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { writeLastSessionFor } from "@/react-app/shell/session-memory";
import { t } from "@/i18n";
import { fetchDocumentPath, officeCoversTopRightCorner, officeHostName } from "./office";
import { useWordServerClient } from "./use-word-server-client";

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
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={t("word_addin.back")}
          onClick={props.onBack}
        >
          <ChevronLeft size={16} />
        </Button>
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
        <Button type="button" variant="outline" size="sm" onClick={props.onRetry}>
          {t("word_addin.retry")}
        </Button>
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
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("word_addin.new_workspace")}
            onClick={() => setCreating((current) => !current)}
          >
            <FolderPlus size={15} />
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {creating ? (
          <form
            className="space-y-2 border-b border-dls-border px-3 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!submitDisabled) {
                createWorkspace.mutate({ folderPath: folderPath.trim(), name: name.trim() });
              }
            }}
          >
            <div className="text-xs font-medium">{t("word_addin.new_workspace")}</div>
            {fileFolder && !fileFolderIsWorkspace ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-auto w-full flex-col items-start gap-0.5 py-1.5"
                disabled={createWorkspace.isPending}
                onClick={() =>
                  createWorkspace.mutate({ folderPath: fileFolder, name: folderNameFromPath(fileFolder) })
                }
              >
                <span className="text-xs">{t("word_addin.create_in_file_folder")}</span>
                <span className="max-w-full truncate text-[10px] font-normal text-dls-secondary">
                  {fileFolder}
                </span>
              </Button>
            ) : null}
            {pickerSupported ? (
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={picking || createWorkspace.isPending}
                  onClick={() => void pickFolder()}
                >
                  {t("word_addin.choose_folder")}
                </Button>
                <span className="min-w-0 flex-1 truncate text-[11px] text-dls-secondary">
                  {folderPath || t("word_addin.no_folder_selected")}
                </span>
              </div>
            ) : (
              <Input
                value={folderPath}
                placeholder={t("word_addin.workspace_folder")}
                onChange={(event) => {
                  const next = event.target.value;
                  setFolderPath(next);
                  if (!nameTouched) setName(next.trim() ? folderNameFromPath(next) : "");
                }}
              />
            )}
            <Input
              value={name}
              placeholder={t("word_addin.workspace_name")}
              onChange={(event) => {
                setNameTouched(true);
                setName(event.target.value);
              }}
            />
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setCreating(false)}>
                {t("word_addin.cancel")}
              </Button>
              <Button type="submit" size="sm" disabled={submitDisabled}>
                {createWorkspace.isPending ? t("word_addin.creating") : t("word_addin.create")}
              </Button>
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
          <ul>
            {items.map((workspace) => (
              <li key={workspace.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 border-b border-dls-border/60 px-3 py-2.5 text-left transition-colors hover:bg-dls-hover"
                  onClick={() => openWorkspace(workspace.id)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{workspace.name || workspace.id}</span>
                    <span className="block truncate text-[11px] text-dls-secondary">{workspace.path}</span>
                  </span>
                  <ChevronRight size={14} className="shrink-0 text-dls-secondary" />
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
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("word_addin.new_session")}
            disabled={createSession.isPending || !workspace}
            onClick={() => createSession.mutate()}
          >
            <Plus size={15} className={createSession.isPending ? "animate-pulse" : undefined} />
          </Button>
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
          <ul>
            {items.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 border-b border-dls-border/60 px-3 py-2.5 text-left transition-colors hover:bg-dls-hover"
                  onClick={() =>
                    navigate(
                      `/workspace/${encodeURIComponent(workspaceId)}/session/${encodeURIComponent(session.id)}`,
                    )
                  }
                >
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {getDisplaySessionTitle(session.title)}
                  </span>
                  <span className="shrink-0 text-[11px] text-dls-secondary">
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
