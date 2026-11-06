import { parsePartialJson, type DynamicToolUIPart } from "ai";
import { usePanelTabStore } from "../session/panel/panel-tab-store";
import { record, viewDraftTab, viewGenerationId, viewProgramInput, viewToolOutcome, useViewGenerationStore, type ViewDraftTab, type ViewGeneration } from "./view-generation";
import { viewPanelTab } from "./view-reference";

type Context = { serverUrl: string; workspaceId: string; sessionId: string; autoOpen?: boolean };

/** Observe the transcript independently of collapsed tool cards or visible tabs. */
export async function syncViewGeneration(context: Context, part: DynamicToolUIPart, open: (tab: ViewDraftTab) => void) {
  if (part.toolName !== "view_create" && part.toolName !== "view_update") return;
  const id = viewGenerationId(context.serverUrl, context.sessionId, part.toolCallId);
  const store = useViewGenerationStore.getState();
  const previous = store.entries[id];
  if (part.state === "input-streaming" || part.state === "input-available") {
    if (previous?.status === "saved" || previous?.status === "preview" || previous?.status === "failed") return;
    const input = viewProgramInput(part.input);
    const next: ViewGeneration = { ...context, toolCallId: part.toolCallId, title: input.title === "Creating view…" ? previous?.title ?? input.title : input.title,
      program: input.program || previous?.program || "", status: "streaming" };
    store.update(id, next);
    if (!previous && context.autoOpen !== false) open(viewDraftTab(id, next));
    const metadata = part.callProviderMetadata?.opencode;
    if (record(metadata) && typeof metadata.rawInput === "string" && metadata.rawInput) {
      const parsed = await parsePartialJson(metadata.rawInput);
      // A newer chunk or completion may arrive while parsing this one.
      if (useViewGenerationStore.getState().entries[id] !== next) return;
      const partial = viewProgramInput(parsed.value);
      store.update(id, { ...next, title: partial.title === "Creating view…" ? next.title : partial.title,
        program: partial.program.length > next.program.length ? partial.program : next.program });
    }
    return;
  }
  // Terminal results also repair stale cards after a reconnect. They never open old tabs.
  const input = viewProgramInput(part.input);
  const current: ViewGeneration = previous ?? { ...context, toolCallId: part.toolCallId, title: input.title, program: input.program, status: "streaming" };
  const outcome = part.state === "output-available" ? viewToolOutcome(part.output) : { error: part.state === "output-error" ? part.errorText : "Generation ended without a saved view." };
  if ("preview" in outcome) {
    // Replayed transcript output must not undo a Save made in this app session.
    if (previous?.status === "saved") return;
    const saved = store.savedResults[id];
    if (saved) {
      store.update(id, { ...current, status: "saved", saved, preview: outcome.preview, program: outcome.preview.input.program, title: saved.title, error: undefined });
      usePanelTabStore.getState().resolveViewTab(id, viewPanelTab(context.serverUrl, { owner: saved.owner, viewId: saved.id }, saved.title));
      return;
    }
    store.update(id, { ...current, status: "preview", preview: outcome.preview, program: outcome.preview.input.program, title: outcome.preview.input.title, error: undefined });
  } else if ("view" in outcome) {
    const view = outcome.view;
    store.update(id, { ...current, status: "saved", saved: view, title: view.title, error: undefined });
    usePanelTabStore.getState().resolveViewTab(id, viewPanelTab(context.serverUrl, { owner: view.owner, viewId: view.id }, view.title));
  } else store.update(id, { ...current, status: "failed", error: outcome.error });
}

export async function reconcileViewGenerations(context: Context, parts: DynamicToolUIPart[]) {
  for (const part of parts) {
    await syncViewGeneration(context, part.state === "input-streaming" || part.state === "input-available"
      ? { ...part, state: "output-error", errorText: "Generation stopped before this view was saved." } : part, () => {});
  }
}
