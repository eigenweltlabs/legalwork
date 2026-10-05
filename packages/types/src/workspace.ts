import { z } from "zod";

/**
 * Shared wire contract for workspace records.
 *
 * Producers:
 * - legalwork-server (apps/server): `GET /workspaces` and friends — emits plain
 *   optionals (never null) plus the `opencode*` engine credential fields.
 * - desktop Electron IPC bridge (apps/desktop main.mjs): emits explicit nulls
 *   and the desktop-managed `legalworkClientToken`/`legalworkHostToken`.
 *
 * Consumers (apps/app) must treat every optional field as possibly absent,
 * undefined, or null. Producer-side types assert assignability against this
 * shape (see apps/server/src/types.ts) so drift fails typecheck instead of
 * surfacing as runtime undefined-field bugs.
 */
export type WorkspaceKind = "local" | "remote";

export type WorkspaceRemoteKind = "opencode" | "legalwork";

/** Project information travels with the folder; documents remain ordinary files. */
export type ProjectField = {
  id: string;
  label: string;
  /** Suggested labels follow the app language; custom labels are literal. */
  labelSource?: "suggested" | "custom";
  type: "text" | "number" | "date" | "select";
  value: string | number | null;
  options?: string[];
};

/** References only. Authentication and local connection bindings never travel with a project. */
export const remoteFolderSchema = z.object({
  id: z.string().uuid(),
  connectionId: z.string().min(1).max(200),
  connectionName: z.string().min(1).max(200),
  organizationId: z.string().max(200).optional(),
  connectionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  folder: z.object({
    path: z.string().max(4096),
    name: z.string().min(1).max(255),
    id: z.string().max(512).optional(),
    namespace: z.string().max(512).optional(),
  }).strict(),
}).strict();
// Setup status also applies to local-only projects (folders: []).
export const projectRemoteSchema = z.object({
  version: z.literal(1),
  folders: z.array(remoteFolderSchema).max(30).refine((folders) => new Set(folders.map((folder) => folder.id)).size === folders.length),
  // Discard the retired summary when reading older local records or platform responses.
  context: z.string().max(24000).optional(),
  initialization: z.enum(["none", "pending", "ready"]),
}).strict().transform(({ context: _legacyContext, ...configuration }) => configuration);
export type ProjectRemoteFolder = z.infer<typeof remoteFolderSchema>;
export type ProjectRemote = z.infer<typeof projectRemoteSchema>;
export type RemoteFolderSelection = { sourceWorkspaceId: string; connectionId: string; path: string };
export type ProjectRemoteFolderStatus = {
  location: ProjectRemoteFolder;
  connectionId: string;
  status: "available" | "disconnected" | "missing" | "denied";
  path?: string;
  error?: string;
  limitations: string[];
};

export type ProjectDetails = {
  version: 1;
  revision: number;
  fields: ProjectField[];
  /** User-provided writing preferences for every chat in this project. */
  personalizationPrompt?: string;
  remote?: ProjectRemote;
  /**
   * The firm's id for this project once it syncs. Kept with the folder, so a
   * folder added again (or found again after a reinstall) is recognised as the
   * same project rather than becoming a second copy of it.
   */
  syncProjectId?: string;
};

/**
 * What a synced project carries to the firm. Chats are never part of it:
 * each chat is shared on its own, through its own sharing.
 */
export type ProjectSyncScope = {
  calendar?: boolean;
  documents: boolean;
  notes: boolean;
  tasks: boolean;
  recordings: boolean;
  metadata: boolean;
  /** Tabular Reviews and their earlier runs, with the documents they review (even with `documents` off). */
  reviews: boolean;
};

export type ProjectSyncAccess = "org" | "members";

/** What the owner chooses when turning sync on, or changing it later. */
export type ProjectSyncSettings = {
  access: ProjectSyncAccess;
  /** Colleagues who see a `members` project besides its owner. */
  memberIds: string[];
  scope: ProjectSyncScope;
};

/**
 * Where a project stands, as the project's sync status shows it:
 * `local` — not synced; `pending` — changes on their way; `synced` — up to
 * date; `offline` — the firm cannot be reached; `error` — the last attempt
 * failed; `unavailable` — the project folder is missing; `conflict` — both
 * sides changed a file and a copy was kept; `paused` — many files were
 * deleted here and sync waits for a decision; `revoked` — access ended while
 * changes made here had not been uploaded.
 */
