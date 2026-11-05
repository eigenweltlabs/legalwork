import { z } from "zod";

const field = z.string().min(1).max(200).refine(value => !["__proto__", "prototype", "constructor"].includes(value));
const value = z.json();
export const ViewOwnerSchema = z.object({ kind: z.enum(["wiki", "workspace"]), id: z.string().min(1).max(200) }).strict();
export const WikiDataQuerySchema = z.object({
  pageType: z.string().max(200).optional(),
  fields: z.array(field).min(1).max(20),
  filters: z.array(z.object({ field, op: z.enum(["eq", "ne", "contains", "in", "exists"]), value: value.optional() }).strict()).max(20).optional(),
  sort: z.array(z.object({ field, direction: z.enum(["asc", "desc"]) }).strict()).max(5).optional(),
  groupBy: field.optional(),
  metrics: z.array(z.object({ name: field, op: z.enum(["count", "sum", "avg", "min", "max"]), field: field.optional() }).strict()).max(10).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().max(300).optional(),
}).strict();
export const WikiDataResultSchema = z.object({
  rows: z.array(z.record(field, value)).max(1000),
  total: z.number().int().nonnegative(),
  revision: z.string().min(1).max(200),
  asOf: z.number().nonnegative(),
  truncated: z.boolean(),
  nextCursor: z.string().max(300).optional(),
  sources: z.array(z.object({ path: z.string().max(4096), revision: z.string().max(200) }).strict()).max(1000).optional(),
  sourceOwner: ViewOwnerSchema.optional(),
  /** Empty means the imported file's original server is unknown. Never rebind its links. */
  sourceServerUrl: z.string().max(4096).optional(),
}).strict();
export const ViewInputSchema = z.object({
  version: z.literal(1),
  title: z.string().trim().min(1).max(200),
  mode: z.enum(["report", "dashboard"]),
  catalog: z.literal("legalwork-1"),
  program: z.string().min(1).max(100_000),
  queries: z.record(field, WikiDataQuerySchema.omit({ cursor: true })).refine(queries => Object.keys(queries).length <= 20),
  datasets: z.record(field, WikiDataResultSchema).refine(datasets => Object.keys(datasets).length <= 20).optional(),
  /** Default source context for paths embedded directly in the program. */
  sourceOwner: ViewOwnerSchema.optional(),
  sourceServerUrl: z.string().max(4096).optional(),
  fallbackMarkdown: z.string().max(100_000).optional(),
}).strict();
/** Deliberate Assistant deliverables, confined to its own workspace. */
export const AssistantSaveReportSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/).describe("Stable report key, e.g. morning-briefing-2026-10-28. Reuse it on retries."),
  input: ViewInputSchema,
  baseRevision: z.string().min(1).max(200).optional().describe("Exact revision from view_read when updating a previously saved report."),
}).strict();

export const ViewSaveSourceSchema = z.object({ workspaceId: z.string().min(1).max(200), sessionId: z.string().min(1).max(200), callId: z.string().min(1).max(200) }).strict();
export type ViewSaveSource = z.infer<typeof ViewSaveSourceSchema>;
export const ViewSaveInputSchema = ViewInputSchema;
/** Owner is supplied by the authorized repository, never trusted from saved bytes. */
export const StoredViewSchema = ViewInputSchema.extend({ id: z.string().uuid(), updatedAt: z.number().nonnegative() });
export const ViewRecordSchema = StoredViewSchema.extend({ owner: ViewOwnerSchema, revision: z.string().min(1).max(200) });
export const WikiFieldsSchema = z.object({ fields: z.array(z.object({
  id: field, name: z.string(), type: z.enum(["string", "number", "boolean", "date", "array", "object", "mixed"]),
  values: z.array(value).max(50).optional(),
})) });
export type ViewOwner = z.infer<typeof ViewOwnerSchema>;
export type ViewInput = z.infer<typeof ViewInputSchema>;
export type ViewRecord = z.infer<typeof ViewRecordSchema>;
export type ViewSummary = Pick<ViewRecord, "id" | "title" | "mode" | "updatedAt" | "revision" | "owner"> & { path?: string };
export type ViewIssue = { path: string; id?: string; code: string; message: string };

export const isViewFile = (path: string) => /\.view\.json$/i.test(path);

