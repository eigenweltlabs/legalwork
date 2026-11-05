import type { WikiViewSnapshots } from "./views.js";
/** Wiki content and configuration live in Markdown; these are API projections. */
export type WikiPageReference = { wikiId: string; path: string };

/** App-owned source references retain wiki identity when cited from projects. */
export function wikiPageUrl(wikiId: string, path: string): string {
  return `legalwork-wiki://${encodeURIComponent(wikiId)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function parseWikiPageUrl(value: string): WikiPageReference | null {
  const match = /^legalwork-wiki:\/\/([^/]+)\/(.+)$/.exec(value.trim());
  if (!match) return null;
  try {
    const wikiId = decodeURIComponent(match[1]);
    const path = decodeURIComponent(match[2]);
    if (!wikiId || /[/\\\s\x00-\x1f]/.test(wikiId) || path.length > 4096 || /[\\\x00-\x1f]/.test(path) || !/\.md$/i.test(path) || path.split("/").some(part => !part || part === "." || part === "..")) return null;
    return { wikiId, path };
  } catch { return null; }
}

export type WikiValue = string | number | boolean | null | WikiValue[] | { [key: string]: WikiValue };

/** Kept so older registrations remain readable while their sharing is upgraded. */
export type WikiLegacySyncSettings = { workspaceId: string; connectionId: string; path: string };
export type WikiTeamSyncSettings = { kind: "team"; wikiId: string; orgId: string };
export type WikiSyncSettings = WikiTeamSyncSettings | WikiLegacySyncSettings;
export type WikiSharingInput = { access: "org" | "members"; memberIds: string[] };
export type WikiTeamRecord = WikiSharingInput & {
  id: string;
  name: string;
  ownerUserId: string;
  role: "owner" | "member";
  createdAt: string;
  updatedAt: string;
};
export type WikiTeamMember = { userId: string; name: string | null; email: string | null; role: string };
export type WikiTeamOverview = { orgId: string; userId: string; orgName: string | null; items: WikiTeamRecord[]; members: WikiTeamMember[] };
export type WikiSyncStatus = {
  state: "local" | "idle" | "syncing" | "error";
  lastSyncedAt: number | null;
  error: string | null;
  conflicts: string[];
};
export type WikiRegistration = {
  id: string;
  name: string;
  /** Knowledge-base purpose, independent of its title or creation entry point. */
  purpose?: "legal-research";
  root: string;
  workspaceId: string;
  allowInProjects: boolean;
  /** Requires review for project contributions. The generated research wiki defaults to false. */
  requireAgentApproval?: boolean;
  /** Omitted/null permits all projects; an array restricts project tool access. */
  projectWorkspaceIds?: string[] | null;
  sync: WikiSyncSettings | null;
};
export type WikiVault = WikiRegistration & {
  /** True when files use this host's default managed wiki folder. */
  isDefaultLocation?: boolean;
  writable: boolean;
  pageCount: number;
  totalBytes: number;
  syncStatus: WikiSyncStatus;
  /** Fresh, server-authorized sharing information; absent while unavailable. */
  sharing?: WikiTeamRecord | null;
  /** Audience of an incomplete sharing request, for a safe retry. */
  pendingSharing?: WikiSharingInput | null;
};
export type DeletedWiki = { wiki: WikiRegistration; deletedAt: number };
export type WikiLink = { target: string; label: string; property: string | null; resolved: boolean };
/** Graph projection with indexed page properties; page bodies and excerpts stay on the server. */
export type WikiGraphNode = { id: string; path: string; title: string; type: string; properties?: Record<string, WikiValue> };
export type WikiGraphEdge = { id: string; source: string; target: string; relation: string | null };
export type WikiGraphData = { revision: string; nodes: WikiGraphNode[]; edges: WikiGraphEdge[] };
export type WikiGraphResponse =
  | (WikiGraphData & { kind: "snapshot" })
  | (WikiGraphData & { kind: "delta"; baseRevision: string; removedNodes: string[]; removedEdges: string[] })
  | { kind: "unchanged"; revision: string };
export type WikiPage = {
  path: string;
  title: string;
  type: string;
  properties: Record<string, WikiValue>;
  links: WikiLink[];
  excerpt: string;
  revision: string;
  updatedAt: number;
};
export type WikiAsset = { path: string; size: number; updatedAt: number; changedAt?: number };
export type WikiEntry = { path: string; kind: "file" | "folder"; revision: string };
export type WikiTrashEntry = { id: string; path: string; kind: "file" | "folder"; deletedAt: number };
export type WikiEntryOperation =
  | { action: "create-folder"; path: string }
  | { action: "move" | "copy"; path: string; destination: string; baseRevision: string }
  | { action: "trash"; path: string; baseRevision: string }
  | { action: "restore"; trashId: string };
export type WikiSnapshot = {
  wiki: WikiVault;
  pages: WikiPage[];
  assets: WikiAsset[];
  folders?: string[];
  warnings: string[];
};
export type WikiDocument = {
  viewSnapshots?: WikiViewSnapshots;
  path: string; content: string; revision: string; updatedAt: number;
};
export type WikiRevision = { id: string; path: string; createdAt: number; action: "write" | "delete" | "restore"; size: number; changes?: import("./line-diff.js").LineChanges | null };
export type WikiStarterTemplate = "firm" | "blank" | "legal-research";
export type WikiCreateInput = {
  name: string;
  root?: string;
  template?: WikiStarterTemplate;
  /** Language and initial jurisdiction for the legal research starter. */
  language?: "en" | "de";
  country?: string;
  /** Attach an existing folder without seeding local starter content. */
  attach?: boolean;
  sync?: WikiSyncSettings | null;
  sharing?: WikiSharingInput;
};
export type WikiUpdateInput = { name?: string; allowInProjects?: boolean; requireAgentApproval?: boolean; projectWorkspaceIds?: string[] | null; sync?: WikiSyncSettings | null };
