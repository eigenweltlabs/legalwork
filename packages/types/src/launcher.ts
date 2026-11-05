import { projectFileSourceSchema } from "@legalwork/types/project-files";
import { z } from "zod";
import { queueInputSchema } from "@legalwork/types/session-queue";

/** Search categories the launcher can scope to. `f Mietvertrag` is files, `p Müller` projects, and so on. */
export const LAUNCHER_SEARCH_KINDS = ["files", "projects", "chats", "tasks", "recordings"] as const;
export const LauncherSearchKindSchema = z.enum(LAUNCHER_SEARCH_KINDS);
export type LauncherSearchKind = z.infer<typeof LauncherSearchKindSchema>;
export const LauncherSearchFolderSchema = z.object({ id: z.string(), name: z.string(), path: z.string(), createdAt: z.number() });
export type LauncherSearchFolder = z.infer<typeof LauncherSearchFolderSchema>;
export const DEFAULT_LAUNCHER_ALIASES: Record<LauncherSearchKind, string> = { files: "f", projects: "p", chats: "c", tasks: "t", recordings: "r" };

export const LauncherCoverageSchema = z.enum(["complete", "partial", "filename-only", "indexing", "searching", "unavailable", "offline"]);
export type LauncherCoverage = z.infer<typeof LauncherCoverageSchema>;
export const LauncherResultActionSchema = z.enum(["open", "reveal", "open-external", "attach", "ask", "compare", "summarize", "copy-path", "copy-reference", "pin", "complete", "play", "resume", "hand-to-assistant", "copy-to-project", "move-to-project"]);
export type LauncherResultAction = z.infer<typeof LauncherResultActionSchema>;
export const LauncherMatchSchema = z.enum(["exact", "prefix", "word", "substring", "fuzzy", "content", "metadata", "recent"]);
export const LauncherSearchResultSchema = z.object({
  id: z.string(), kind: LauncherSearchKindSchema, workspaceId: z.string().nullable(), sourceId: z.string(), title: z.string(),
  subtitle: z.string().optional(), path: z.string().optional(), folderId: z.string().optional(), excerpt: z.string().optional(), updatedAt: z.number(), revision: z.string().optional(),
  sourceKind: z.enum(["project", "wiki", "folder"]).optional(),
  fileType: z.string().optional(), size: z.number().optional(), completed: z.boolean().optional(), status: z.string().optional(), dueDate: z.string().nullable().optional(),
  sessionId: z.string().optional(), messageId: z.string().optional(), durationMs: z.number().optional(), incomplete: z.boolean().optional(),
  match: LauncherMatchSchema, score: z.number(), actions: z.array(LauncherResultActionSchema),
  sources: z.array(z.object({ path: z.string(), hash: z.string(), page: z.number().nullable(), source: z.enum(["native", "ocr"]), quote: z.string(), preparationPath: z.string().optional() })).optional(),
});
export type LauncherSearchResult = z.infer<typeof LauncherSearchResultSchema>;
/** Saved dashboard definitions are app metadata, not user documents in the launcher. */
export function isLauncherInternalPath(path: string) {
  return path.split(/[\\/]/).some(part => part.startsWith(".")) || /\.view(?:\.conflict-[^.]+)?\.json$/i.test(path);
}
export const LauncherSourceStateSchema = z.object({
  id: z.string(), kind: LauncherSearchKindSchema, workspaceId: z.string().nullable(), label: z.string(), coverage: LauncherCoverageSchema,
  count: z.number(), limited: z.boolean().optional(), preparing: z.number().optional(), error: z.string().optional(),
});
export type LauncherSourceState = z.infer<typeof LauncherSourceStateSchema>;
export const LauncherSearchResponseSchema = z.object({ items: z.array(LauncherSearchResultSchema), sources: z.array(LauncherSourceStateSchema), unavailable: z.array(z.string()) });
export type LauncherSearchResponse = z.infer<typeof LauncherSearchResponseSchema>;

