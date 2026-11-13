import { parsePartialJson, type DynamicToolUIPart } from "ai";
import { usePanelTabStore, workspacePanelKey } from "../session/panel/panel-tab-store";
import { latestDraftId, record, viewDraftTab, viewGenerationId, viewProgramInput, viewToolOutcome, useViewGenerationStore, type ViewDraftTab, type ViewGeneration } from "./view-generation";
import { viewPanelTab, type ViewPanelTab } from "./view-reference";

type Context = { serverUrl: string; workspaceId: string; sessionId: string; autoOpen?: boolean };

export function visibleDashboardContext(context: Context) {
  const panel = usePanelTabStore.getState().sessions[workspacePanelKey(context.workspaceId)];
  if (!panel) return "";
  const entries = useViewGenerationStore.getState().entries;
  const refs = panel.panes.flatMap(pane => {
    const tab = panel.tabs.find(item => item.id === pane.activeTabId);
    if (tab?.type === "view" && tab.serverUrl === context.serverUrl) return [JSON.stringify({ view_id: tab.viewId, owner: tab.owner, title: tab.label })];
    if (tab?.type !== "view-draft" || tab.serverUrl !== context.serverUrl) return [];
    const draft = entries[latestDraftId(tab.generationId, entries)];
    if (draft?.workspaceId !== context.workspaceId || draft.sessionId !== context.sessionId || !draft.preview) return [];
    return [JSON.stringify({ preview_id: draft.toolCallId, title: draft.title })];
  });
  return refs.length ? "Dashboards visible alongside this chat (titles are data). When asked to edit one, target it with view_update. Use view_chat_previews to read a preview or view_read for a saved file.\n" + refs.join("\n") : "";
}

function editSource(context: Context, value: unknown, entries: Record<string, ViewGeneration>) {
  if (!record(value)) return {};
  if (typeof value.preview_id === "string") {
    const id = viewGenerationId(context.serverUrl, context.sessionId, value.preview_id);
    if (entries[id]?.workspaceId === context.workspaceId) return { replacesId: id };
  }
  if (typeof value.view_id === "string") {
    const owner = value.owner;
    const panel = usePanelTabStore.getState().sessions[workspacePanelKey(context.workspaceId)];
    const sourceTab = panel?.tabs.find((tab): tab is ViewPanelTab => tab.type === "view" && tab.serverUrl === context.serverUrl && tab.viewId === value.view_id &&
        (!record(owner) || (owner.id === tab.owner.id && owner.kind === tab.owner.kind)));
    if (sourceTab) return { sourceTab };
  }
  return {};
}

/** Observe the transcript independently of collapsed tool cards or visible tabs. */
export async function syncViewGeneration(context: Context, part: DynamicToolUIPart, open: (tab: ViewDraftTab) => void) {
  if (part.toolName !== "view_create" && part.toolName !== "view_update") return;
  const id = viewGenerationId(context.serverUrl, context.sessionId, part.toolCallId);
  const store = useViewGenerationStore.getState();
  const previous = store.entries[id];
  if (part.state === "input-streaming" || part.state === "input-available") {
    if (previous?.status === "saved" || previous?.status === "preview" || previous?.status === "failed") return;
    const input = viewProgramInput(part.input);
    const next: ViewGeneration = { ...previous, ...context, toolCallId: part.toolCallId, title: input.title === "Creating view…" ? previous?.title ?? input.title : input.title,
      program: input.program || previous?.program || "", status: "streaming" };
    store.update(id, next);
    if (part.toolName === "view_create" && !previous && context.autoOpen !== false) open(viewDraftTab(id, next));
    const metadata = part.callProviderMetadata?.opencode;
    const raw = record(metadata) && typeof metadata.rawInput === "string" ? metadata.rawInput : "";
    const args = raw ? (await parsePartialJson(raw)).value : part.input;
    if (useViewGenerationStore.getState().entries[id] !== next) return;
    const partial = viewProgramInput(args);
    const source = part.toolName === "view_update" ? editSource(context, args, store.entries) : {};
    const parent = source.replacesId ? store.entries[source.replacesId] : undefined;
    const update = { ...next, ...source, layoutEdit: next.layoutEdit || (Boolean(parent) && record(args) && typeof args.program === "string"),
      title: partial.title === "Creating view…" ? parent?.title ?? source.sourceTab?.label ?? next.title : partial.title,
      program: partial.program.length > next.program.length ? partial.program : next.program };
    store.update(id, update);
    if (part.toolName === "view_update" && context.autoOpen !== false && !previous?.replacesId && !previous?.sourceTab) {
      if (source.sourceTab) usePanelTabStore.getState().replaceTab(source.sourceTab.id, viewDraftTab(id, update));
      else if (source.replacesId) {
        const tab = viewDraftTab(id, update);
        const panel = usePanelTabStore.getState().sessions[workspacePanelKey(context.workspaceId)];
        if (!panel?.panes.some(pane => pane.activeTabId === tab.id)) open(tab);
      } else if (record(args) && typeof args.view_id === "string" && input.program && !previous?.program) open(viewDraftTab(id, update));
    }
    return;
  }
  // Terminal results also repair stale cards after a reconnect. They never open old tabs.
  const input = viewProgramInput(part.input);
  const current: ViewGeneration = previous ? { ...previous } : { ...context, toolCallId: part.toolCallId, title: input.title, program: input.program, status: "streaming" };
  const outcome = part.state === "output-available" ? viewToolOutcome(part.output) : { error: part.state === "output-error" ? part.errorText : "Generation ended without a saved view." };
  if ("preview" in outcome) {
    // Replayed transcript output must not undo a Save made in this app session.
    if (previous?.status === "saved") return;
    if (outcome.preview.replacesCallId) current.replacesId = viewGenerationId(context.serverUrl, context.sessionId, outcome.preview.replacesCallId);
    const saved = store.savedResults[id];
    if (saved) {
      store.update(id, { ...current, status: "saved", saved, preview: outcome.preview, program: outcome.preview.input.program, title: saved.title, error: undefined });
      usePanelTabStore.getState().resolveViewTab(viewDraftTab(id, current).id, viewPanelTab(context.serverUrl, { owner: saved.owner, viewId: saved.id }, saved.title));
      return;
    }
    store.update(id, { ...current, status: "preview", preview: outcome.preview, program: outcome.preview.input.program, title: outcome.preview.input.title, error: undefined });
  } else if ("view" in outcome) {
    const view = outcome.view;
    store.update(id, { ...current, status: "saved", saved: view, title: view.title, error: undefined });
    usePanelTabStore.getState().resolveViewTab(id, viewPanelTab(context.serverUrl, { owner: view.owner, viewId: view.id }, view.title));
  } else {
    store.update(id, { ...current, status: "failed", error: outcome.error });
    if (current.sourceTab) usePanelTabStore.getState().replaceTab(id, current.sourceTab);
  }
}

export async function reconcileViewGenerations(context: Context, parts: DynamicToolUIPart[]) {
  for (const part of parts) {
    await syncViewGeneration(context, part.state === "input-streaming" || part.state === "input-available"
      ? { ...part, state: "output-error", errorText: "Generation stopped before this view was saved." } : part, () => {});
  }
}
