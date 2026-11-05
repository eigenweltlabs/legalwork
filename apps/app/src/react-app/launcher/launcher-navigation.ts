import { resultKey } from "./launcher-search-session";
import type { LauncherState } from "./launcher-store";
import { parseLauncherEntry } from "./launcher-query";
import { persistentContext } from "./launcher-context-lifecycle";

export type NavigationEntry = Pick<LauncherState, "view" | "detail" | "input" | "category" | "fileFilter" | "scope" | "selection" | "conversation" | "context" | "target" | "previews">;
function snapshot(state: NavigationEntry): NavigationEntry {
  const { view, detail, input, category, fileFilter, scope, selection, conversation, context, target, previews } = state;
  return { view, detail, input, category, fileFilter, scope, selection, conversation, context: persistentContext(context), target, previews };
}

const detailIdentity = (detail: NavigationEntry["detail"]) => detail ? JSON.stringify([resultKey(detail.result), detail.category]) : null;

/** History includes the conversation identity: one chat's draft must never be restored into another. */
export class LauncherNavigationHistory {
  private entries: NavigationEntry[] = [];
  private previous: NavigationEntry | null = null;
  private returning = false;

  observe(state: NavigationEntry) {
    const detail = state.view === "conversation" || state.view === "work" || state.view === "detail" || state.view === "hidden" || state.view === "history";
    // This input is about to route to a conversation, so it cannot be its Back destination.
    if (!detail && parseLauncherEntry(state.input).mode === "ask") return;
    if (this.previous && (this.previous.view !== state.view || state.view === "detail" && detailIdentity(this.previous.detail) !== detailIdentity(state.detail))) {
      if (!this.returning && detail) this.entries.push(this.previous);
      this.returning = false;
    }
    this.previous = snapshot(state);
  }

  back(current: NavigationEntry): NavigationEntry {
    this.returning = true;
    const previous = this.entries.pop();
    if (!previous) return { ...snapshot(current), view: "idle", detail: null, input: "", category: null, scope: null, fileFilter: { types: null, modifiedAfter: null }, selection: { id: null, source: "auto" } };
    return { ...previous, conversation: previous.view === "conversation" ? previous.conversation : current.conversation };
  }
}