/** One Assistant conversation. Daily sessions from the first Assistant version stay readable as `day:YYYY-MM-DD`. */
export const AssistantConversationSchema = z.object({
  id: z.string(), workspaceId: z.string(), sessionId: z.string(), title: z.string(), kind: z.enum(["conversation", "day"]), date: z.string().nullable(),
  createdAt: z.number(), updatedAt: z.number(), pinned: z.boolean(), archivedAt: z.number().nullable(), origin: z.string().nullable(),
});
export type AssistantConversation = z.infer<typeof AssistantConversationSchema>;
export const AssistantConversationPageSchema = z.object({ items: z.array(AssistantConversationSchema), nextCursor: z.string().nullable() });
export type AssistantConversationPage = z.infer<typeof AssistantConversationPageSchema>;
export const AssistantConversationPatchSchema = z.object({ title: z.string().trim().min(1).max(160).optional(), pinned: z.boolean().optional(), archived: z.boolean().optional() }).strict();

/** Where captured material came from. Never an instruction source. */
const contextBase = { id: z.string().min(1).max(100) };
export const AssistantContextItemSchema = z.discriminatedUnion("type", [
  z.object({ ...contextBase, type: z.literal("task"), taskId: z.string().regex(/^[\w-]+$/).max(100), workspaceId: z.string().nullable(), title: z.string().max(400) }),
  z.object({ ...contextBase, type: z.literal("selection"), text: z.string().max(200_000), sourceApp: z.string().max(200).nullable(), sourceWindow: z.string().max(400).nullable(), capturedAt: z.number() }),
  z.object({ ...contextBase, type: z.literal("clipboard"), text: z.string().max(200_000), capturedAt: z.number() }),
  z.object({ ...contextBase, type: z.literal("file"), workspaceId: z.string().nullable(), path: z.string().max(4096), name: z.string().max(400), revision: z.string().nullable(), sourceLabel: z.string().max(200).nullable() }),
  z.object({ ...contextBase, type: z.literal("image"), workspaceId: z.string().optional(), name: z.string().max(400), capture: z.enum(["window", "region", "file"]), sourceApp: z.string().max(200).nullable(), sourceWindow: z.string().max(400).nullable(), capturedAt: z.number(), path: z.string().max(4096).nullable() }),
]);
export type AssistantContextItem = z.infer<typeof AssistantContextItemSchema>;
export const AssistantExecutionTargetSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("assistant") }), z.object({ kind: z.literal("project"), workspaceId: z.string().min(1) })]);
export type AssistantExecutionTarget = z.infer<typeof AssistantExecutionTargetSchema>;
export const LauncherWorkspaceContextSchema = z.object({
  workspaceId: z.string().max(200), workspaceName: z.string().max(400), paneId: z.string().max(200).optional(),
  folder: z.string().max(4096).optional(), sessionId: z.string().max(200).optional(),
  document: z.object({ workspaceId: z.string().max(200), path: z.string().max(4096), name: z.string().max(400), revision: z.string().nullable().optional() }).optional(),
  selection: z.string().max(200_000).optional(), capturedAt: z.number(),
});
export type LauncherWorkspaceContext = z.infer<typeof LauncherWorkspaceContextSchema>;
/** Frozen when a request is submitted. Later scope changes never rewrite a running job. */
export const AssistantContextEnvelopeSchema = z.object({ items: z.array(AssistantContextItemSchema).max(50), workspaceContext: LauncherWorkspaceContextSchema.optional(), target: AssistantExecutionTargetSchema, searchScope: z.string().nullable(), capturedAt: z.number() });
export type AssistantContextEnvelope = z.infer<typeof AssistantContextEnvelopeSchema>;

