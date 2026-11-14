import { create } from "zustand";
import type { LauncherWorkspaceContext, AssistantConversation, AssistantContextItem, AssistantExecutionTarget, LauncherApprovalRequest, LauncherCatalogEntry, LauncherFileFilter, LauncherInvocation, LauncherOrigin, LauncherSearchKind, LauncherSearchResult, LauncherSourceState, LauncherVoiceState } from "@legalwork/types/launcher";
import type { LauncherSelection } from "./launcher-keyboard";
import { orderLauncherResults } from "./launcher-keyboard";
import type { LauncherDetail } from "./launcher-details";
import { persistentContext } from "./launcher-context-lifecycle";

export type LauncherView = "idle" | "results" | "commands" | "conversation" | "work" | "detail" | "hidden";
export type LauncherOverlay = { kind: "actions"; resultKey: string } | { kind: "navigation-actions"; id: string } | { kind: "context-menu" } | { kind: "sort" } | null;
export type ProjectScope = { id: string; name: string };
export type LauncherConversationBinding = { conversationId: string; sessionId: string; workspaceId: string; title: string; archived: boolean; pinned: boolean; origin?: string | null };
export type StagedPreview = { id: string; dataUrl: string };

export type LauncherState = {
  /** undefined until the native invocation arrives; null when invoked outside a project. */
  invocationContext: LauncherWorkspaceContext | null | undefined;
  workspaceContext: LauncherWorkspaceContext | null;
  view: LauncherView;
  detail: LauncherDetail | null;
  input: string;
  category: LauncherSearchKind | null;
  /** File finder filters; they narrow files only and show as chips. */
  fileFilter: LauncherFileFilter;
  scope: ProjectScope | null;
  /** The execution target bound to the next submission: distinct from the search scope. */
  target: AssistantExecutionTarget;
  results: LauncherSearchResult[];
  sources: LauncherSourceState[];
  searchPending: boolean;
  searchError: string | null;
  catalog: LauncherCatalogEntry[];
  selection: LauncherSelection;
  multiSelect: Set<string>;
  overlay: LauncherOverlay;
  context: AssistantContextItem[];
  previews: StagedPreview[];
  conversation: LauncherConversationBinding | null;
  origin: LauncherOrigin | null;
  pinned: boolean;
  positionMoved: boolean;
  attentionCount: number;
  /** A host approval the desktop routed to this panel; dismissing the panel hands it back, never approves it. */
  approval: LauncherApprovalRequest | null;
  /** Live capture ownership pushed by the desktop; the polled status is the fallback. */
  voice: LauncherVoiceState | null;
  notice: { tone: "info" | "error"; text: string } | null;
  /** The next invocation to apply, delivered by the desktop or a deep link. */
  invocation: LauncherInvocation | null;
  visible: boolean;
  /** Keep an in-flight form mounted if the user explicitly hides the native panel. */
  formBusy: boolean;
  setInvocation: (invocation: LauncherInvocation | null) => void;
  setVisible: (visible: boolean) => void;
  setInput: (input: string) => void;
  setCategory: (category: LauncherSearchKind | null) => void;
  setFileFilter: (filter: Partial<LauncherFileFilter>) => void;
  setScope: (scope: ProjectScope | null) => void;
  setTarget: (target: AssistantExecutionTarget) => void;
  setView: (view: LauncherView) => void;
  setResults: (results: LauncherSearchResult[], sources: LauncherSourceState[], pending: boolean, error: string | null) => void;
  setCatalog: (catalog: LauncherCatalogEntry[]) => void;
  select: (selection: LauncherSelection) => void;
  toggleMultiSelect: (key: string) => void;
  clearMultiSelect: () => void;
  setOverlay: (overlay: LauncherOverlay) => void;
  addContext: (items: AssistantContextItem[], previews?: StagedPreview[]) => void;
  removeContext: (id: string) => void;
  replaceContext: (items: AssistantContextItem[]) => void;
  bindConversation: (conversation: AssistantConversation | null) => void;
  setOrigin: (origin: LauncherOrigin | null) => void;
  setPinned: (pinned: boolean) => void;
  setPositionMoved: (moved: boolean) => void;
  setAttentionCount: (count: number) => void;
  setApproval: (approval: LauncherApprovalRequest | null) => void;
  setVoice: (voice: LauncherVoiceState | null) => void;
  notify: (notice: LauncherState["notice"]) => void;
  reset: () => void;
};