/** A transfer freezes queries and preserves their origin; it never queries the destination. */
export function viewCopyInput(input: ViewInput, source?: { owner: ViewOwner; serverUrl?: string }, keepQueries = false): ViewInput {
  if (keepQueries && !source) return input;
  if (!keepQueries && Object.keys(input.queries).some(name => !input.datasets?.[name])) throw new Error("This live dashboard needs a data snapshot. Export it from LegalWork, then import that file.");
  return { ...input, sourceOwner: input.sourceOwner ?? source?.owner, sourceServerUrl: input.sourceServerUrl ?? source?.serverUrl ?? "", queries: keepQueries ? input.queries : {}, datasets: Object.fromEntries(Object.entries(input.datasets ?? {}).map(([name, data]) => [name, {
    ...data, sourceOwner: data.sourceOwner ?? input.sourceOwner ?? source?.owner,
    sourceServerUrl: data.sourceServerUrl ?? input.sourceServerUrl ?? source?.serverUrl ?? "",
  }])) };
}

/** Explicit imports are new files. Sync and restore paths must keep their original identity. */
export function copyViewFile(bytes: Uint8Array, source?: { owner: ViewOwner; serverUrl?: string }, keepQueries = false): Uint8Array {
  if (bytes.byteLength > 2 * 1024 * 1024) throw new Error("A dashboard file can contain up to 2 MB.");
  const { savedFrom: _legacy, ...raw } = z.object({ savedFrom: z.unknown().optional() }).passthrough().parse(JSON.parse(new TextDecoder().decode(bytes)));
  const { id: _id, updatedAt: _updatedAt, ...input } = StoredViewSchema.parse(raw);
  const copy = { ...viewCopyInput(input, source, keepQueries), id: crypto.randomUUID(), updatedAt: Date.now() };
  const result = new TextEncoder().encode(`${JSON.stringify(copy, null, 2)}\n`);
  if (result.byteLength > 2 * 1024 * 1024) throw new Error("A dashboard file can contain up to 2 MB.");
  return result;
}
export type WikiDataQuery = z.infer<typeof WikiDataQuerySchema>;
export type WikiDataResult = z.infer<typeof WikiDataResultSchema>;
export type WikiFields = z.infer<typeof WikiFieldsSchema>;

export const ViewGenerationChunkSchema = z.object({
  callId: z.string().min(1).max(200),
  tool: z.enum(["view_create", "view_update"]),
  raw: z.string().max(200_000),
}).strict();
export type ViewGenerationChunk = z.infer<typeof ViewGenerationChunkSchema>;

/** A completed generation in the chat; not a saved project/wiki file. */
export const ViewPreviewSchema = z.object({
  status: z.literal("preview"),
  owner: ViewOwnerSchema,
  input: ViewInputSchema,
  target: z.object({ viewId: z.string().uuid(), baseRevision: z.string().min(1).max(200) }).strict().optional(),
}).strict();
export type ViewPreview = z.infer<typeof ViewPreviewSchema>;
export type SessionViewPreview = { sessionId?: string; callId: string; title: string; preview?: ViewPreview };
export type SessionViewReview = { items: SessionViewPreview[]; reviewToken: string };


export type ViewReference = { owner: ViewOwner; viewId: string };
export function parseViewReference(source: string, owner?: ViewOwner): ViewReference | null {
  const value = source.trim();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (owner && uuid.test(value)) return { owner, viewId: value };
  const match = /^(?:legalwork-view:\/\/)?(wiki|workspace)(?::|\/)([^/\s]+)\/([^/\s]+)$/.exec(value);
  if (!match || !uuid.test(match[3])) return null;
  try {
    const parsed = ViewOwnerSchema.safeParse({ kind: match[1], id: decodeURIComponent(match[2]) });
    return parsed.success ? { owner: parsed.data, viewId: match[3] } : null;
  } catch { return null; }
}
export function viewReferenceKey(reference: ViewReference) { return `legalwork-view://${reference.owner.kind}/${encodeURIComponent(reference.owner.id)}/${reference.viewId}`; }
export const WikiViewSnapshotsSchema = z.record(z.string(), ViewInputSchema);
export type WikiViewSnapshots = z.infer<typeof WikiViewSnapshotsSchema>;