export const AssistantSubmissionStateSchema = z.enum(["sending", "accepted", "running", "completed", "failed", "unconfirmed"]);
export type AssistantSubmissionState = z.infer<typeof AssistantSubmissionStateSchema>;
export const AssistantSubmissionSchema = z.object({
  requestId: z.string(), messageId: z.string(), conversationId: z.string(), workspaceId: z.string(), sessionId: z.string(),
  state: AssistantSubmissionStateSchema, createdAt: z.number(), updatedAt: z.number(), error: z.string().nullable(), preview: z.string(), target: AssistantExecutionTargetSchema,
});
export type AssistantSubmission = z.infer<typeof AssistantSubmissionSchema>;
export const AssistantSubmissionPartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), synthetic: z.boolean().optional(), ignored: z.boolean().optional(), metadata: z.record(z.string(), z.unknown()).optional() }),
  z.object({ type: z.literal("file"), mime: z.string(), filename: z.string().optional(), url: z.string() }),
  z.object({ type: z.literal("agent"), name: z.string() }),
  z.object({ type: z.literal("skill"), id: z.string() }),
]);
export const AssistantSubmitInputSchema = z.object({
  requestId: z.string().min(8).max(100), messageId: z.string().regex(/^msg_[A-Za-z0-9]{10,60}$/), text: z.string().max(60_000),
  context: AssistantContextEnvelopeSchema.optional(), model: z.object({ providerID: z.string().min(1), modelID: z.string().min(1) }).optional(),
  agent: z.string().max(60).optional(), variant: z.string().max(60).optional(),
  command: z.object({ name: z.string().min(1).max(120), arguments: z.string().max(60000) }).optional(),
  parts: z.array(AssistantSubmissionPartSchema).max(100).optional(),
  queue: queueInputSchema.omit({ execution: true, messageId: true }).optional(),
});
export type AssistantSubmitInput = z.infer<typeof AssistantSubmitInputSchema>;

export const AssistantWorkStatusSchema = z.enum(["queued", "running", "returned", "input-required", "failed", "stopped", "unavailable"]);
export type AssistantWorkStatus = z.infer<typeof AssistantWorkStatusSchema>;
export const AssistantWorkItemSchema = z.object({
  id: z.string(), workspaceId: z.string(), sessionId: z.string(), projectName: z.string(), title: z.string(), scope: z.string(), status: AssistantWorkStatusSchema,
  originConversationId: z.string().nullable(), originSessionId: z.string(), createdAt: z.number().nullable(), updatedAt: z.number().nullable(),
  pendingAttention: z.number(), queuedMessages: z.number(),
  result: z.object({ outcome: z.enum(["reply", "interrupted", "failed", "input-required"]), preview: z.string(), messageId: z.string() }).nullable(),
});
export type AssistantWorkItem = z.infer<typeof AssistantWorkItemSchema>;

export const LauncherActionKindSchema = z.enum(["navigation", "native", "agent"]);
export type LauncherActionKind = z.infer<typeof LauncherActionKindSchema>;
export const LauncherActionInputSchema = z.enum(["selection", "files", "clipboard", "arguments"]);
export type LauncherActionInput = z.infer<typeof LauncherActionInputSchema>;
export const LauncherActionOutputSchema = z.enum(["preview", "copy", "save", "insert", "open"]);
export type LauncherActionOutput = z.infer<typeof LauncherActionOutputSchema>;
export const LauncherActionTargetSchema = z.enum(["assistant", "project", "none"]);
export type LauncherActionTarget = z.infer<typeof LauncherActionTargetSchema>;
/** A user-saved action: a named prompt with declared inputs and a declared output policy. */
export const QuickActionInputSchema = z.object({
  name: z.string().trim().min(1).max(80), alias: z.string().trim().max(24).regex(/^[a-z0-9-]*$/), shortcut: z.string().max(60).nullable(),
  prompt: z.string().trim().min(1).max(8000), skill: z.string().max(120).nullable(), command: z.string().max(120).nullable(),
  requires: z.array(LauncherActionInputSchema).max(4), output: LauncherActionOutputSchema, target: LauncherActionTargetSchema, projectId: z.string().nullable(), favorite: z.boolean(),
});
export type QuickActionInput = z.infer<typeof QuickActionInputSchema>;
export const QuickActionSchema = QuickActionInputSchema.extend({ id: z.string(), createdAt: z.number(), updatedAt: z.number(), usedAt: z.number().nullable(), uses: z.number() });
export type QuickAction = z.infer<typeof QuickActionSchema>;
/** A saved search keeps its scope visible: the category, the project and the words. */
export const SavedSearchInputSchema = z.object({ name: z.string().trim().min(1).max(80), query: z.string().trim().max(300), kind: LauncherSearchKindSchema.nullable(), projectId: z.string().max(200).nullable(),
  fileTypes: z.array(z.string().regex(/^[a-z0-9]{1,8}$/)).max(20).nullable().optional(), modifiedAfter: z.number().nullable().optional() });