const initial = {
  detail: null as LauncherDetail | null,
  invocationContext: undefined,
  workspaceContext: null as LauncherWorkspaceContext | null,
  view: "idle" as LauncherView, input: "", category: null, fileFilter: { types: null, modifiedAfter: null, sourceKind: null } as LauncherFileFilter, scope: null, target: { kind: "assistant" } as AssistantExecutionTarget, results: [], sources: [], searchPending: false, searchError: null, catalog: [],
  selection: { id: null, source: "auto" } as LauncherSelection, multiSelect: new Set<string>(), overlay: null as LauncherOverlay, context: [], previews: [], conversation: null, origin: null, pinned: false, positionMoved: false, attentionCount: 0, approval: null as LauncherApprovalRequest | null, voice: null as LauncherVoiceState | null, notice: null,
  invocation: null as LauncherInvocation | null, visible: true, formBusy: false,
};

export const useLauncherStore = create<LauncherState>((set) => ({
  ...initial,
  setInvocation: invocation => set(invocation ? { invocation, invocationContext: invocation.workspaceContext ?? null } : { invocation }),
  setVisible: visible => set(visible ? { visible } : { visible, invocationContext: undefined }),
  setInput: input => set(state => ({ input, ...(state.input !== input ? { selection: { id: null, source: "auto" }, ...(state.view !== "conversation" ? { multiSelect: new Set<string>(), overlay: null } : {}) } : {}) })),
  setCategory: category => set(state => ({ category, fileFilter: category && category !== "files" ? { ...state.fileFilter, types: null, sourceKind: null } : state.fileFilter })),
  setFileFilter: filter => set(state => ({ fileFilter: { ...state.fileFilter, ...filter } })),
  // A search scope never silently becomes the execution target; the target changes only through its own control.
  setScope: scope => set({ scope }),
  setTarget: target => set({ target }),
  setView: view => set(state => ({ view, ...(state.view !== view ? { selection: { id: null, source: "auto" } } : {}) })),
  setResults: (results, sources, searchPending, searchError) => set({ results: orderLauncherResults(results), sources, searchPending, searchError }),
  setCatalog: catalog => set({ catalog }),
  select: selection => set({ selection }),
  toggleMultiSelect: key => set(state => { const next = new Set(state.multiSelect); if (next.has(key)) next.delete(key); else next.add(key); return { multiSelect: next }; }),
  clearMultiSelect: () => set({ multiSelect: new Set() }),
  setOverlay: overlay => set({ overlay }),
  addContext: (items, previews = []) => set(state => {
    const replaceSelection = items.some(item => item.type === "selection");
    const context = replaceSelection ? persistentContext(state.context) : state.context;
    return { context: [...context, ...items.filter(item => !context.some(existing => existing.id === item.id))], previews: [...state.previews, ...previews] };
  }),
  removeContext: id => set(state => ({ context: state.context.filter(item => item.id !== id), previews: state.previews.filter(preview => preview.id !== id) })),
  replaceContext: context => set({ context }),
  bindConversation: conversation => set(state => ({
    ...(state.conversation?.conversationId !== conversation?.id ? { input: "", context: [], previews: [], target: { kind: "assistant" }, scope: null } : {}),
    conversation: conversation ? { conversationId: conversation.id, sessionId: conversation.sessionId, workspaceId: conversation.workspaceId, title: conversation.title, archived: conversation.archivedAt !== null, pinned: conversation.pinned, origin: conversation.origin } : null,
  })),
  setOrigin: origin => set({ origin }),
  setPinned: pinned => set({ pinned }),
  setPositionMoved: positionMoved => set({ positionMoved }),
  setAttentionCount: attentionCount => set({ attentionCount }),
  setApproval: approval => set({ approval }),
  setVoice: voice => set({ voice }),
  notify: notice => set({ notice }),
  // Dismissal keeps drafts and deliberate attachments. Captured selections always expire.
  reset: () => set(state => {
    if (state.formBusy) return { ...state, context: persistentContext(state.context), overlay: null };
    const keepDraft = state.view === "conversation";
    return { ...state, detail: null, workspaceContext: state.workspaceContext ? { ...state.workspaceContext, selection: undefined } : null, view: keepDraft ? "conversation" : "idle", input: keepDraft ? state.input : "", scope: keepDraft ? state.scope : null, target: keepDraft ? state.target : { kind: "assistant" }, category: keepDraft ? state.category : null, fileFilter: keepDraft ? state.fileFilter : { types: null, modifiedAfter: null, sourceKind: null }, context: persistentContext(state.context).filter(item => keepDraft || item.type !== "clipboard"), results: [], sources: [], searchPending: false, searchError: null, selection: { id: null, source: "auto" }, multiSelect: new Set(), overlay: null, notice: null };
  }),
}));
