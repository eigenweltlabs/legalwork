import { compareLauncherResults, type LauncherSort } from "@legalwork/types/launcher";
import type { LauncherFileSourceKind, LauncherSearchKind, LauncherSearchResponse, LauncherSearchResult, LauncherSourceState } from "@legalwork/types/launcher";

export type SearchInput = { query: string; kinds: LauncherSearchKind[]; projectId: string | null; fileTypes?: string[] | null; modifiedAfter?: number | null; sourceKind?: LauncherFileSourceKind | null; sort?: LauncherSort };
export type SearchRun = (input: SearchInput & { content: boolean }, signal: AbortSignal) => Promise<LauncherSearchResponse>;
export type SearchSnapshot = { items: LauncherSearchResult[]; sources: LauncherSourceState[]; pending: boolean; query: string; error: string | null };
export const resultKey = (item: Pick<LauncherSearchResult, "kind" | "sourceId" | "id">) => `${item.kind}\u0000${item.sourceId}\u0000${item.id}`;

/**
 * Two-phase search per keystroke: a fast filename/metadata pass renders
 * first, then a content pass enriches without reordering what the user is
 * looking at. Obsolete queries are cancelled, and results merge by stable ID.
 */
export class LauncherSearchSession {
  private controller: AbortController | null = null;
  private generation = 0;
  private snapshot: SearchSnapshot = { items: [], sources: [], pending: false, query: "", error: null };
  private listeners = new Set<(snapshot: SearchSnapshot) => void>();
  constructor(private run: SearchRun, private options: { debounceMs?: number; contentPass?: boolean; indexingPollMs?: number } = {}) {}
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The query whose rows are on screen; only a content pass for the same words keeps their order. */
  private settledQuery = "";
  current() { return this.snapshot; }
  subscribe(listener: (snapshot: SearchSnapshot) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private publish(next: Partial<SearchSnapshot>) { this.snapshot = { ...this.snapshot, ...next }; for (const listener of this.listeners) listener(this.snapshot); }
  cancel() { this.controller?.abort(); this.controller = null; if (this.timer) clearTimeout(this.timer); this.timer = null; this.publish({ pending: false }); }
  search(input: SearchInput) {
    this.controller?.abort();
    if (this.timer) clearTimeout(this.timer);
    const generation = ++this.generation;
    const query = input.query.trim();
    const filtered = Boolean(input.fileTypes?.length || input.modifiedAfter || input.sourceKind);
    if (!query && input.kinds.length !== 1 && !input.kinds.includes("tasks") && !input.projectId && !filtered) { this.controller = null; this.publish({ items: [], sources: [], pending: false, query, error: null }); return; }
    const controller = new AbortController();
    this.controller = controller;
    this.publish({ pending: true, query, error: null, ...(JSON.stringify({ ...input, query }) !== this.settledQuery ? { items: [], sources: [] } : {}) });
    this.timer = setTimeout(() => { this.timer = null; void this.execute(generation, controller, { ...input, query }); }, this.options.debounceMs ?? 120);
  }
  private merge(previous: LauncherSearchResult[], incoming: LauncherSearchResult[]) {
    // Keep the order of rows already on screen; append newcomers after them.
    const seen = new Map(incoming.map(item => [resultKey(item), item]));
    const kept = previous.flatMap(item => { const next = seen.get(resultKey(item)); if (!next) return []; seen.delete(resultKey(item)); return [next]; });
    return [...kept, ...seen.values()];
  }
  private async execute(generation: number, controller: AbortController, input: SearchInput) {
    const responses = new Map<LauncherSearchKind, LauncherSearchResponse>();
    const fingerprint = JSON.stringify(input);
    let remaining = input.kinds.length;
    let rendered: LauncherSearchResult[] = this.settledQuery === fingerprint ? this.snapshot.items : [];
    const publish = () => {
      if (controller.signal.aborted || generation !== this.generation) return;
      const pages = [...responses.values()];
      rendered = this.merge(rendered, pages.flatMap(page => page.items));
      if (input.sort && input.sort !== "relevance") rendered.sort((a, b) => compareLauncherResults(a, b, input.sort));
      this.publish({ items: rendered, sources: pages.flatMap(page => page.sources), pending: remaining > 0 });
      this.settledQuery = fingerprint;
    };
    await Promise.all(input.kinds.map(async kind => {
      try {
        const fast = await this.run({ ...input, kinds: [kind], content: false }, controller.signal);
        if (controller.signal.aborted || generation !== this.generation) return;
        responses.set(kind, fast);
        if (this.options.contentPass !== false && kind === "files" && input.query.length >= 2) {
          publish();
          responses.set(kind, await this.run({ ...input, kinds: [kind], content: true }, controller.signal));
        }
        // Newly added folders and document preparation finish in the background.
        // Refresh while coverage settles (bounded); cancel immediately on hide/change.
        for (let poll = 0; poll < 12 && kind === "files" && responses.get(kind)?.sources.some(source => source.coverage === "indexing") && !controller.signal.aborted && generation === this.generation; poll++) {
          publish();
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", done); resolve(); };
            const timer = setTimeout(done, this.options.indexingPollMs ?? 2500);
            controller.signal.addEventListener("abort", done, { once: true });
          });
          if (controller.signal.aborted || generation !== this.generation) return;
          responses.set(kind, await this.run({ ...input, kinds: [kind], content: this.options.contentPass !== false && input.query.length >= 2 }, controller.signal));
        }
      } catch (error) {
        if (controller.signal.aborted || generation !== this.generation) return;
        this.publish({ error: error instanceof Error ? error.message : String(error) });
      } finally { remaining--; publish(); }
    }));
  }
}