export type SavedSearchInput = z.infer<typeof SavedSearchInputSchema>;
export const SavedSearchSchema = SavedSearchInputSchema.extend({ id: z.string(), createdAt: z.number(), updatedAt: z.number(), usedAt: z.number().nullable(), uses: z.number() });
export type SavedSearch = z.infer<typeof SavedSearchSchema>;
export const LauncherCatalogEntrySchema = z.object({
  id: z.string(), label: z.string(), description: z.string().nullable(), aliases: z.array(z.string()), kind: LauncherActionKindSchema,
  source: z.enum(["app", "command", "skill", "quick-action", "saved-search"]), requires: z.array(LauncherActionInputSchema), target: LauncherActionTargetSchema,
  outputs: z.array(LauncherActionOutputSchema), workspaceId: z.string().nullable(), shortcut: z.string().nullable(), favorite: z.boolean(), usedAt: z.number().nullable(),
  command: z.object({ name: z.string(), template: z.string().nullable(), agent: z.string().nullable() }).nullable(), quickAction: QuickActionSchema.nullable(), savedSearch: SavedSearchSchema.optional(),
});
/** File finder filters: extensions and a modification floor. They narrow files only and stay visible as chips. */
export const LauncherFileFilterSchema = z.object({ types: z.array(z.string().regex(/^[a-z0-9]{1,8}$/)).max(20).nullable(), modifiedAfter: z.number().nullable() });
export type LauncherFileFilter = z.infer<typeof LauncherFileFilterSchema>;
/** Copy or move one file into another project. Explicit, approved and audited like the file routes; never a side effect of opening. */
export const LauncherFileTransferInputSchema = z.object({ sourceWorkspaceId: z.string().min(1), targetWorkspaceId: z.string().min(1), path: z.string().min(1).max(4096), mode: z.enum(["copy", "move"]), folder: z.string().max(1024).optional() });
export type LauncherFileTransferInput = z.infer<typeof LauncherFileTransferInputSchema>;
/** A read-only look at one result. Reading a preview never submits anything to a model. */
export const LauncherPreviewSchema = z.object({
  kind: LauncherSearchKindSchema, id: z.string(), title: z.string(), meta: z.array(z.string()), text: z.string(), truncated: z.boolean(),
  source: z.enum(["text", "prepared", "messages", "transcript", "metadata"]), updatedAt: z.number().nullable(),
});
export type LauncherPreview = z.infer<typeof LauncherPreviewSchema>;
export type LauncherCatalogEntry = z.infer<typeof LauncherCatalogEntrySchema>;

/** One entry into the shared dispatcher: shortcut, companion, Home, tray, Raycast or a deep link. */
export const LauncherInvocationActionSchema = z.enum(["open", "search", "files", "projects", "chats", "tasks", "recordings", "ask", "speak", "dictate", "record", "capture-region", "capture-window", "quick-action", "work", "new-conversation", "resume"]);
export type LauncherInvocationAction = z.infer<typeof LauncherInvocationActionSchema>;
export const LauncherInvocationSourceSchema = z.enum(["shortcut", "hud", "home", "raycast", "deep-link", "tray", "test"]);
/** Snapshot of the focused workpane, captured before the launcher takes focus. */
export const LauncherInvocationSchema = z.object({
  id: z.string().min(1).max(100), action: LauncherInvocationActionSchema, query: z.string().max(2000).optional(), conversationId: z.string().max(100).optional(),
  projectId: z.string().max(200).optional(), actionId: z.string().max(200).optional(), contextId: z.string().max(100).optional(), source: LauncherInvocationSourceSchema,
  workspaceContext: LauncherWorkspaceContextSchema.optional(),
  captureSelection: z.literal(true).optional(),
});
export type LauncherInvocation = z.infer<typeof LauncherInvocationSchema>;
export const LauncherStagedContextSchema = z.object({ id: z.string(), items: z.array(AssistantContextItemSchema).max(20), source: LauncherInvocationSourceSchema, createdAt: z.number(), expiresAt: z.number() });
export type LauncherStagedContext = z.infer<typeof LauncherStagedContextSchema>;

