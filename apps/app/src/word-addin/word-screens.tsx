/** @jsxImportSource react */
import { useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, FolderPlus, Plus } from "lucide-react";

import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { getDisplaySessionTitle } from "@/app/lib/session-title";
import type { LegalworkWorkspaceInfo } from "@/app/lib/legalwork-server";
import { writeLastSessionFor } from "@/react-app/shell/session-memory";
import { t } from "@/i18n";
import { useWordServerClient } from "./use-word-server-client";

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

function suggestWorkspaceFolder(existing: LegalworkWorkspaceInfo[], name: string): string {
  const sibling = existing[0]?.path ?? "";
  if (!sibling.includes("/")) return "";
  const parent = sibling.slice(0, sibling.lastIndexOf("/"));
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `${parent}/${slug}` : "";
}

export function WordWorkspacesScreen() {
  const client = useWordServerClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const [folderTouched, setFolderTouched] = useState(false);

  const workspaces = useQuery({
    queryKey: ["word-addin", "workspaces"],
    queryFn: () => client.listWorkspaces(),
  });
  const items = workspaces.data?.items ?? [];

  const openWorkspace = (workspaceId: string) => {
    // Mirrors the app sidebar: make the workspace active server-side, but do
    // not block navigation on it.
    client.activateWorkspace(workspaceId).catch(() => undefined);
    navigate(`/w/${encodeURIComponent(workspaceId)}/sessions`);
  };

  const createWorkspace = useMutation({
    mutationFn: () =>
      client.createLocalWorkspace({ folderPath: folderPath.trim(), name: name.trim(), preset: "starter" }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ["word-addin", "workspaces"] });
      const created = (result.items ?? []).find((item) => item.path === folderPath.trim());
      setCreating(false);
      setName("");
      setFolderPath("");
      setFolderTouched(false);
      if (created) openWorkspace(created.id);
    },
    onError: (error: unknown) => {
      toast.warning(error instanceof Error ? error.message : String(error));
    },
  });

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
              if (!submitDisabled) createWorkspace.mutate();
            }}
          >
            <div className="text-xs font-medium">{t("word_addin.new_workspace")}</div>
            <Input
              autoFocus
              value={name}
              placeholder={t("word_addin.workspace_name")}
              onChange={(event) => {
                const next = event.target.value;
                setName(next);
                if (!folderTouched) setFolderPath(suggestWorkspaceFolder(items, next));
              }}
            />
            <Input
              value={folderPath}
              placeholder={t("word_addin.workspace_folder")}
              onChange={(event) => {
                setFolderTouched(true);
                setFolderPath(event.target.value);
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

  const workspaces = useQuery({
    queryKey: ["word-addin", "workspaces"],
    queryFn: () => client.listWorkspaces(),
  });
  const workspaceName =
    workspaces.data?.items.find((item) => item.id === workspaceId)?.name ?? "";

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
            onClick={() => {
              // The session route restores the remembered session when the
              // URL has none; forget it so a fresh task view opens instead.
              writeLastSessionFor(workspaceId, null);
              navigate(`/workspace/${encodeURIComponent(workspaceId)}/session`);
            }}
          >
            <Plus size={15} />
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
