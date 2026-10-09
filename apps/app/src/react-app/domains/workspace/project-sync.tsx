import { useState, type ReactElement, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Building2,
  CalendarDays,
  ChevronDown,
  CloudOff,
  Folder,
  LogOut,
  Mic,
  RefreshCw,
  SlidersHorizontal,
  SquareCheck,
  StickyNote,
  Table2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import type {
  ProjectSyncOverview,
  ProjectSyncScope,
  ProjectSyncSettings,
  ProjectSyncSkipped,
  ProjectSyncState,
  ProjectSyncStatus,
} from "@legalwork/types/workspace";
import { LegalworkServerError, type LegalworkServerClient, type LegalworkTaskMember, type LegalworkWorkspaceDirectoryEntry } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { projectFileDisplayName } from "./project-note-title";
import { WorkspaceIcon } from "@/react-app/design-system/workspace-icon";
import { useSyncEventsLive } from "@/react-app/kernel/sync-events";
import { t } from "@/i18n";
import { formatTaskDateTime } from "../tasks/task-format";
import { initialsOf, OptionText } from "../tasks/task-glyphs";
import { useTaskMembers } from "../tasks/tasks-queries";
import { PROJECT_SYNC_POLL_MS, useProjectSyncStore } from "./project-sync-store";
import { useOrgPolicy, useOrgPolicyStore } from "../connections/org-policy";

/**
 * Sharing a project with the firm (Eigenwelt Sync), as the member sees it:
 * a Share action on the project, the people and content it is shared with,
 * and whatever sync could not settle alone. Like the tasks' sync mark, the
 * syncing itself stays out of sight until it needs someone. The server does
 * the syncing (project-sync.ts); this passes the member's choices on.
 */

const STATE_LABELS: Record<ProjectSyncState, () => string> = {
  local: () => t("project_sync.state_local"),
  pending: () => t("project_sync.state_pending"),
  synced: () => t("project_sync.state_synced"),
  offline: () => t("project_sync.state_offline"),
  error: () => t("project_sync.state_error"),
  unavailable: () => t("project_sync.state_unavailable"),
  paused: () => t("project_sync.state_paused"),
  revoked: () => t("project_sync.state_revoked"),
  offered: () => t("project_sync.state_offered"),
};

/** States someone has to look at; "syncing" and "synced" are not among them. */
function needsAttention(state: ProjectSyncState): boolean {
  return state !== "local" && state !== "pending" && state !== "synced";
}

function AttentionIcon(props: { state: ProjectSyncState; className?: string }) {
  return props.state === "offline"
    ? <CloudOff className={cn("size-4", props.className)} />
    : <AlertTriangle className={cn("size-4 text-warning", props.className)} />;
}

/**
 * A project's folder in the sidebar and Projects page. A shared folder has a person
 * on its front, as shared folders do in Drive and Finder, and a dot on its
 * corner when it needs someone (grey while offline).
 */
export function ProjectFolderIcon(props: { workspaceId: string; open: boolean }) {
  const state = useProjectSyncStore((store) => store.states[props.workspaceId]);
  const attention = state !== undefined && needsAttention(state);
  const label = state === undefined ? undefined : attention ? STATE_LABELS[state]() : t("project_sync.shared");
  return (
    <span className="relative flex shrink-0" title={label}>
      <WorkspaceIcon workspaceId={props.workspaceId} sizeClass="size-5" open={props.open} shared={state !== undefined} />
      {attention ? (
        <span className={cn("absolute -right-0.5 top-0 size-2 rounded-full", state === "offline" ? "bg-muted-foreground" : "bg-warning")} />
      ) : null}
      {label ? <span className="sr-only">{label}</span> : null}
    </span>
  );
}

const SCOPE_ROWS: { key: keyof ProjectSyncScope; icon: ReactNode; label: () => string }[] = [
  { key: "documents", icon: <Folder />, label: () => t("project_sync.scope_documents") },
  { key: "reviews", icon: <Table2 />, label: () => t("project_sync.scope_reviews") },
  { key: "notes", icon: <StickyNote />, label: () => t("project_sync.scope_notes") },
  { key: "calendar", icon: <CalendarDays />, label: () => t("calendar.sharing") },
  { key: "tasks", icon: <SquareCheck />, label: () => t("project_sync.scope_tasks") },
  { key: "recordings", icon: <Mic />, label: () => t("project_sync.scope_recordings") },
  { key: "metadata", icon: <SlidersHorizontal />, label: () => t("project_sync.scope_metadata") },
];

const SKIPPED_LABELS: Record<ProjectSyncSkipped["reason"], (path: string) => string> = {
  too_large: (path) => t("project_sync.skipped_too_large", { path }),
  name_clash: (path) => t("project_sync.skipped_name_clash", { path }),
  failed: (path) => t("project_sync.skipped_failed", { path }),
};

function memberName(member: LegalworkTaskMember): string {
  return member.name?.trim() || member.email?.trim() || member.userId;
}

/** Re-read on the server's sync events (session-route); polled only without them. */
function useProjectSyncStatus(client: LegalworkServerClient, workspaceId: string) {
  const live = useSyncEventsLive((state) => state.live);
  return useQuery({
    queryKey: ["project-sync", workspaceId],
    queryFn: () => client.projectSyncStatus(workspaceId),
    refetchInterval: live ? false : PROJECT_SYNC_POLL_MS,
  });
}

function errorText(error: unknown): string {
  if (error instanceof LegalworkServerError) {
    if (error.code === "project_sync_not_connected") return t("project_sync.sign_in");
    if (error.code === "project_sync_not_owner") return t("project_sync.owner_only_short");
    if (error.code === "project_sync_offer_pending") return t("project_sync.offer_pending");
    return error.message;
  }
  return t("project_sync.failed");
}

/** A neutral round mark, for a person's initials or an icon. */
function Mark(props: { children: ReactNode; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/10 text-xs font-semibold text-foreground/80 [&_svg]:size-4",
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}

/**
 * The Share action on a project. Like a document's share button elsewhere, it
 * reads "Share" until someone else has the project, then "Shared" with their
 * faces; a warning takes their place only when sync needs someone.
 */
export function ProjectShareButton(props: { client: LegalworkServerClient; workspaceId: string; projectName: string }) {
  const [open, setOpen] = useState(false);
  const status = useProjectSyncStatus(props.client, props.workspaceId);
  const data = status.data;
  const shared = data?.mode === "synced";
  const members = useTaskMembers({ client: shared ? props.client : null, workspaceId: props.workspaceId });
  const others = shared && data.settings.access === "members"
    ? [data.ownerUserId, ...data.settings.memberIds].flatMap((id) => {
        const member = members.data?.find((entry) => entry.userId === id);
        return member && id !== data.viewerUserId ? [memberName(member)] : [];
      })
    : [];
  const attention = data && needsAttention(data.state) ? data.state : null;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 gap-1.5 rounded-[var(--lw-radius-md)] px-2.5 text-xs"
        aria-haspopup="dialog"
        aria-label={shared ? t("project_sync.manage_sharing") : t("project_sync.share_project")}
        title={attention ? STATE_LABELS[attention]() : shared && data.settings.access === "org" ? t("project_sync.access_org") : others.join(", ") || undefined}
        onClick={() => setOpen(true)}
      >
        {attention ? (
          <AttentionIcon state={attention} />
        ) : !shared ? (
          <UserPlus />
        ) : data.settings.access === "org" ? (
          <Building2 />
        ) : others.length > 0 ? (
          <span className="-ml-1 flex -space-x-1">
            {others.slice(0, 3).map((name, index) => (
              <Mark key={`${name}-${index}`} className="size-6 bg-secondary text-[10px] ring-2 ring-background">{initialsOf(name)}</Mark>
            ))}
            {others.length > 3 ? <Mark className="size-6 bg-secondary text-[10px] ring-2 ring-background">+{others.length - 3}</Mark> : null}
          </span>
        ) : (
          <Users />
        )}
        {attention ? STATE_LABELS[attention]() : shared ? t("project_sync.shared_button") : t("project_sync.share")}
      </Button>
      {open ? (
        <ProjectShareDialog
          client={props.client}
          workspaceId={props.workspaceId}
          projectName={props.projectName}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

/** The share dialog asked for outside a project's Home, such as from the sidebar's menu. */
export function ProjectShareHost(props: { client: LegalworkServerClient }) {
  const sharing = useProjectSyncStore((store) => store.sharing);
  const share = useProjectSyncStore((store) => store.share);
  if (!sharing) return null;
  return (
    <ProjectShareDialog
      key={sharing.workspaceId}
      client={props.client}
      workspaceId={sharing.workspaceId}
      projectName={sharing.name}
      onClose={() => share(null)}
    />
  );
}

/**
 * A project shared with this member whose folder their own project here
 * already is (the same folder on a shared drive, say): never taken over
 * unasked. They use it as their copy, or keep the two apart.
 */
function OfferDecision(props: {
  client: LegalworkServerClient;
  workspaceId: string;
  offer: NonNullable<ProjectSyncStatus["offer"]>;
  onDecided?: () => void;
  className?: string;
}) {
  const queryClient = useQueryClient();
  const members = useTaskMembers({ client: props.client, workspaceId: props.workspaceId });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owner = members.data?.find((member) => member.userId === props.offer.ownerUserId);
  const decide = async (action: "use_folder" | "keep_apart") => {
    setBusy(true);
    setError(null);
    try {
      queryClient.setQueryData(["project-sync", props.workspaceId], await props.client.resolveProjectSync(props.workspaceId, { action }));
      useProjectSyncStore.getState().refresh();
      props.onDecided?.();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <NoticeRow
      className={props.className}
      icon={<Users />}
      tone="warning"
      title={STATE_LABELS.offered()}
      actions={<>
        <Button size="sm" variant="outline" className="text-xs" disabled={busy} onClick={() => void decide("use_folder")}>{t("project_sync.use_folder")}</Button>
        <Button size="sm" variant="ghost" className="text-xs" disabled={busy} onClick={() => void decide("keep_apart")}>{t("project_sync.keep_apart")}</Button>
      </>}
    >
      <p>
        {t("project_sync.offer", {
          owner: owner ? memberName(owner) : t("project_sync.owner_unknown"),
          name: props.offer.name,
        })}
      </p>
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    </NoticeRow>
  );
}

/**
 * What only the member can decide, above the project: whether their own
 * folder is their copy of a project shared with them, keep or remove a
 * project whose access ended, send or undo deletions sync held back, look at
 * copies kept from a conflict, and what could not reach the firm.
 */
export function ProjectSyncNotice(props: {
  client: LegalworkServerClient;
  workspaceId: string;
  /** Open a version to compare before choosing which stays. */
  onOpenFile?: (entry: LegalworkWorkspaceDirectoryEntry) => void;
}) {
  const queryClient = useQueryClient();
  const status = useProjectSyncStatus(props.client, props.workspaceId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = status.data;
  if (data?.offer) {
    return (
      <div className={NOTICES} aria-live="polite">
        <OfferDecision client={props.client} workspaceId={props.workspaceId} offer={data.offer} className={NOTICE_ROW} />
      </div>
    );
  }
  if (!data || data.mode === "local") return null;

  // A project kept or removed changes the project list: the poller's next look
  // sees the new revision and reloads it.
  const act = async (run: () => Promise<ProjectSyncStatus | ProjectSyncOverview>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      await queryClient.invalidateQueries({ queryKey: ["project-sync", props.workspaceId] });
      useProjectSyncStore.getState().refresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  const resolve = (input: Parameters<LegalworkServerClient["resolveProjectSync"]>[1]) =>
    act(async () => {
      const next = await props.client.resolveProjectSync(props.workspaceId, input);
      // A version put back or dropped here: what shows the project's files reloads.
      if (input.action === "keep_mine" || input.action === "use_theirs") {
        void queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes(props.workspaceId) });
      }
      return next;
    });
  const open = (path: string) => props.onOpenFile?.({ name: path.split("/").at(-1) ?? path, path, kind: "file" });
  const choice = (label: string, onClick: () => void, primary = false) => (
    <Button size="sm" variant={primary ? "outline" : "ghost"} className="text-xs" disabled={busy} onClick={onClick}>{label}</Button>
  );

  const notices: ReactElement[] = [];
  if (data.state === "revoked") {
    notices.push(
      <NoticeRow key="revoked" className={NOTICE_ROW} icon={<AlertTriangle />} tone="warning" title={STATE_LABELS.revoked()} actions={<>
        {choice(t("project_sync.keep_local"), () => void resolve({ action: "keep_local" }), true)}
        {choice(t("project_sync.remove_copy"), () => void resolve({ action: "remove", force: true }))}
      </>}>
        {t("project_sync.revoked", { count: data.pendingChanges })}
      </NoticeRow>,
    );
  }
  if (data.pausedDeletions > 0) {
    notices.push(
      <NoticeRow key="paused" className={NOTICE_ROW} icon={<AlertTriangle />} tone="warning" title={STATE_LABELS.paused()} actions={<>
        {choice(t("project_sync.restore_files"), () => void resolve({ action: "restore_files" }), true)}
        {choice(t("project_sync.delete_files"), () => void resolve({ action: "delete_files" }))}
      </>}>
        {t("project_sync.paused", { count: data.pausedDeletions })}
      </NoticeRow>,
    );
  }
  // Both changed a file and it could not be merged: which version stays, as the editor asks.
  for (const conflict of data.conflicts) {
    const copyPath = conflict.copyPath;
    notices.push(
      <NoticeRow
        key={`conflict-${copyPath}`}
        className={NOTICE_ROW}
        icon={<AlertTriangle />}
        tone="warning"
        title={projectFileDisplayName(conflict.path, conflict.path.split("/").at(-1) ?? conflict.path)}
        actions={<>
          {choice(t("project_sync.keep_both"), () => void resolve({ action: "dismiss_conflict", copyPath }), true)}
          {choice(t("project_sync.use_theirs"), () => void resolve({ action: "use_theirs", copyPath }))}
          {choice(t("project_sync.keep_mine"), () => void resolve({ action: "keep_mine", copyPath }))}
        </>}
      >
        <p>{t("project_sync.conflict")}</p>
        {props.onOpenFile ? (
          <p className="flex flex-wrap gap-x-3">
            <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => open(conflict.path)}>{t("project_sync.open_theirs")}</button>
            <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => open(copyPath)}>{t("project_sync.open_mine")}</button>
          </p>
        ) : null}
      </NoticeRow>,
    );
  }
  if (data.state === "error" || data.state === "offline") {
    notices.push(
      <NoticeRow
        key="error"
        className={NOTICE_ROW}
        icon={data.state === "error" ? <AlertTriangle /> : <CloudOff />}
        tone={data.state === "error" ? "danger" : "quiet"}
        title={STATE_LABELS[data.state]()}
        actions={<Button size="sm" variant="ghost" className="text-xs" disabled={busy} onClick={() => void act(() => props.client.runProjectSync())}><RefreshCw className="size-3.5" />{t("project_sync.retry")}</Button>}
      >
        {data.state === "offline" ? t("project_sync.offline") : t("project_sync.error", { message: data.error ?? "" })}
      </NoticeRow>,
    );
  }
  if (notices.length === 0) return null;
  return (
    <div className={NOTICES} aria-live="polite">
      {notices}
      {error ? <p role="alert" className={cn(NOTICE_ROW, "text-xs text-destructive")}>{error}</p> : null}
    </div>
  );
}

/** The notices are rows of the project's header card, as its details are. */
const NOTICES = "divide-y divide-border/60 border-t border-border/60 bg-background/60";
const NOTICE_ROW = "px-5 py-3 @min-[720px]/project-page:px-6";

const NOTICE_TONES = {
  warning: "bg-amber-3/40 text-amber-11",
  danger: "bg-red-3/40 text-red-11",
  quiet: "bg-muted/60 text-muted-foreground",
};

/** Something about the project's sync to look at: a tile, what it is, and what can be done about it. */
function NoticeRow(props: {
  icon: ReactNode;
  tone: keyof typeof NOTICE_TONES;
  title: string;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-3", props.className)}>
      <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg [&_svg]:size-4", NOTICE_TONES[props.tone])}>{props.icon}</span>
      <div className="min-w-36 flex-1">
        <p className="text-sm font-medium">{props.title}</p>
        {props.children ? <div className="mt-0.5 space-y-1 text-xs leading-5 text-muted-foreground">{props.children}</div> : null}
      </div>
      {props.actions ? <div className="flex flex-wrap items-center gap-1">{props.actions}</div> : null}
    </div>
  );
}

function SectionTitle(props: { children: ReactNode }) {
  return <h3 className="mb-2 text-sm font-medium">{props.children}</h3>;
}

function PersonRow(props: { mark: ReactNode; name: string; detail?: string | null; trailing?: ReactNode }) {
  return (
    <li className="flex min-h-14 items-center gap-3 px-4 py-2.5">
      <Mark>{props.mark}</Mark>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{props.name}</span>
        {props.detail ? <span className="truncate text-xs text-muted-foreground">{props.detail}</span> : null}
      </span>
      {props.trailing}
    </li>
  );
}

/**
 * Who has the project and what they get, the way document sharing works
 * elsewhere: add people at the top, remove them on their row. Sharing is just
 * that list, so it ends when no one else is left; a colleague leaves instead.
 */
function ProjectShareDialog(props: {
  client: LegalworkServerClient;
  workspaceId: string;
  projectName: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const status = useProjectSyncStatus(props.client, props.workspaceId);
  const members = useTaskMembers({ client: props.client, workspaceId: props.workspaceId });
  const [draft, setDraft] = useState<ProjectSyncSettings | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const data = status.data;
  const shared = data?.mode === "synced";
  const isOwner = !shared || data.role === "owner";
  const settings = draft ?? data?.settings ?? null;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(data?.settings);
  const everyone = members.data ?? [];
  const owner = everyone.find((member) => member.userId === data?.ownerUserId);
  const colleagues = everyone.filter((member) => member.userId !== data?.ownerUserId);
  const added = settings ? colleagues.filter((member) => settings.memberIds.includes(member.userId)) : [];
  const addable = settings ? colleagues.filter((member) => !settings.memberIds.includes(member.userId)) : [];
  const alone = settings?.access === "members" && settings.memberIds.length === 0;
  // The firm's policy may allow no sharing.
  const sharingOff = useOrgPolicy("sharing.projects")?.value.allow === false;
  const firmName = useOrgPolicyStore((state) => state.view?.orgName) || t("org_policy.your_firm");
  const nameOf = (member: LegalworkTaskMember | undefined, fallback: string) => {
    const name = member ? memberName(member) : fallback;
    return member && member.userId === data?.viewerUserId ? t("project_sync.you", { name }) : name;
  };

  const update = (next: Partial<ProjectSyncSettings>) => {
    if (settings) setDraft({ ...settings, ...next });
  };

  const run = async (action: () => Promise<ProjectSyncStatus>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      queryClient.setQueryData(["project-sync", props.workspaceId], next);
      useProjectSyncStore.getState().refresh();
      props.onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  // With no one else left, saving ends the sharing: the project stays here.
  const save = (next: ProjectSyncSettings) =>
    run(() => (shared && alone ? props.client.stopProjectSync(props.workspaceId) : props.client.saveProjectSync(props.workspaceId, next)));

  const lastSync = formatTaskDateTime(data?.lastSyncAt);
  const scopeSummary = settings
    ? SCOPE_ROWS.filter((row) => settings.scope[row.key]).map((row) => row.label()).join(", ") || t("project_sync.scope_none")
    : "";

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && props.onClose()}>
      <DialogContent className="max-h-[90vh] gap-6 overflow-y-auto rounded-3xl p-7 sm:max-w-lg sm:p-8 [&>*]:min-w-0" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle className="text-2xl font-semibold tracking-tight">
            {t(leaving ? "project_sync.leave_title" : "project_sync.share_title", { name: props.projectName })}
          </DialogTitle>
          <DialogDescription>
            {t(leaving ? (data?.ownFolder ? "project_sync.leave_confirm_own" : "project_sync.leave_confirm") : "project_sync.share_description")}
          </DialogDescription>
        </DialogHeader>

        {!data || !settings ? (
          <p className="text-sm text-muted-foreground">{status.error ? t("project_sync.failed") : t("projects.loading")}</p>
        ) : data.offer ? (
          <OfferDecision client={props.client} workspaceId={props.workspaceId} offer={data.offer} onDecided={props.onClose} className="rounded-xl border border-border/60 p-3" />
        ) : leaving ? (
          <>
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
            <DialogFooter className="mx-0 mb-0 gap-3 border-0 bg-transparent p-0">
              <Button variant="ghost" disabled={busy} onClick={() => setLeaving(false)}>{t("common.cancel")}</Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => void run(() => props.client.resolveProjectSync(props.workspaceId, { action: "remove", force: true }))}
              >
                {t("project_sync.leave")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            {!data.connected ? <p className="rounded-xl bg-muted px-4 py-3 text-sm">{t("project_sync.sign_in")}</p> : null}
            {isOwner && sharingOff ? <p className="rounded-xl bg-muted px-4 py-3 text-sm">{t("org_policy.sharing_off", { org: firmName })}</p> : null}

            {isOwner ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={!data.connected || sharingOff || (settings.access === "org" && addable.length === 0)}
                  render={<Button variant="outline" className="h-11 w-full justify-start gap-2.5 rounded-xl px-4 font-normal text-muted-foreground shadow-none" />}
                >
                  <UserPlus />
                  <span className="flex-1 text-start">{t("project_sync.add_people")}</span>
                  <ChevronDown />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-72 w-(--anchor-width) overflow-y-auto">
                  {settings.access === "members" ? (
                    <>
                      <DropdownMenuItem onClick={() => update({ access: "org" })}>
                        <Mark className="size-6 [&>svg]:size-3.5"><Building2 /></Mark>
                        <OptionText primary={t("project_sync.access_org")} detail={t("project_sync.access_org_hint")} />
                      </DropdownMenuItem>
                      {addable.length > 0 ? <DropdownMenuSeparator /> : null}
                    </>
                  ) : null}
                  {addable.map((member) => (
                    <DropdownMenuItem key={member.userId} onClick={() => update({ memberIds: [...settings.memberIds, member.userId] })}>
                      <Mark className="size-6 text-[10px]">{initialsOf(memberName(member))}</Mark>
                      <OptionText primary={memberName(member)} detail={member.email ?? undefined} />
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            <section>
              <SectionTitle>{t("project_sync.people")}</SectionTitle>
              <ul className="divide-y divide-border rounded-xl border border-border">
                <PersonRow
                  mark={initialsOf(owner ? memberName(owner) : "?")}
                  name={nameOf(owner, t("project_sync.owner_unknown"))}
                  detail={owner?.email}
                  trailing={<span className="text-xs text-muted-foreground">{t("project_sync.owner")}</span>}
                />
                {settings.access === "org" ? (
                  <PersonRow
                    mark={<Building2 />}
                    name={t("project_sync.access_org")}
                    trailing={
                      isOwner ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t("project_sync.remove_person", { name: t("project_sync.access_org") })}
                          title={t("project_sync.remove_person", { name: t("project_sync.access_org") })}
                          onClick={() => update({ access: "members" })}
                        >
                          <X />
                        </Button>
                      ) : null
                    }
                  />
                ) : null}
                {added.map((member) => (
                    <PersonRow
                      key={member.userId}
                      mark={initialsOf(memberName(member))}
                      name={nameOf(member, member.userId)}
                      detail={member.email}
                      trailing={
                        isOwner ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t("project_sync.remove_person", { name: memberName(member) })}
                            title={t("project_sync.remove_person", { name: memberName(member) })}
                            onClick={() => update({ memberIds: settings.memberIds.filter((id) => id !== member.userId) })}
                          >
                            <X />
                          </Button>
                        ) : null
                      }
                    />
                ))}
              </ul>
            </section>

            <section>
              <SectionTitle>{t("project_sync.scope_title")}</SectionTitle>
              <Collapsible className="rounded-xl border border-border">
                <CollapsibleTrigger className="group flex min-h-12 w-full items-center gap-3 rounded-xl px-4 py-2.5 text-start text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="min-w-0 flex-1 text-muted-foreground">{scopeSummary}</span>
                  <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="divide-y divide-border border-t border-border">
                    {SCOPE_ROWS.map((row) => (
                      <li key={row.key}>
                        <label className="flex min-h-11 items-center gap-3 px-4 py-2 text-sm [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground">
                          {row.icon}
                          <span className="flex-1">{row.label()}</span>
                          {isOwner ? (
                            <Switch
                              checked={settings.scope[row.key] !== false}
                              disabled={!data.connected}
                              onCheckedChange={(checked) => update({ scope: { ...settings.scope, [row.key]: checked } })}
                            />
                          ) : (
                            <span className="text-xs text-muted-foreground">
                              {t(settings.scope[row.key] ? "project_sync.included" : "project_sync.not_included")}
                            </span>
                          )}
                        </label>
                      </li>
                    ))}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            </section>

            {shared && isOwner && alone && dirty ? (
              <p className="rounded-xl bg-muted px-4 py-3 text-sm leading-relaxed">{t("project_sync.unshare_notice")}</p>
            ) : shared && (lastSync || data.pendingChanges > 0 || data.skipped.length > 0) ? (
              <section className="space-y-1 text-xs text-muted-foreground">
                {lastSync ? <p>{t("project_sync.last_sync", { time: lastSync })}</p> : null}
                {data.pendingChanges > 0 ? <p>{t("project_sync.pending", { count: data.pendingChanges })}</p> : null}
                {data.skipped.map((skip) => (
                  <p key={`${skip.path}-${skip.reason}`}>{SKIPPED_LABELS[skip.reason](skip.path)}</p>
                ))}
              </section>
            ) : null}

            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

            <DialogFooter className="mx-0 mb-0 gap-3 border-0 bg-transparent p-0 sm:justify-between">
              {shared && !isOwner ? (
                <Button variant="ghost" className="text-muted-foreground" disabled={busy} onClick={() => setLeaving(true)}>
                  <LogOut />
                  {t("project_sync.leave")}
                </Button>
              ) : (
                <span />
              )}
              <div className="flex gap-3">
                {!shared || dirty ? <Button variant="ghost" disabled={busy} onClick={props.onClose}>{t("common.cancel")}</Button> : null}
                {!shared || dirty ? (
                  <Button disabled={busy || !data.connected || (!shared && alone)} onClick={() => void save(settings)}>
                    {t(shared ? "common.save" : "project_sync.share")}
                  </Button>
                ) : (
                  <Button onClick={props.onClose}>{t("project_sync.done")}</Button>
                )}
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
