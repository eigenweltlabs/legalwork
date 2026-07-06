/** @jsxImportSource react */
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, FolderPlus, Plus } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { createClient, unwrap } from "@/app/lib/opencode";
import { getDisplaySessionTitle } from "@/app/lib/session-title";
import { readLegalworkServerSettings } from "@/app/lib/legalwork-server";
import { resolveWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import { writeLastSessionFor } from "@/react-app/shell/session-memory";
import { t } from "@/i18n";
import { fetchDocumentPath, officeHostName } from "./office";
import { useWordServerClient } from "./use-word-server-client";
import { matchWorkspaceForDocument } from "./workspace-match";

function paneShell(children: ReactNode) {
  return <div className="flex h-dvh flex-col overflow-hidden bg-dls-surface text-dls-text">{children}</div>;
}

function PaneHeader(props: { title: string; onBack?: () => void; action?: ReactNode }) {
  return (
    <div className="flex h-11 shrink-0 items-center gap-1 border-b border-dls-border px-2">
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

function parentFolder(filePath: string): string {
  const trimmed = filePath.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut > 0 ? trimmed.slice(0, cut) : "";
}

function baseName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

export function WordWorkspacesScreen() {
  const client = useWordServerClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  /** Folder of the open Office document, once resolved (null = unsaved/none). */
  const [fileFolder, setFileFolder] = useState<string | null>(null);

  const workspaces = useQuery({
    queryKey: ["word-addin", "workspaces"],
    queryFn: () => client.listWorkspaces(),
  });
  const items = workspaces.data?.items ?? [];

  useEffect(() => {
    if (!officeHostName()) return;
    let cancelled = false;
    void fetchDocumentPath()
      .then((path) => {
        if (cancelled) return;
        const folder = path && !/^https?:\/\//i.test(path) ? parentFolder(path) : "";
        setFileFolder(folder || null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const openWorkspace = (workspaceId: string) => {
    // Mirrors the app sidebar: make the workspace active server-side, but do
    // not block navigation on it.
    client.activateWorkspace(workspaceId).catch(() => undefined);
    navigate(`/w/${encodeURIComponent(workspaceId)}/sessions`);
  };

  // The workspace already covering the open file, if any.
  const existingForFile = fileFolder
    ? matchWorkspaceForDocument(`${fileFolder}/x`, items)
    : null;

  const createInFolder = useMutation({
    mutationFn: (folder: string) =>
      client.createLocalWorkspace({ folderPath: folder, name: baseName(folder), preset: "starter" }),
    onSuccess: async (result, folder) => {
      await queryClient.invalidateQueries({ queryKey: ["word-addin", "workspaces"] });
      const created = (result.items ?? []).find((item) => item.path === folder);
      if (created) openWorkspace(created.id);
    },
    onError: (error: unknown) => {
      toast.warning(error instanceof Error ? error.message : String(error));
    },
  });

  return paneShell(
    <>
      <PaneHeader title={t("word_addin.workspaces_title")} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {fileFolder && !existingForFile ? (
          <div className="border-b border-dls-border bg-dls-hover/40 px-3 py-3">
            <p className="text-xs text-dls-secondary">{t("word_addin.file_folder_hint")}</p>
            <p className="mt-1 truncate text-[11px] text-dls-secondary/80" title={fileFolder}>
              {fileFolder}
            </p>
            <Button
              type="button"
              size="sm"
              className="mt-2 w-full"
              disabled={createInFolder.isPending}
              onClick={() => createInFolder.mutate(fileFolder)}
            >
              <FolderPlus size={14} />
              {createInFolder.isPending
                ? t("word_addin.creating")
                : t("word_addin.create_in_file_folder", { folder: baseName(fileFolder) })}
            </Button>
          </div>
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