/** Desktop-side preferences, persisted beside the dictation settings. */
export const LauncherSettingsSchema = z.object({
  shortcut: z.string().max(60), backgroundPresence: z.boolean(), autostart: z.boolean(), companion: z.boolean(), companionBadge: z.boolean(),
  aliases: z.record(LauncherSearchKindSchema, z.string().regex(/^[a-z0-9]{1,3}$/)),
  actionShortcuts: z.record(z.string(), z.string().max(60)), pinned: z.boolean(), rememberPosition: z.boolean(),
});
export type LauncherSettings = z.infer<typeof LauncherSettingsSchema>;
export const DEFAULT_LAUNCHER_SETTINGS: LauncherSettings = {
  shortcut: "CommandOrControl+Shift+Space", backgroundPresence: false, autostart: false, companion: false, companionBadge: true,
  aliases: { ...DEFAULT_LAUNCHER_ALIASES }, actionShortcuts: {}, pinned: false, rememberPosition: true,
};

/** The external app/window the launcher was invoked over. Native identifiers stay on the desktop. */
export const LauncherOriginSchema = z.object({
  id: z.string(), app: z.string().nullable(), window: z.string().nullable(), bundleId: z.string().nullable(), pid: z.number().nullable(), capturedAt: z.number(),
  supportsSelection: z.boolean(), supportsInsert: z.boolean(), platform: z.enum(["darwin", "windows", "linux"]),
});
export type LauncherOrigin = z.infer<typeof LauncherOriginSchema>;
export const LauncherSelectionResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), text: z.string(), origin: LauncherOriginSchema }),
  z.object({ ok: z.literal(false), reason: z.enum(["no-origin", "unsupported", "empty", "changed", "denied", "failed"]), message: z.string(), origin: LauncherOriginSchema.nullable() }),
]);
export type LauncherSelectionResult = z.infer<typeof LauncherSelectionResultSchema>;
export const LauncherInsertResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), method: z.enum(["paste", "copy"]), origin: LauncherOriginSchema }),
  z.object({ ok: z.literal(false), reason: z.enum(["no-origin", "changed", "unavailable", "denied", "failed"]), message: z.string(), copied: z.boolean(), origin: LauncherOriginSchema.nullable() }),
]);
export type LauncherInsertResult = z.infer<typeof LauncherInsertResultSchema>;
export const LauncherCaptureSchema = z.object({
  dataUrl: z.string(), width: z.number(), height: z.number(), capture: z.enum(["window", "region"]), sourceApp: z.string().nullable(), sourceWindow: z.string().nullable(), capturedAt: z.number(),
});
export type LauncherCapture = z.infer<typeof LauncherCaptureSchema>;
export const LauncherCaptureResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), capture: LauncherCaptureSchema }),
  z.object({ ok: z.literal(false), reason: z.enum(["cancelled", "denied", "unsupported", "failed"]), message: z.string() }),
]);
export type LauncherCaptureResult = z.infer<typeof LauncherCaptureResultSchema>;

/** Persisted full drafts with editor leases, shared by the panel and Home through the desktop store. */
export const LauncherDraftSchema = z.object({
  conversationId: z.string(), revision: z.number(), text: z.string(), context: z.array(AssistantContextItemSchema), target: AssistantExecutionTargetSchema,
  searchScope: z.string().nullable(), pendingTranscription: z.string().nullable(), model: z.object({ providerID: z.string(), modelID: z.string() }).nullable(), variant: z.string().nullable(),
  submission: z.object({ requestId: z.string(), messageId: z.string(), state: z.string(), input: AssistantSubmitInputSchema.optional(), draftSnapshot: z.object({ text: z.string(), context: z.array(AssistantContextItemSchema) }).optional() }).nullable(), updatedAt: z.number(),
  composer: z.object({ mentions: z.record(z.string(), z.enum(["agent", "file", "memory", "upload", "storage", "app", "task", "review", "calendar", "plugin", "integration"])), pasteParts: z.array(z.object({ id: z.string(), label: z.string(), text: z.string(), lines: z.number() })) }).optional(),
});
export type LauncherDraft = z.infer<typeof LauncherDraftSchema>;
export const DraftLeaseSchema = z.object({ conversationId: z.string(), owner: z.string(), revision: z.number(), since: z.number(), pending: z.boolean().optional() });
export type DraftLease = z.infer<typeof DraftLeaseSchema>;
export const LauncherDraftFileSchema = z.object({ version: z.number().int().nonnegative().default(0), drafts: z.record(z.string(), LauncherDraftSchema), leases: z.record(z.string(), DraftLeaseSchema) });
export type LauncherDraftFile = z.infer<typeof LauncherDraftFileSchema>;

