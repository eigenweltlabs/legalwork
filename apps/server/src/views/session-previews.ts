import { withViewSaveSources, type SavedSessionView } from "./save-source.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { ViewPreview, ViewRecord, SessionViewPreview, SessionViewReview } from "@legalwork/types/views";
import { ViewPreviewSchema } from "./schema.js";
import type { ServerConfig } from "../types.js";
import { WikiStore } from "../wiki/store.js";
import { ViewRepository, workspaceViewFiles } from "./repository.js";

const toolSchema = z.object({ type: z.literal("tool"), name: z.enum(["view_create", "view_update"]), id: z.string(), state: z.object({
  status: z.literal("completed"), content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()), metadata: z.record(z.string(), z.unknown()).optional(),
}) });
const messagesSchema = z.array(z.object({ type: z.string(), content: z.array(z.unknown()).optional() }).passthrough());
export function sessionViewPreviews(messages: unknown): SessionViewPreview[] {
  const result: SessionViewPreview[] = [];
  for (const message of messagesSchema.parse(messages)) {
    if (message.type !== "assistant") continue;
    for (const raw of message.content ?? []) {
      const part = toolSchema.safeParse(raw);
      if (!part.success) continue;
      const { id: callId, state } = part.data;
      let value: unknown = state.metadata?.legalworkViewPreview ?? state.content.flatMap(item => item.type === "text" && item.text ? [item.text] : []).join("\n");
      if (typeof value === "string") {
        try { value = JSON.parse(value.replace(/(?:\n\n<system-reminder topic="[^"\r\n]+">\n[\s\S]*?\n<\/system-reminder>)+\s*$/u, "")); } catch { value = null; }
      }
      const preview = ViewPreviewSchema.safeParse(value);
      if (preview.success) result.push({ callId, title: preview.data.input.title, preview: preview.data });
      else if (state.metadata?.truncated === true) result.push({ callId, title: "Dashboard preview (content unavailable)" });
    }
  }
  return result;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Older saved files predate provenance. Recognize an exact independent copy too. */
export function savedViewMatchesPreview(view: ViewRecord, preview: ViewPreview): boolean {
  const input = preview.input;
  if (view.program !== input.program || view.title !== input.title || view.mode !== input.mode || view.catalog !== input.catalog || view.fallbackMarkdown !== input.fallbackMarkdown) return false;
  if (view.owner.kind === preview.owner.kind && view.owner.id === preview.owner.id && canonical(view.queries) === canonical(input.queries)) {
    // Only live bindings can be regenerated. Static bindings still need a saved copy.
    const retained = (datasets: ViewRecord["datasets"]) => Object.fromEntries(Object.entries(datasets ?? {}).filter(([name]) => input.mode !== "dashboard" || !Object.hasOwn(input.queries, name)));
    return canonical(retained(view.datasets)) === canonical(retained(input.datasets));
  }
  const datasets = Object.fromEntries(Object.entries(input.datasets ?? {}).map(([name, dataset]) => [name, { ...dataset, sourceOwner: dataset.sourceOwner ?? preview.owner }]));
  return Object.keys(view.queries).length === 0 && canonical(view.datasets ?? {}) === canonical(datasets);
}
export function reviewSessionViews(items: SessionViewPreview[], saved: SavedSessionView[], workspaceId: string, sessionId: string): SessionViewReview {
  const pending = items.filter(item => !saved.some(view => view.savedFrom?.workspaceId === workspaceId && view.savedFrom.sessionId === (item.sessionId ?? sessionId) && view.savedFrom.callId === item.callId || item.preview && savedViewMatchesPreview(view, item.preview)));
  return { items: pending, reviewToken: createHash("sha256").update(JSON.stringify(pending)).digest("hex") };
}
/** Read actual saved files; browser caches and receipts cannot hide removed copies. */
export async function savedSessionViews(config: ServerConfig): Promise<SavedSessionView[]> {
  const store = new WikiStore(config);
  try {
    const wikis = await store.list();
    const repositories = [
      ...wikis.map(wiki => new ViewRepository({ kind: "wiki", id: wiki.id }, { list: async () => (await store.files(wiki.id)).map(file => file.path), read: path => store.readAsset(wiki.id, path), write: async () => { throw new Error("Read only"); } })),
      ...config.workspaces.filter(workspace => !wikis.some(wiki => wiki.workspaceId === workspace.id)).map(workspace => new ViewRepository({ kind: "workspace", id: workspace.id }, workspaceViewFiles(workspace.path))),
    ];
    const records: ViewRecord[] = [];
    for (const repository of repositories) {
      // An inaccessible destination is not proof that a copy survives deletion.
      records.push(...await repository.readAll().catch(() => []));
    }
    return await withViewSaveSources(config, records);
  } finally { await store.close(); }
}
