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

export type ProjectDetails = {
  version: 1;
  revision: number;
  fields: ProjectField[];
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