export const AssistantOutputSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("pending"), requestId: z.string(), messageId: z.string(), conversationId: z.string() }),
  z.object({ state: z.literal("ready"), requestId: z.string(), messageId: z.string(), conversationId: z.string(), text: z.string() }),
  z.object({ state: z.literal("failed"), requestId: z.string(), messageId: z.string(), conversationId: z.string(), error: z.string() }),
]);
export type AssistantOutput = z.infer<typeof AssistantOutputSchema>;
export type LauncherOutputIntent = { requestId: string; messageId: string; conversationId: string; output: "copy" | "insert"; originId: string | null };
export type LauncherOutputTask = LauncherOutputIntent & {
  createdAt: number; updatedAt: number; state: "waiting" | "delivering" | "done" | "failed" | "cancelled";
  text?: string; error?: string; result?: "copied" | "inserted" | "recovered";
};

export const LauncherWindowStateSchema = z.object({ visible: z.boolean(), pinned: z.boolean(), focused: z.boolean(), displayId: z.number().nullable(), moved: z.boolean() });
export type LauncherWindowState = z.infer<typeof LauncherWindowStateSchema>;
export const LauncherShortcutConflictSchema = z.object({ id: z.string(), accelerator: z.string(), reason: z.enum(["duplicate", "dictation", "registration-failed"]) });
export type LauncherShortcutConflict = z.infer<typeof LauncherShortcutConflictSchema>;
/** A host approval shown in the panel: the request as the host states it, never as the model describes it. */
export const LauncherApprovalRequestSchema = z.object({ id: z.string(), source: z.string(), scope: z.string().nullable(), workspaceId: z.string(), action: z.string(), summary: z.string(), paths: z.array(z.string()) });
export type LauncherApprovalRequest = z.infer<typeof LauncherApprovalRequestSchema>;
/** Who owns the microphone right now: external dictation, a meeting, or a composer in another LegalWork window. */
export const LauncherVoiceStateSchema = z.object({ externalDictation: z.boolean(), meeting: z.boolean(), composer: z.boolean() });
export type LauncherVoiceState = z.infer<typeof LauncherVoiceStateSchema>;
export const LauncherDesktopStatusSchema = LauncherSettingsSchema.extend({
  shortcutRegistered: z.boolean(), conflicts: z.array(LauncherShortcutConflictSchema), autostartRequiresApproval: z.boolean(), raycastPairing: z.object({ enabled: z.boolean(), path: z.string().nullable() }),
  platform: z.enum(["darwin", "windows", "linux"]), capabilities: z.object({ selection: z.boolean(), insert: z.boolean(), windowCapture: z.boolean(), regionCapture: z.boolean(), origin: z.boolean() }),
  /** Live capture ownership on the desktop: external dictation and meeting recording block a second microphone owner. */
  voice: LauncherVoiceStateSchema,
});
export type LauncherDesktopStatus = z.infer<typeof LauncherDesktopStatusSchema>;
/** Events the desktop pushes into the panel renderer; the renderer validates them before acting. */
export const LauncherDesktopEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("invocation"), invocation: LauncherInvocationSchema }),
  z.object({ type: z.literal("visibility"), visible: z.boolean(), pinned: z.boolean() }),
  z.object({ type: z.literal("position"), moved: z.boolean() }),
  z.object({ type: z.literal("origin"), origin: LauncherOriginSchema.nullable() }),
  z.object({ type: z.literal("attention"), count: z.number() }),
  z.object({ type: z.literal("approval"), request: LauncherApprovalRequestSchema }),
  z.object({ type: z.literal("approval-closed"), id: z.string() }),
  z.object({ type: z.literal("voice"), voice: LauncherVoiceStateSchema }),
]);
export type LauncherDesktopEvent = z.infer<typeof LauncherDesktopEventSchema>;

export const launcherOpenSchema = z.object({
  source: projectFileSourceSchema, destination: z.string().min(1), paneId: z.string().optional(),
});