export type ProjectSyncState =
  | "local"
  | "pending"
  | "synced"
  | "offline"
  | "error"
  | "unavailable"
  | "paused"
  | "revoked"
  /** Shared with this member, and one of their own projects' folders already is it: theirs to decide. */
  | "offered";

export type ProjectSyncConflict = {
  /** The file as the firm has it. */
  path: string;
  /** Where this computer's version was kept. */
  copyPath: string;
  at: string;
};

export type ProjectSyncSkipped = {
  path: string;
  reason: "too_large" | "name_clash" | "failed";
};

export type ProjectSyncStatus = {
  workspaceId: string;
  /** Signed in with a firm, so sync is possible at all. */
  connected: boolean;
  mode: "local" | "synced";
  /** This member's relation to a synced project; only the owner changes its settings. */
  role: "owner" | "member" | null;
  /** The signed-in member looking at it. */
  viewerUserId: string | null;
  ownerUserId: string | null;
  settings: ProjectSyncSettings;
  state: ProjectSyncState;
  lastSyncAt: string | null;
  error: string | null;
  /** Changes made here that have not reached the firm yet. */
  pendingChanges: number;
  conflicts: ProjectSyncConflict[];
  skipped: ProjectSyncSkipped[];
  /** Files deleted here that sync holds back until the user decides. */
  pausedDeletions: number;
  /** A member's copy that is a folder they brought themselves: leaving keeps it as their own project. */
  ownFolder: boolean;
  /** A project shared with this member whose folder this local project already is, waiting for their decision. */
  offer: { projectId: string; name: string; ownerUserId: string } | null;
};

/** Every project's state at once, for the sidebar; `revision` moves when projects arrive, leave or are renamed. */
export type ProjectSyncOverview = {
  connected: boolean;
  revision: number;
  states: Record<string, ProjectSyncState>;
  /** Per project: moves whenever sync changed its files on this computer, so what shows them reloads. */
  contents: Record<string, number>;
  /** Projects sync took off this computer while the server ran: the app's own list forgets them too. */
  removed: string[];
};

export type WorkspaceWire = {
  id: string;
  name: string;
  path: string;
  preset: string;
  workspaceType: WorkspaceKind;
  remoteType?: WorkspaceRemoteKind | null;
  baseUrl?: string | null;
  directory?: string | null;
  displayName?: string | null;
  legalworkHostUrl?: string | null;
  legalworkToken?: string | null;
  /** Desktop IPC only: tokens for desktop-managed remote workspaces. */
  legalworkClientToken?: string | null;
  legalworkHostToken?: string | null;
  legalworkWorkspaceId?: string | null;
  legalworkWorkspaceName?: string | null;
  /**
   * Vocabulary differs per producer today ("docker" | "microsandbox" on the
   * desktop, "none" | "docker" | "container" in legalwork-server), so the wire
   * stays a plain string until the backends converge.
   */
  sandboxBackend?: string | null;
  sandboxRunId?: string | null;
  sandboxContainerName?: string | null;
  /** legalwork-server only: credentials for the proxied opencode engine. */
  opencodeUsername?: string | null;
  opencodePassword?: string | null;
  opencode?: {
    baseUrl?: string;
    directory?: string;
    username?: string;
    password?: string;
  } | null;
};

/** A bounded project inventory shared by the agent tools and chat cards. */
const kind = z.enum(["tasks", "notes", "files", "recordings", "sessions"]);
const item = z.object({
  id: z.string(), kind, title: z.string(), preview: z.string().optional(), status: z.string().optional(),
  dueDate: z.string().nullable().optional(), attachmentCount: z.number().optional(),
  directory: z.boolean().optional(), size: z.number().optional(), durationMs: z.number().optional(),
  segmentCount: z.number().optional(),
});
export const projectContentsSchema = z.object({
  version: z.literal(1),
  project: z.object({
    id: z.string(), name: z.string(),
    fields: z.array(z.object({
      id: z.string(), label: z.string(), labelSource: z.enum(["suggested", "custom"]).optional(),
      type: z.enum(["text", "number", "date", "select"]), value: z.union([z.string(), z.number(), z.null()]),
      options: z.array(z.string()).optional(),
    })),
  }),
  sections: z.array(z.object({ kind, path: z.string(), items: z.array(item), nextCursor: z.string().nullable(), unavailable: z.boolean().optional() })),
});

export type ProjectContentKind = z.infer<typeof kind>;
export type ProjectContentItem = z.infer<typeof item>;
export type ProjectContentSection = z.infer<typeof projectContentsSchema>["sections"][number];
export type ProjectContents = z.infer<typeof projectContentsSchema>;
