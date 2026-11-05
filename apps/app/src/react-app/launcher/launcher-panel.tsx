import { LauncherFileOrigin } from "./launcher-file-origin";
import { useLauncherFileVisibility } from "./launcher-file-visibility";
import { LauncherTransferForm, type LauncherTransfer } from "./launcher-transfer-form";
import { LauncherCreateForm, excerptText, type LauncherCreate } from "./launcher-create-form";
import { launcherBrowserRoute, launcherFileRoute } from "./launcher-handoff";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Bookmark, BookOpen, Calculator, CalendarDays, Clipboard, Folder, Globe, MessageSquare, FilePlus2, EyeOff, Eye, ListChecks, Loader2, Mic, MoreHorizontal, MousePointerSquareDashed, Paperclip, Plus, RotateCcw, ScanLine, Sparkles, X } from "lucide-react";
import type { LauncherWorkspaceContext, AssistantContextItem, AssistantSubmission, LauncherCatalogEntry, LauncherFileFilter, LauncherInvocation, LauncherResultAction, LauncherSearchKind, LauncherSearchResult, SavedSearch } from "@legalwork/types/launcher";
import { LAUNCHER_SEARCH_KINDS, isLauncherInternalPath } from "@legalwork/types/launcher";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { isMacPlatform } from "@/app/utils";
import { launcherApprovalReply, launcherAttentionSet, launcherClipboardCopyFiles, launcherOutputRemember, launcherStatus, launcherVoice, launcherWindowControl, listLocalSkills, openDesktopPath, revealDesktopItemInDir } from "@/app/lib/desktop";
import { currentLocale, t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { useLocal } from "@/react-app/kernel/local-provider";
import { AssistantAvatar } from "@/react-app/domains/session/sidebar/assistant-appearance";
import { appendDictatedText, useComposerDictation } from "@/react-app/domains/session/surface/composer/use-composer-dictation";
import { ComposerDictationBar } from "@/react-app/domains/session/surface/composer/composer-dictation";
import { workspaceProjectRoute, workspaceSessionRoute } from "@/react-app/shell/workspace-routes";
import { appActionEntries, canPreviewResult, catalogArguments, filterCatalog, invocationForAppAction, primaryResultAction } from "./action-catalog";
import { captureClipboard, captureScreen, captureSelection, fileReferenceItem, taskReferenceItem, stageFiles } from "./context-capture";
import { LauncherApprovalCard } from "./launcher-approval";
import { LauncherContextBar } from "./launcher-context-bar";
import { isCapturedSelection, persistentContext } from "./launcher-context-lifecycle";
import { AttentionCards, LauncherConversation, SubmissionStatusRow, useSubmissionStatus, type PendingOutput } from "./launcher-conversation";
import { enterTarget, escapeAction, footerVerb, isAskShortcut, isComposingKeyEvent, moveSelection, optionId, reconcileSelection, type SelectableItem } from "./launcher-keyboard";
import { activateCategoryAlias, categorySuggestions, isBrowseActionQuery, matchesOpenBrowser, namedCategoryQuery, normalizeLauncherAliases, parseLauncherEntry } from "./launcher-query";
import { isPinned, readPins, togglePin as togglePinnedResult } from "./launcher-pins";
import { LauncherPreviewPane } from "./launcher-preview";
import { CATEGORY_ICONS, LauncherActionMenu, LauncherResultList, actionLabel, fileTypeIcon, resultIcon, type LauncherTransferAction } from "./launcher-results";
import { LauncherSearchSession, resultKey } from "./launcher-search-session";
import { useLauncherShell } from "./launcher-shell";
import { useLauncherStore } from "./launcher-store";
import { LauncherWork } from "./launcher-work";
import { LauncherOutputHistory } from "./launcher-output-history";
import { submitAssistantDraft } from "./submit-draft";
import { attachFilesToDraft, droppedFiles } from "./attach-files";
import { voiceCoordinator } from "./voice-coordinator";
import { LauncherNavigationHistory } from "./launcher-navigation";
import { calculate } from "./launcher-calculator";
import { LauncherNavigationRows, type NavigationRow } from "./launcher-navigation-rows";
import { typedFilterSuggestions, fileSourceSuggestions, dateFilterLabel, FILE_TYPE_PRESETS, namedFileTypeFilter } from "./launcher-typed-filters";
import { handleLauncherFocusKey, launcherControls } from "./launcher-focus";
import { readHiddenItems, writeHiddenItems, type HiddenLauncherItem } from "./launcher-hidden";
import { LauncherRowMenu } from "./launcher-row-menu";
import { LauncherTaskDetail, useLauncherDetailItems, type LauncherDetail } from "./launcher-details";
import { readLauncherRecents, rememberLauncherOpen, suggestedRecents } from "./launcher-recents";
import { canCopyLauncherResult, launcherClipboardText } from "./launcher-clipboard";
import "./launcher.css";

const KIND_HINT: Record<LauncherSearchKind, string> = { files: "launcher.kind.files", projects: "launcher.kind.projects", chats: "launcher.kind.chats", tasks: "launcher.kind.tasks", recordings: "launcher.kind.recordings" };
const TRANSLATION_LANGUAGE_KEY = "legalwork.launcher.translation-language";
/** File finder filters: a few named groups of extensions and a modification floor, shown as removable chips. */
function fileFilterLabels(filter: LauncherFileFilter) {
  const type = filter.types ? Object.entries(FILE_TYPE_PRESETS).find(([, types]) => types.join() === filter.types?.join())?.[0] : null;
  return { type: filter.types ? (type ? t(`launcher.typed.${type}`) : filter.types.join(", ")) : null, modified: filter.modifiedAfter === null ? null : dateFilterLabel(filter.modifiedAfter), source: filter.sourceKind ? t(`launcher.typed.source_${filter.sourceKind}`) : null };
}

export function LauncherPanel() {
  const locale = useLocale();
  const shell = useLauncherShell();
  const { client, assistant, workspaces, drafts, owner, surface, desktop, openInApp, dismiss } = shell;
  const store = useLauncherStore();
  const saveDraft = useCallback<typeof drafts.update>((id, draftOwner, patch) => drafts.update(id, draftOwner, {
    ...patch, ...(patch.context ? { context: persistentContext(patch.context) } : {}),
  }), [drafts]);
  const local = useLocal();
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [inputOverflowLeft, setInputOverflowLeft] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const navigation = useRef(new LauncherNavigationHistory());
  const savingNavigation = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const invocationRunning = useRef<string | null>(null);
  const mod = isMacPlatform() ? "⌘" : "Ctrl";
  const [pins, setPins] = useState(() => typeof window === "undefined" ? [] : readPins());
  const [hidden, setHidden] = useState(() => readHiddenItems(client.baseUrl));
  useEffect(() => {
    const refresh = () => setHidden(readHiddenItems(client.baseUrl));
    refresh(); window.addEventListener("storage", refresh); window.addEventListener("legalwork:launcher-hidden", refresh);
    return () => { window.removeEventListener("storage", refresh); window.removeEventListener("legalwork:launcher-hidden", refresh); };
  }, [client.baseUrl]);
  const hiddenIds = new Set(hidden.map(item => item.id));
  const hideItem = (item: HiddenLauncherItem) => {
    try { writeHiddenItems(client.baseUrl, [...readHiddenItems(client.baseUrl).filter(other => other.id !== item.id), item]); store.setOverlay(null); store.select({ id: null, source: "auto" }); }
    catch (error) { store.notify({ tone: "error", text: String(error) }); }
  };
  const restoreItem = (id?: string) => { try { writeHiddenItems(client.baseUrl, id ? readHiddenItems(client.baseUrl).filter(item => item.id !== id) : []); store.select({ id: null, source: "auto" }); } catch (error) { store.notify({ tone: "error", text: String(error) }); } };
  const detailItems = useLauncherDetailItems(store.view === "detail" ? store.detail : null, store.input, store.fileFilter);
  const folders = useQuery({ queryKey: ["launcher-folders", client.baseUrl], queryFn: () => client.launcherFolders() });
  const [recents, setRecents] = useState(() => readLauncherRecents(client.baseUrl));
  useEffect(() => {
    const refresh = () => setRecents(readLauncherRecents(client.baseUrl));
    refresh();
    window.addEventListener("storage", refresh); window.addEventListener("legalwork:launcher-recents", refresh);
    return () => { window.removeEventListener("storage", refresh); window.removeEventListener("legalwork:launcher-recents", refresh); };
  }, [client.baseUrl, store.visible]);
  const searchRoots: LauncherSearchResult[] = (folders.data?.folders ?? []).map(folder => ({ id: folder.id, kind: "files", fileType: "folder", folderId: folder.id, workspaceId: null, sourceId: `folder:${folder.id}`, path: "", title: folder.name, updatedAt: folder.createdAt, score: 0, match: "recent", actions: ["open"] }));
  const existingFiles = useLauncherFileVisibility([...store.results, ...(store.view === "idle" ? [...recents.map(item => item.result), ...searchRoots] : [])], store.visible);
  const visibleResult = (item: LauncherSearchResult) => !hiddenIds.has(resultKey(item)) && (item.kind !== "files" || !isLauncherInternalPath(item.path ?? item.id) && !existingFiles.isError && existingFiles.data?.has(resultKey(item)) === true);
  const withFileOrigin = (item: LauncherSearchResult): LauncherSearchResult => {
    const known = existingFiles.data?.get(resultKey(item));
    return known ? { ...item, sourceKind: known.sourceKind, subtitle: known.subtitle } : item;
  };
  const visibleResults = store.results.filter(visibleResult).map(withFileOrigin);
  const [translationLanguage, setTranslationLanguage] = useState(() => { try { return window.localStorage.getItem(TRANSLATION_LANGUAGE_KEY) ?? "system"; } catch { return "system"; } });
  const [submission, setSubmission] = useState<{ requestId: string; messageId: string; state: string; error?: string | null } | null>(null);
  const [pendingOutput, setPendingOutput] = useState<PendingOutput | null>(null);
  const sendingRef = useRef(false);
  const projectOperation = useRef(crypto.randomUUID());
  const attachmentOperation = useRef({ key: "", id: crypto.randomUUID() });
  const [pendingContext, setPendingContext] = useState<{ context: LauncherWorkspaceContext | null } | null>(null);
  const [invocationContext, setInvocationContext] = useState<LauncherWorkspaceContext | null>(null);
  const [transfer, setTransfer] = useState<LauncherTransfer | null>(null);
  const [creation, setCreation] = useState<LauncherCreate | null>(null);
  const [openChoice, setOpenChoice] = useState<LauncherSearchResult | null>(null);
  const formActive = Boolean(creation || transfer || openChoice);
  const [parkedDrafts, setParkedDrafts] = useState<Array<Pick<typeof store, "input" | "context" | "target" | "workspaceContext" | "conversation">>>([]);
  const [scrollExpansion, setScrollExpansion] = useState<{ view: string; category: LauncherSearchKind | null } | null>(null);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadingRef = useRef(false);
  const uploadConversation = useRef<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const pastedText = useRef(false);
  const expandedByScroll = scrollExpansion?.view === store.view && scrollExpansion.category === store.category;
  const expanded = expandedByScroll || store.view === "conversation" || store.view === "work" || store.view === "detail" || store.view === "hidden" || store.view === "history" || Boolean(creation || transfer || openChoice || store.approval);
  useEffect(() => {
    if (surface !== "panel" || !desktop || !store.visible) return;
    void launcherWindowControl("resize", { height: expanded ? 520 : 346 }).catch(() => undefined);
  }, [surface, desktop, store.visible, expanded]);
  useEffect(() => {
    if (store.visible) return;
    setScrollExpansion(null);
    navigation.current = new LauncherNavigationHistory();
    setParkedDrafts(items => items.map(item => ({ ...item, context: persistentContext(item.context) })));
    setCreation(null);
  }, [store.visible]);
  const status = useQuery({ queryKey: ["launcher-desktop-status"], queryFn: () => launcherStatus(), enabled: desktop, refetchInterval: 15_000 });
  const aliases = useMemo(() => normalizeLauncherAliases(status.data?.aliases), [status.data?.aliases]);
  const entry = parseLauncherEntry(store.input);
  const mode: "search" | "command" | "ask" | "conversation" = store.view === "conversation" ? "conversation" : store.view === "history" || store.view === "hidden" ? "search" : entry.mode;
  const singleLineInput = mode !== "conversation" && mode !== "ask";
  const hasSearchChips = Boolean(store.category || store.scope || store.fileFilter.types?.length || store.fileFilter.modifiedAfter || store.fileFilter.sourceKind);
  const namedCategory = mode === "search" && !store.category && !store.fileFilter.sourceKind ? namedCategoryQuery(entry.text) : null;
  const namedFileType = mode === "search" && !store.fileFilter.types?.length ? namedFileTypeFilter(entry.text) : null;
  const searchCategory = namedFileType || store.fileFilter.sourceKind ? "files" : store.category ?? namedCategory?.category ?? null;
  const searchText = namedFileType ? "" : namedCategory?.rest ?? entry.text;
  const showCommands = entry.mode === "command" && (store.view === "commands" || store.view === "conversation");
  const commandWorkspaceId = store.view === "conversation" ? store.target.kind === "project" ? store.target.workspaceId : assistant?.workspaceId : null;
  const calculation = useMemo(() => mode === "search" && !["detail", "hidden", "history"].includes(store.view) && !searchCategory && !store.scope ? calculate(searchText) : null, [mode, store.view, searchCategory, store.scope, searchText]);

  // Keep the search or command screen underneath a conversation or task view.
  useLayoutEffect(() => {
    navigation.current.observe(store);
  }, [store.view, store.detail, store.input, store.category, store.fileFilter, store.scope, store.selection, store.conversation, store.context, store.target, store.previews]);

  // Conversation binding: read-only lookup first; a conversation is only created by an explicit action.
  // Callbacks read the store imperatively: depending on the whole store object would re-run effects on every state change.
  const bindCurrent = useCallback(async () => {
    const before = useLauncherStore.getState().conversation?.conversationId;
    const id = shell.conversationId ?? useLauncherStore.getState().conversation?.conversationId;
    const bound = id ? (await client.assistantConversation(id)).conversation : (await client.assistantConversationCurrent()).conversation;
    const after = useLauncherStore.getState().conversation?.conversationId;
    if (after && after !== before) return (await client.assistantConversation(after)).conversation;
    const live = useLauncherStore.getState();
    if (live.target.kind === "project") return null;
    live.bindConversation(bound);
    live.setInput(live.input); live.replaceContext(live.context); live.setTarget(live.target);
    return bound;
  }, [client, shell.conversationId]);
  useEffect(() => { if (useLauncherStore.getState().target.kind === "assistant") void bindCurrent().catch(() => undefined); }, [bindCurrent]);
  const conversation = store.conversation;
  // Adopt the authoritative draft: on binding, and again on reopening or focus when another surface edited meanwhile. Context staged by an invocation stays.
  const adoptDraft = useCallback(async (conversationId: string, overwrite: boolean) => {
    const { draft } = await drafts.claim(conversationId, owner);
    const state = useLauncherStore.getState();
    if (state.conversation?.conversationId !== conversationId) return;
    const context = persistentContext(draft.context);
    state.replaceContext([...context, ...state.context.filter(isCapturedSelection)]);
    if (context.length !== draft.context.length) void saveDraft(conversationId, owner, { context }).catch(() => undefined);
    state.setTarget(assistant && state.conversation?.workspaceId && state.conversation.workspaceId !== assistant.workspaceId ? { kind: "project", workspaceId: state.conversation.workspaceId } : draft.target);
    const scope = workspaces.find(workspace => workspace.id === draft.searchScope);
    state.setScope(scope ? { id: scope.id, name: scope.displayName || scope.name } : null);
    setSubmission(draft.submission);
    let text = draft.text;
    for (const part of draft.composer?.pasteParts ?? []) text = text.replace(`[pasted text ${part.label}]`, () => part.text);
    if (overwrite || !state.input) state.setInput(text);
    if (draft.model) local.setPrefs(previous => ({ ...previous, defaultModel: draft.model, modelVariant: draft.variant }));
  }, [drafts, owner, workspaces, assistant, saveDraft]);
  useEffect(() => { if (conversation && store.view === "conversation" && !invocationRunning.current && !sendingRef.current && !uploadingRef.current) void adoptDraft(conversation.conversationId, false).catch(error => store.notify({ tone: "error", text: String(error) })); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [conversation?.conversationId]);
  useEffect(() => {
    if (store.view !== "conversation" || !store.visible || !conversation || drafts.owns(conversation.conversationId, owner)) return;
    void adoptDraft(conversation.conversationId, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.visible, conversation?.conversationId]);
  // While another surface holds the lease, this one only displays what it writes.
  useEffect(() => drafts.subscribe(id => {
    const state = useLauncherStore.getState();
    if (state.view !== "conversation" || state.conversation?.conversationId !== id || drafts.owns(id, owner)) return;
    const draft = drafts.get(id);
    if (draft.text !== state.input) state.setInput(draft.text);
    state.replaceContext(persistentContext(draft.context));
  }), [drafts, owner]);
  // Persist the complete draft while this surface owns it.
  useEffect(() => {
    if (sendingRef.current || store.view !== "conversation" || !conversation || (uploading && (!uploadConversation.current || uploadConversation.current === conversation.conversationId)) || !drafts.owns(conversation.conversationId, owner)) return;
    const timer = setTimeout(() => {
      if (sendingRef.current || uploadingRef.current && (!uploadConversation.current || uploadConversation.current === conversation.conversationId)) return;
      const current = drafts.get(conversation.conversationId);
      const text = mode === "conversation" || mode === "ask" ? (mode === "ask" ? entry.text : store.input) : current.text;
      if (current.text === text && current.context === store.context && current.target === store.target && current.searchScope === (store.scope?.id ?? null)) return;
      void saveDraft(conversation.conversationId, owner, { text, context: store.context, target: store.target, searchScope: store.scope?.id ?? null, model: local.prefs.defaultModel, variant: local.prefs.modelVariant }).catch(() => undefined);
    }, 0);
    return () => clearTimeout(timer);
  }, [uploading, conversation, drafts, owner, store.view, store.input, store.context, store.target, store.scope, mode, entry.text, local.prefs.defaultModel, local.prefs.modelVariant]);

  // Search: two-phase session bound to the current category and scope.
  const session = useMemo(() => new LauncherSearchSession((input, signal) => client.launcherSearch({ query: input.query, kinds: input.kinds, projectId: input.projectId, content: input.content, fileTypes: input.fileTypes, modifiedAfter: input.modifiedAfter, sourceKind: input.sourceKind }, signal)), [client]);
  useEffect(() => session.subscribe(snapshot => useLauncherStore.getState().setResults(snapshot.items, snapshot.sources, snapshot.pending, snapshot.error)), [session]);
  useEffect(() => () => session.cancel(), [session]);
  const hasFileFilter = Boolean(store.fileFilter.types?.length || store.fileFilter.modifiedAfter || store.fileFilter.sourceKind);
  const runSearch = useCallback(() => {
    const state = useLauncherStore.getState();
    const entry = parseLauncherEntry(state.input), named = !state.category && !state.fileFilter.sourceKind ? namedCategoryQuery(entry.text) : null;
    const fileType = !state.fileFilter.types?.length ? namedFileTypeFilter(entry.text) : null;
    const category = fileType || state.fileFilter.sourceKind ? "files" : state.category ?? named?.category;
    session.search({ query: fileType ? "" : named?.rest ?? entry.text, kinds: category ? [category] : [...LAUNCHER_SEARCH_KINDS], projectId: state.scope?.id ?? null, fileTypes: fileType?.extensions ?? state.fileFilter.types, modifiedAfter: state.fileFilter.modifiedAfter, sourceKind: state.fileFilter.sourceKind });
  }, [session]);
  useEffect(() => {
    if (!store.visible) { session.cancel(); return; }
    if (["work", "detail", "hidden", "history"].includes(store.view) || mode !== "search" || calculation || !store.input.trim() && !store.category && !store.scope && !hasFileFilter) { session.cancel(); return; }
    runSearch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, store.visible, mode, entry.text, store.category, store.scope, store.input, store.fileFilter, calculation, store.view, runSearch]);
  useEffect(() => {
    if (["work", "detail", "hidden", "history"].includes(store.view)) return;
    if (mode === "search" && (store.input.trim() || store.category || store.scope || hasFileFilter)) store.setView("results");
    else if (mode === "command") store.setView("commands");
    else if (mode === "ask") { /* Explicit Ask stays separate from the saved conversation draft until send. */ }
    // An emptied field leaves a conversation that was never bound; a bound conversation keeps its view.
    else if (store.view === "results" || store.view === "commands") store.setView(conversation && store.input ? "conversation" : "idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, store.input, store.category, store.scope, hasFileFilter]);

  // Catalog: engine commands and quick actions from the server, app actions and skills from this client.
  const catalogQuery = useQuery({ queryKey: ["launcher-catalog", client.baseUrl, commandWorkspaceId ?? ""], queryFn: () => client.launcherCatalog(commandWorkspaceId === assistant?.workspaceId ? null : commandWorkspaceId ?? null), enabled: Boolean(commandWorkspaceId), staleTime: 30_000 });
  const skillsQuery = useQuery({ queryKey: ["launcher-skills"], queryFn: () => listLocalSkills(""), enabled: desktop, staleTime: 60_000 });
  const catalog = useMemo<LauncherCatalogEntry[]>(() => {
    const favorites = new Set((catalogQuery.data?.entries ?? []).filter(entry => entry.favorite).map(entry => entry.id));
    const skills = (skillsQuery.data?.items ?? []).map<LauncherCatalogEntry>(skill => ({ id: `skill:${skill.name}`, label: skill.name, description: skill.description ?? null, aliases: [skill.name.toLowerCase()], kind: "agent", source: "skill", requires: [], target: "assistant", outputs: ["preview"], workspaceId: null, shortcut: null, favorite: false, usedAt: null, command: null, quickAction: null }));
    return [...appActionEntries({ desktop, favorites, recent: new Map(), shortcuts: status.data?.actionShortcuts ?? {} }), ...(catalogQuery.data?.entries ?? []), ...skills];
  }, [catalogQuery.data, skillsQuery.data, desktop, status.data?.actionShortcuts, locale]);
  const commandItems = useMemo(() => showCommands && commandWorkspaceId ? filterCatalog(catalog.filter(item => ["command", "skill", "quick-action"].includes(item.source)), entry.text) : [], [catalog, showCommands, commandWorkspaceId, entry.text]);
  // Saved searches keep their scope visible and apply it exactly: category, project and words.
  const savedSearches = useQuery({ queryKey: ["launcher-saved-searches", client.baseUrl], queryFn: () => client.savedSearches(), staleTime: 30_000 });
  const applySavedSearch = (search: SavedSearch) => {
    const state = useLauncherStore.getState();
    const workspace = search.projectId ? workspaces.find(workspace => workspace.id === search.projectId) : null;
    state.setScope(workspace ? { id: workspace.id, name: workspace.displayName || workspace.name } : null);
    state.setCategory(search.kind); state.setInput(search.query); state.setOverlay(null); state.setView("results");
    state.setFileFilter({ types: search.fileTypes ?? null, modifiedAfter: search.modifiedAfter ?? null, sourceKind: search.sourceKind ?? null });
    void client.recordSavedSearchUse(search.id).catch(() => undefined);
    inputRef.current?.focus();
  };
  const refreshSavedSearches = () => Promise.all([queryClient.invalidateQueries({ queryKey: ["launcher-saved-searches"] }), queryClient.invalidateQueries({ queryKey: ["launcher-catalog"] })]);
  const canSaveSearch = store.view === "results" && mode === "search" && Boolean(searchText.trim() || searchCategory || store.scope || hasFileFilter);
  const saveCurrentSearch = async () => {
    if (!canSaveSearch) { store.notify({ tone: "info", text: t("launcher.saved.nothing") }); return; }
    const labels = fileFilterLabels(store.fileFilter);
    const name = [labels.type ?? (searchCategory ? t(KIND_HINT[searchCategory]) : null), searchText.trim() || null, store.scope?.name ?? null, labels.source, labels.modified].filter(Boolean).join(" · ");
    try {
      const { search } = await client.createSavedSearch({ name, query: searchText.trim(), kind: searchCategory, projectId: store.scope?.id ?? null, fileTypes: store.fileFilter.types, modifiedAfter: store.fileFilter.modifiedAfter, sourceKind: store.fileFilter.sourceKind });
      await refreshSavedSearches();
      store.notify({ tone: "info", text: t("launcher.saved.saved", { name: search.name }) });
    } catch (error) { store.notify({ tone: "error", text: error instanceof Error ? error.message : String(error) }); }
  };
  const deleteSavedSearch = async (id: string) => {
    try { await client.deleteSavedSearch(id); await refreshSavedSearches(); } catch (error) { store.notify({ tone: "error", text: error instanceof Error ? error.message : String(error) }); }
  };

  const notify = store.notify;
  const absolutePath = (result: LauncherSearchResult) => { const workspace = workspaces.find(workspace => workspace.id === result.workspaceId); return workspace && result.path ? `${workspace.path.replace(/[\\/]+$/, "")}/${result.path}` : null; };
  const localFiles = desktop && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(client.baseUrl).hostname);
  const copyingRef = useRef(false);
  const copyResult = async (result: LauncherSearchResult) => {
    if (copyingRef.current) return;
    copyingRef.current = true;
    try {
      if (result.kind === "files") {
        if (!localFiles) throw new Error(t("launcher.notice.copy_failed"));
        const state = useLauncherStore.getState();
        const selection = state.multiSelect.has(resultKey(result)) ? state.results.filter(item => state.multiSelect.has(resultKey(item))) : [result];
        const paths = await Promise.all(selection.map(async item => {
          if (item.kind !== "files") throw new Error(t("launcher.notice.copy_failed"));
          if (item.folderId && item.fileType !== "folder") return (await client.launcherFolderFile(item.folderId, item.path ?? item.id)).path;
          const folder = item.folderId ? folders.data?.folders.find(folder => folder.id === item.folderId) : null;
          const path = folder ? `${folder.path.replace(/[\\/]+$/, "")}/${item.path ?? ""}` : absolutePath(item);
          if (!path) throw new Error(t("launcher.notice.copy_failed"));
          return path;
        }));
        await launcherClipboardCopyFiles(client.baseUrl, paths);
      } else await navigator.clipboard.writeText(await launcherClipboardText(result, client));
      notify({ tone: "info", text: t("launcher.notice.copied") });
    } catch { notify({ tone: "error", text: t("launcher.notice.copy_failed") }); }
    finally { copyingRef.current = false; }
  };

  // Conversation creation is explicit: the user's send or New conversation, never a refresh.
  const ensureConversation = useCallback(async () => {
    const state = useLauncherStore.getState(), target = state.target;
    const current = state.conversation;
    if (current && !current.archived && (target.kind === "project" ? current.workspaceId === target.workspaceId : current.workspaceId === assistant?.workspaceId)) {
      await drafts.claim(current.conversationId, owner);
      return current;
    }
    const created = target.kind === "project"
      ? (await client.launcherProjectChat({ workspaceId: target.workspaceId, operationId: projectOperation.current, title: state.input.slice(0, 120) || undefined })).conversation
      : (await client.assistantConversationCurrent()).conversation ?? (await client.createAssistantConversation({ origin: surface })).conversation;
    await drafts.claim(created.id, owner);
    useLauncherStore.getState().bindConversation(created);
    useLauncherStore.getState().setTarget(target);
    return { conversationId: created.id, sessionId: created.sessionId, workspaceId: created.workspaceId, title: created.title, archived: false, pinned: false };
  }, [client, drafts, owner, surface, assistant?.workspaceId]);
  const switchTarget = async (workspaceId: string) => {
    const state = useLauncherStore.getState();
    if (sendingRef.current || uploadingRef.current) return;
    if (state.view === "conversation" && state.conversation && drafts.owns(state.conversation.conversationId, owner)) await saveDraft(state.conversation.conversationId, owner, { text: state.input, context: state.context, target: state.target });
    projectOperation.current = crypto.randomUUID();
    useLauncherStore.setState({ conversation: null, target: workspaceId ? { kind: "project", workspaceId } : { kind: "assistant" } });
  };
  const submitAsk = useCallback(async (text: string, reuse?: { requestId: string; messageId: string }, output?: PendingOutput["output"], command?: { name: string; arguments: string }) => {
    const trimmed = text.trim();
    // The live store, not this render's snapshot: a target chosen a moment ago must be the one that ships.
    const live = useLauncherStore.getState();
    if (sendingRef.current || uploadingRef.current || (!reuse && !trimmed && !live.context.length && !command)) return false;
    notify(null);
    sendingRef.current = true; setSending(true);
    const fromSearch = live.view !== "conversation" && !reuse;
    try {
      const target = await ensureConversation();
      const existingDraft = drafts.get(target.conversationId);
      if (target.conversationId !== useLauncherStore.getState().conversation?.conversationId) return false;
      const context = { items: live.context, workspaceContext: live.workspaceContext ?? undefined, target: live.target, searchScope: live.scope?.id ?? null, capturedAt: Date.now() };
      if (!reuse && !fromSearch) await saveDraft(target.conversationId, owner, { text: trimmed, context: live.context, target: live.target, searchScope: live.scope?.id ?? null });
      if (fromSearch) { store.setInput(existingDraft.text); store.replaceContext(persistentContext(existingDraft.context)); }
      else { store.setInput(live.input); store.replaceContext(live.context); }
      store.setCategory(null); store.setFileFilter({ types: null, modifiedAfter: null, sourceKind: null });
      store.setView("conversation");
      let result: AssistantSubmission;
      try {
        result = await submitAssistantDraft({ client, drafts, owner, conversationId: target.conversationId, retry: Boolean(reuse), preserveDraft: fromSearch, beforeSend: desktop && output ? input => launcherOutputRemember(client.baseUrl, { requestId: input.requestId, messageId: input.messageId, conversationId: target.conversationId, output, originId: live.origin?.id ?? null }) : undefined, input: { text: trimmed, context, command, model: local.prefs.defaultModel ?? undefined, variant: local.prefs.modelVariant ?? undefined } });
      } catch (error) {
        // Ambiguous: keep the identity and draft; the status poll and Retry reuse it.
        const pending = drafts.get(target.conversationId).submission;
        if (pending) setSubmission({ ...pending, error: error instanceof Error ? error.message : String(error) });
        if (pending?.state === "unconfirmed" && output && !desktop) setPendingOutput({ messageId: pending.messageId, output, originId: live.origin?.id ?? null });
        if (!pending) notify({ tone: "error", text: error instanceof Error ? error.message : String(error) });
        return false;
      }
      setSubmission({ requestId: result.requestId, messageId: result.messageId, state: result.state, error: result.error });
      if (output && !desktop && result.state !== "failed") setPendingOutput({ messageId: result.messageId, output, originId: live.origin?.id ?? null });
      if (result.state === "failed" || result.state === "unconfirmed") return false;
      const state = useLauncherStore.getState();
      state.replaceContext(state.context.filter(item => !isCapturedSelection(item) || !live.context.some(sent => sent.id === item.id)));
      if (state.workspaceContext && state.workspaceContext.capturedAt === live.workspaceContext?.capturedAt) useLauncherStore.setState({ workspaceContext: { ...state.workspaceContext, selection: undefined } });
      const current = useLauncherStore.getState();
      const saved = drafts.get(target.conversationId);
      if (!saved.text && !saved.context.length && current.conversation?.conversationId === target.conversationId && current.input === live.input && JSON.stringify(persistentContext(current.context)) === JSON.stringify(persistentContext(live.context))) { store.setInput(""); store.replaceContext(current.context.filter(isCapturedSelection)); }
      return true;
    } catch (error) { notify({ tone: "error", text: error instanceof Error ? error.message : String(error) }); return false; }
    finally { sendingRef.current = false; setSending(false); }
  }, [sending, store, ensureConversation, drafts, owner, client, local.prefs.defaultModel, local.prefs.modelVariant, notify, desktop]);
  // The panel stays open across its own dialogs: the file chooser and an active dictation are not a blur to hide on.
  // Menus restore focus to their trigger; the keyboard belongs to the entry once a choice is made.
  const refocusEntry = () => setTimeout(() => inputRef.current?.focus(), 60);
  const holdPanel = (hold: boolean) => { if (desktop && surface === "panel") void launcherWindowControl(hold ? "dialog-begin" : "dialog-end").catch(() => undefined); };
  const uploadFiles = async (files: File[]) => {
    if (!files.length) return;
    if (uploadingRef.current) { notify({ tone: "info", text: t("launcher.drop.busy") }); return; }
    uploadingRef.current = true; setUploading(true); holdPanel(true);
    const live = useLauncherStore.getState();
    let conversationId: string | undefined;
    try {
      const target = await ensureConversation();
      conversationId = target.conversationId;
      uploadConversation.current = conversationId;
      const previous = drafts.get(conversationId);
      const stagedText = live.view === "conversation" ? live.input : previous.text;
      const stagedContext = [...persistentContext(previous.context), ...live.context.filter(item => !previous.context.some(other => other.id === item.id))];
      await saveDraft(conversationId, owner, { text: stagedText, context: stagedContext, target: live.target, searchScope: live.scope?.id ?? null });
      const bound = useLauncherStore.getState();
      if (bound.conversation?.conversationId === conversationId) { bound.setInput(stagedText); bound.replaceContext(stagedContext); bound.setTarget(live.target); bound.setScope(live.scope); bound.setView("conversation"); }
      const outcome = await attachFilesToDraft({ files, conversationId, owner, drafts,
        context: () => { const current = useLauncherStore.getState(); return current.conversation?.conversationId === target.conversationId ? current.context : drafts.get(target.conversationId).context; },
        onAttached: context => { const current = useLauncherStore.getState(); if (current.conversation?.conversationId === target.conversationId) current.replaceContext(context); },
        stage: async file => (await stageFiles(client, target.workspaceId, [file]))[0] });
      if (outcome.failures.length) notify({ tone: "error", text: outcome.failures.map(item => `${item.name}: ${item.error}`).join("\n") });
      else notify({ tone: "info", text: t("launcher.drop.added", { count: outcome.added }) });
    } catch (error) { notify({ tone: "error", text: error instanceof Error ? error.message : String(error) }); }
    finally {
      const state = useLauncherStore.getState();
      if (conversationId && state.conversation?.conversationId === conversationId) await saveDraft(conversationId, owner, { context: state.context }).catch(() => undefined);
      uploadingRef.current = false; uploadConversation.current = null; setUploading(false); holdPanel(false);
    }
  };
  useEffect(() => {
    const input = fileInputRef.current;
    if (!input) return;
    const onCancel = () => holdPanel(false);
    input.addEventListener("cancel", onCancel);
    return () => input.removeEventListener("cancel", onCancel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop, surface]);
  const retrySubmission = useCallback(() => {
    if (!submission || !conversation) return;
    const draft = drafts.get(conversation.conversationId);
    void submitAsk(draft.text || store.input, { requestId: submission.requestId, messageId: submission.messageId });
  }, [submission, conversation, drafts, submitAsk, store.input]);
  const onSubmissionChange = useCallback((next: AssistantSubmission) => {
    setSubmission(current => current && current.requestId === next.requestId ? { ...current, state: next.state, error: next.error } : current);
    if (conversation && drafts.owns(conversation.conversationId, owner)) {
      const pending = drafts.get(conversation.conversationId).submission;
      if (pending?.requestId === next.requestId && pending.state !== next.state) void drafts.acknowledgeSubmission(conversation.conversationId, owner, next).then(cleared => {
        const state = useLauncherStore.getState();
        if (cleared && state.view === "conversation" && state.conversation?.conversationId === conversation.conversationId && state.input.trim() === cleared.text && JSON.stringify(persistentContext(state.context)) === JSON.stringify(cleared.context)) {
          state.setInput(""); state.replaceContext(state.context.filter(item => isCapturedSelection(item) && !pending?.input?.context?.items.some(sent => sent.id === item.id)));
        }
      }).catch(() => undefined);
    }
  }, [conversation, drafts, owner]);
  useSubmissionStatus(submission && submission.state !== "completed" && submission.state !== "failed" ? submission.requestId : null, onSubmissionChange);

  // Speak to Assistant: one microphone owner; external dictation and meetings keep their destination.
  const dictation = useComposerDictation(conversation?.conversationId ?? "launcher", async (spoken, send) => {
    const next = appendDictatedText(mode === "ask" ? entry.text : store.input, spoken);
    store.setInput(mode === "search" ? `? ${next}` : next);
    store.setView("conversation");
    voiceCoordinator.release("panel");
    if (send) await submitAsk(next);
  }, store.visible);
  // The desktop pushes capture ownership as it changes; the polled status is the fallback.
  const voice = store.voice ?? status.data?.voice ?? null;
  const voiceBusy = Boolean(voice?.externalDictation || voice?.meeting || voice?.composer);
  const speak = async () => {
    if (voice && voiceBusy) { notify({ tone: "error", text: t(voice.meeting ? "launcher.voice.meeting_active" : voice.externalDictation ? "launcher.voice.dictation_active" : "launcher.voice.busy") }); return; }
    const decision = voiceCoordinator.request({ destination: "assistant", ownerId: "panel", conversationId: conversation?.conversationId });
    if (!decision.ok) { notify({ tone: "error", text: t("launcher.voice.busy") }); return; }
    store.setView("conversation");
    await dictation.start();
  };
  useEffect(() => { if (!dictation.active) voiceCoordinator.release("panel"); }, [dictation.active]);
  useEffect(() => { if (!dictation.active) return; holdPanel(true); return () => holdPanel(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [dictation.active]);
  // Pending questions and approvals are counted whatever view is open; the companion shows the number.
  const ownAttention = useQuery({ queryKey: ["launcher-attention-own", client.baseUrl, conversation?.conversationId], queryFn: () => client.assistantConversationAttention(conversation?.conversationId ?? ""), enabled: Boolean(conversation), refetchInterval: store.visible ? 4000 : false });
  const delegatedAttention = useQuery({ queryKey: ["launcher-attention-delegated", client.baseUrl], queryFn: () => client.assistantAttentionAll(), refetchInterval: store.visible ? 5000 : false });
  const attentionItems = [...new Map([...(ownAttention.data?.items ?? []), ...(delegatedAttention.data?.items ?? [])].filter(item => item.kind !== "widget").map(item => [item.id, item])).values()];
  const attentionCount = attentionItems.length;
  const [attentionBusy, setAttentionBusy] = useState<string | null>(null);
  const replyAttention: Parameters<typeof AttentionCards>[0]["onReply"] = async (item, answer) => {
    if (attentionBusy) return;
    setAttentionBusy(item.id);
    try { await client.replyAssistantAttention({ id: item.id, revision: item.revision, workspaceId: item.workspaceId, sessionId: item.sessionId, ...answer }); }
    catch (error) { notify({ tone: "error", text: String(error) }); }
    finally { setAttentionBusy(null); await Promise.all([ownAttention.refetch(), delegatedAttention.refetch()]); }
  };
  useEffect(() => { useLauncherStore.getState().setAttentionCount(attentionCount); }, [attentionCount]);
  // The companion shows where the microphone is and how much needs attention.
  useEffect(() => {
    if (!desktop || surface !== "panel") return;
    void launcherAttentionSet({ count: store.attentionCount, recording: dictation.active }).catch(() => undefined);
  }, [desktop, surface, store.attentionCount, dictation.active]);
  useEffect(() => { if (store.overlay) store.setOverlay(null); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [store.view]);
  // Queries scroll horizontally behind fixed chips; only conversation drafts grow vertically.
  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = singleLineInput ? "34px" : "auto";
    if (!singleLineInput) element.style.height = `${Math.min(160, element.scrollHeight)}px`;
    const frame = requestAnimationFrame(() => setInputOverflowLeft(element.scrollLeft > 1));
    return () => cancelAnimationFrame(frame);
  }, [store.input, singleLineInput, store.category, store.scope, store.fileFilter]);

  // Context capture: explicit actions with visible provenance; failures leave the draft intact.
  const addItems = (items: AssistantContextItem[], previews: { id: string; dataUrl: string }[] = []) => { store.addContext(items, previews); if (store.view === "idle" || store.view === "results") store.setView("conversation"); };
  const captureActions = {
    selection: async () => {
      const originId = store.origin?.id;
      const outcome = await captureSelection(store.origin);
      const live = useLauncherStore.getState();
      if (!live.visible || live.origin?.id !== originId) return;
      if (outcome.ok) addItems([outcome.item]); else notify({ tone: "error", text: outcome.message });
    },
    clipboard: async () => { const outcome = await captureClipboard(); if (outcome.ok) addItems([outcome.item]); else notify({ tone: "error", text: outcome.message }); },
    window: async () => { if (!assistant) return; const outcome = await captureScreen("window", client, store.target.kind === "project" ? store.target.workspaceId : assistant.workspaceId); if (outcome.ok) addItems([outcome.item], outcome.preview ? [{ id: outcome.item.id, dataUrl: outcome.preview }] : []); else if (!outcome.cancelled) notify({ tone: "error", text: outcome.message }); },
    region: async () => { if (!assistant) return; const outcome = await captureScreen("region", client, store.target.kind === "project" ? store.target.workspaceId : assistant.workspaceId); if (outcome.ok) addItems([outcome.item], outcome.preview ? [{ id: outcome.item.id, dataUrl: outcome.preview }] : []); else if (!outcome.cancelled) notify({ tone: "error", text: outcome.message }); },
    files: () => { holdPanel(true); fileInputRef.current?.click(); },
  };

  // Copy or move the selected files into another project: an explicit, approved action with its own audit trail.
  const transferFiles = (result: LauncherSearchResult, action: LauncherTransferAction, targetWorkspaceId: string) => {
    const state = useLauncherStore.getState();
    const items = (state.multiSelect.size ? state.results.filter(item => state.multiSelect.has(resultKey(item))) : [result]).filter(item => item.kind === "files" && item.workspaceId && item.path);
    setTransfer({ items, workspaceId: targetWorkspaceId, folder: targetWorkspaceId === state.workspaceContext?.workspaceId ? state.workspaceContext.folder ?? "" : "", mode: action === "move-to-project" ? "move" : "copy" });
  };
  const openResultInApp = async (result: LauncherSearchResult) => {
    if (result.kind === "files") {
      if (result.fileType !== "folder") { await runResultAction(result, "open"); return; }
      if (result.folderId) { const root = folders.data?.folders.find(folder => folder.id === result.folderId); if (root) await openDesktopPath(`${root.path}/${result.path ?? ""}`); return; }
      if (result.workspaceId) openInApp(`/workspace/${encodeURIComponent(result.workspaceId)}/files?launcherFolder=${encodeURIComponent(result.path ?? "")}`);
      return;
    }
    if (result.kind === "chats") {
      const found = result.sourceId === "assistant" ? (await client.assistantConversation(result.id)).conversation : null;
      openInApp(workspaceSessionRoute(found?.workspaceId ?? result.workspaceId ?? "", found?.sessionId ?? result.sessionId ?? result.id));
    } else openInApp(result.kind === "projects" && result.workspaceId ? workspaceProjectRoute(result.workspaceId) : result.kind === "tasks" ? `/tasks?task=${encodeURIComponent(result.id)}` : `/recorder?recording=${encodeURIComponent(result.id)}`);
  };
  const openDetailInApp = async (detail: LauncherDetail) => {
    if (detail.result.kind === "projects" && detail.result.workspaceId && detail.category) {
      const id = encodeURIComponent(detail.result.workspaceId);
      openInApp(detail.category === "recordings" ? `/recorder?project=${id}` : `/workspace/${id}/${detail.category === "chats" ? "sessions" : detail.category}`);
    } else await openResultInApp(detail.result);
  };
  const showDetail = (result: LauncherSearchResult, category?: LauncherSearchKind) => {
    useLauncherStore.setState({ detail: { result, category }, view: "detail", input: "", overlay: null, selection: { id: null, source: "auto" } });
    rememberLauncherOpen(client.baseUrl, result); inputRef.current?.focus();
  };
  // One dispatcher for results, commands and app actions.
  const runResultAction = async (result: LauncherSearchResult, action: LauncherResultAction) => {
    if (action === "open" && (["projects", "tasks", "recordings"].includes(result.kind) || result.fileType === "folder")) { showDetail(result); return; }
    if (result.folderId && (action === "open" || action === "copy-path")) {
      try {
        if (action === "open" && (!desktop || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(client.baseUrl).hostname))) { store.setOverlay({ kind: "preview", resultKey: resultKey(result) }); return; }
        const file = await client.launcherFolderFile(result.folderId, result.path ?? result.id);
        if (action === "open") { await openDesktopPath(file.path); rememberLauncherOpen(client.baseUrl, result); }
        else { await navigator.clipboard.writeText(file.path); notify({ tone: "info", text: t("launcher.notice.copied") }); }
      } catch (error) { notify({ tone: "error", text: String(error) }); }
      return;
    }
    const route = result.kind === "chats" ? workspaceSessionRoute(result.workspaceId ?? "", result.sessionId ?? result.id) : result.kind === "tasks" ? `/tasks?task=${encodeURIComponent(result.id)}` : result.kind === "recordings" ? `/recorder?recording=${encodeURIComponent(result.id)}` : result.workspaceId ? `${workspaceProjectRoute(result.workspaceId)}${result.kind === "files" ? `?file=${encodeURIComponent(result.path ?? result.id)}` : ""}` : "/home";
    const multi = store.multiSelect.size ? store.results.filter(item => store.multiSelect.has(resultKey(item))) : [result];
    if (result.kind === "chats" && (action === "resume" || action === "open")) {
      try {
        const { conversation: found } = result.sourceId === "assistant" ? await client.assistantConversation(result.id)
          : await client.launcherProjectChat({ workspaceId: result.workspaceId ?? "", sessionId: result.sessionId ?? result.id, operationId: `bind_${result.sessionId ?? result.id}` });
        store.bindConversation(found); await adoptDraft(found.id, true); store.setCategory(null); store.setView("conversation");
        rememberLauncherOpen(client.baseUrl, result); inputRef.current?.focus();
      }
      catch { notify({ tone: "error", text: t("launcher.conversation.unavailable") }); }
      return;
    }
    if (action === "open" && result.kind === "files" && result.workspaceId && result.path) {
      const current = useLauncherStore.getState().workspaceContext;
      if (current && current.workspaceId !== result.workspaceId) { setOpenChoice(result); return; }
      openFile(result, result.workspaceId, current?.paneId); return;
    }
    switch (action) {
      case "open": case "resume": case "play": rememberLauncherOpen(client.baseUrl, result); openInApp(route); if (surface === "panel") dismiss(); return;
      case "reveal": { const path = absolutePath(result); if (path) await revealDesktopItemInDir(path); return; }
      case "open-external": { const path = absolutePath(result); if (path) await openDesktopPath(path); return; }
      case "copy-path": await navigator.clipboard.writeText(result.path ?? result.title); notify({ tone: "info", text: t("launcher.notice.copied") }); return;
      case "copy-reference": await navigator.clipboard.writeText(`${result.subtitle ? `${result.subtitle}: ` : ""}${result.path ?? result.title}`); notify({ tone: "info", text: t("launcher.notice.copied") }); return;
      case "pin": setPins(togglePinnedResult(result)); return;
      case "copy-to-project": case "move-to-project": store.setOverlay({ kind: "actions", resultKey: resultKey(result) }); return;
      case "complete": try { await client.patchTask(result.workspaceId ?? "", result.id, { status: "done" }); notify({ tone: "info", text: t("launcher.notice.task_done", { title: result.title }) }); } catch (error) { notify({ tone: "error", text: error instanceof Error ? error.message : String(error) }); } return;
      case "attach": case "ask": case "compare": case "summarize": case "hand-to-assistant": {
        if (result.kind === "projects" && result.workspaceId) { await switchTarget(result.workspaceId); store.setInput(""); store.setView("conversation"); return; }
        if (uploadingRef.current) return;
        uploadingRef.current = true; setUploading(true); holdPanel(true);
        const initial = useLauncherStore.getState();
        try {
          const target = await ensureConversation();
          uploadConversation.current = target.conversationId;
          const prior = drafts.get(target.conversationId);
          await saveDraft(target.conversationId, owner, { context: [...persistentContext(prior.context), ...initial.context.filter(item => !prior.context.some(other => other.id === item.id))], text: initial.view === "conversation" ? initial.input : prior.text, target: initial.target, searchScope: initial.scope?.id ?? null });
          await drafts.protect(target.conversationId, owner, async () => {
            const items: AssistantContextItem[] = [];
            for (const item of multi) {
              if (item.kind === "files") {
                if (item.folderId) {
                  try { items.push((await client.attachLauncherFolderFile(item.folderId, item.path ?? item.id)).item); }
                  catch (error) { notify({ tone: "error", text: String(error) }); }
                } else items.push(fileReferenceItem(item));
              }
              else if (item.kind === "recordings") { try { const transcript = await client.recordingTranscript(item.id, { limit: 20000 }); items.push({ id: `rec_${item.id}`, type: "selection", text: `${item.title}\n\n${transcript.content}`, sourceApp: "LegalWork Recorder", sourceWindow: item.title, capturedAt: Date.now() }); } catch { notify({ tone: "error", text: t("launcher.notice.transcript_unavailable") }); } }
              else if (item.kind === "tasks") items.push(taskReferenceItem(item));
              else if (item.kind === "chats") items.push({ id: `chat_${item.id}`, type: "selection", text: `${item.subtitle ?? ""} / ${item.title}${item.excerpt ? `\n${item.excerpt}` : ""}`.trim(), sourceApp: "LegalWork", sourceWindow: t("launcher.kind.chats"), capturedAt: Date.now() });
            }
            if (!items.length && result.kind !== "projects") return;
            const context = [...drafts.get(target.conversationId).context.filter(item => !items.some(added => added.id === item.id)), ...items];
            if (context.length > 50) throw new Error(t("launcher.drop.limit"));
            const executionTarget = initial.target;
            const scope = result.kind === "projects" && result.workspaceId ? { id: result.workspaceId, name: result.title } : initial.scope;
            const draftText = drafts.get(target.conversationId).text;
            const prompt = action === "compare" ? t("launcher.prompt.compare", { count: items.length }) : action === "summarize" ? t("launcher.prompt.summarize", { count: items.length }) : action === "hand-to-assistant" && !draftText.trim() ? t("tasks.session_draft_message") : "";
            const current = useLauncherStore.getState();
            const text = [draftText, prompt].filter(Boolean).join("\n\n");
            await saveDraft(target.conversationId, owner, { context, text, target: executionTarget, searchScope: scope?.id ?? null });
            if (current.conversation?.conversationId !== target.conversationId) return;
            current.replaceContext(context); current.setInput(text); current.setTarget(executionTarget); current.setScope(scope);
            current.clearMultiSelect(); current.setCategory(null); current.setFileFilter({ types: null, modifiedAfter: null, sourceKind: null }); current.setView("conversation"); inputRef.current?.focus();
          });
        } catch (error) { notify({ tone: "error", text: error instanceof Error ? error.message : String(error) }); }
        finally { uploadingRef.current = false; uploadConversation.current = null; setUploading(false); holdPanel(false); }
        return;
      }
    }
  };
  const runCatalogEntry = async (item: LauncherCatalogEntry, args = catalogArguments(item, parseLauncherEntry(useLauncherStore.getState().input).text)) => {
    if (item.source === "app") {
      const invocation = invocationForAppAction(item.id);
      if (item.id === "app.add-selection") return captureActions.selection();
      if (item.id === "app.paste-clipboard") return captureActions.clipboard();
      if (item.id === "app.attach-file") return captureActions.files();
      if (item.id === "app.open-settings") { openInApp("/settings/launcher"); return; }
      if (item.id === "app.new-project") { openInApp("/projects"); return; }
      if (invocation) applyInvocation({ id: `local_${crypto.randomUUID()}`, action: invocation, source: surface === "panel" ? "shortcut" : "home" });
      return;
    }
    if (item.source === "saved-search" && item.savedSearch) { applySavedSearch(item.savedSearch); return; }
    if (item.source === "quick-action" && item.quickAction) {
      const context = useLauncherStore.getState().context;
      const selection = context.find((entry): entry is Extract<AssistantContextItem, { type: "selection" }> => entry.type === "selection")?.text;
      const clipboard = context.find((entry): entry is Extract<AssistantContextItem, { type: "clipboard" }> => entry.type === "clipboard")?.text;
      const files = context.flatMap(entry => entry.type === "file" ? [entry.path] : []);
      try {
        const rendered = await client.renderQuickAction(item.quickAction.id, { selection, clipboard, files, arguments: args });
        if (item.quickAction.target === "project" && item.quickAction.projectId) useLauncherStore.getState().setTarget({ kind: "project", workspaceId: item.quickAction.projectId });
        else if (item.quickAction.target === "project" && useLauncherStore.getState().target.kind !== "project") { notify({ tone: "error", text: t("launcher.notice.needs_project") }); return; }
        else if (item.quickAction.target !== "project") useLauncherStore.getState().setTarget({ kind: "assistant" });
        void client.recordQuickActionUse(item.quickAction.id).catch(() => undefined);
        const prompt = item.quickAction.skill ? `Load [skill ${item.quickAction.skill}] and follow its instructions.\n\n${rendered.prompt}` : rendered.prompt;
        await submitAsk(prompt, undefined, item.quickAction.output === "copy" || item.quickAction.output === "insert" ? item.quickAction.output : undefined,
          item.quickAction.command ? { name: item.quickAction.command, arguments: prompt } : undefined);
      } catch (error) { notify({ tone: "error", text: error instanceof Error ? error.message : String(error) }); }
      return;
    }
    if (item.source === "skill") { await submitAsk(`Load [skill ${item.label}] and follow its instructions.\n\n${args}`); return; }
    // Slash commands run through the engine as agent work; a project's own command binds that project.
    if (item.workspaceId && item.workspaceId !== assistant?.workspaceId) useLauncherStore.getState().setTarget({ kind: "project", workspaceId: item.workspaceId });
    const name = item.command?.name ?? item.label.replace(/^\//, "");
    await submitAsk(`/${name}${args ? ` ${args}` : ""}`, undefined, undefined, { name, arguments: args });
  };
  const useContext = async (context: LauncherWorkspaceContext | null) => {
    const state = useLauncherStore.getState();
    if (sendingRef.current || uploadingRef.current) return;
    if (state.input.trim() || state.context.some(item => item.type === "task" || item.type === "clipboard" || item.type === "image" || item.type === "file" && !item.id.startsWith("view_"))) setParkedDrafts(previous => [...previous, { input: state.input, context: persistentContext(state.context), target: state.target, workspaceContext: state.workspaceContext ? { ...state.workspaceContext, selection: undefined } : null, conversation: state.conversation }]);
    if (state.view === "conversation" && state.conversation && drafts.owns(state.conversation.conversationId, owner)) await saveDraft(state.conversation.conversationId, owner, { text: state.input, context: state.context, target: state.target });
    projectOperation.current = crypto.randomUUID();
    useLauncherStore.setState({ workspaceContext: context, conversation: null, target: { kind: "assistant" } });
    const items: AssistantContextItem[] = [];
    if (context?.document) items.push({ id: `view_${crypto.randomUUID()}`, type: "file", ...context.document, revision: context.document.revision ?? null, sourceLabel: (context.document.workspaceId === context.workspaceId ? context.workspaceName : context.document.workspaceId).slice(0, 200) });
    if (context?.selection) items.push({ id: `selection_${crypto.randomUUID()}`, type: "selection", text: context.selection, sourceApp: "LegalWork", sourceWindow: context.document?.name ?? context.workspaceName, capturedAt: context.capturedAt });
    state.setInput(""); state.replaceContext(items); state.setView("idle"); setPendingContext(null);
  };
  const applyInvocation = useCallback(async (invocation: LauncherInvocation) => {
    const live = useLauncherStore.getState();
    if (invocation.action === "open" || invocation.captureSelection) live.replaceContext(persistentContext(live.context));
    const incoming = invocation.workspaceContext ?? null;
    setInvocationContext(incoming);
    const changed = incoming?.workspaceId !== live.workspaceContext?.workspaceId || incoming?.sessionId !== live.workspaceContext?.sessionId || JSON.stringify(incoming?.document) !== JSON.stringify(live.workspaceContext?.document);
    if (!changed) useLauncherStore.setState({ workspaceContext: incoming });
    if (changed) {
      const hasAttachedDraft = live.context.some(item => item.type === "task" || item.type === "clipboard" || item.type === "image" || item.type === "file" && !item.id.startsWith("view_"));
      if (live.input.trim() || hasAttachedDraft || creation || transfer || openChoice || sendingRef.current || uploadingRef.current) { setPendingContext({ context: incoming }); if (invocation.action === "open") return; }
      else await useContext(incoming);
    }
    const needsConversation = Boolean(invocation.conversationId || ["ask", "resume", "new-conversation"].includes(invocation.action));
    const bound = invocation.action === "new-conversation" ? (await client.createAssistantConversation({ origin: surface })).conversation
      : invocation.conversationId ? (await client.assistantConversation(invocation.conversationId)).conversation : !needsConversation || useLauncherStore.getState().target.kind === "project" ? null : await bindCurrent();
    if (bound) {
      useLauncherStore.getState().bindConversation(bound);
      if (invocation.conversationId || ["ask", "resume", "new-conversation"].includes(invocation.action) || useLauncherStore.getState().view === "conversation") await adoptDraft(bound.id, true);
    }
    const selectionState = useLauncherStore.getState();
    if (incoming?.selection && (invocation.action === "open" || invocation.captureSelection) && selectionState.visible) {
      selectionState.addContext([{ id: `selection_${crypto.randomUUID()}`, type: "selection", text: incoming.selection, sourceApp: "LegalWork", sourceWindow: incoming.document?.name ?? incoming.workspaceName, capturedAt: incoming.capturedAt }]);
    } else if (!incoming && selectionState.origin?.supportsSelection && (invocation.action === "open" || invocation.captureSelection)) {
      const selected = await captureSelection(selectionState.origin);
      const current = useLauncherStore.getState();
      if (!current.visible || current.origin?.id !== selectionState.origin.id || current.invocation && current.invocation.id !== invocation.id) return;
      if (selected.ok) current.addContext([selected.item]);
    }
    const aliasKinds: Partial<Record<LauncherInvocation["action"], LauncherSearchKind>> = { files: "files", projects: "projects", chats: "chats", tasks: "tasks", recordings: "recordings" };
    const kind = aliasKinds[invocation.action];
    if (invocation.projectId) { const workspace = workspaces.find(workspace => workspace.id === invocation.projectId); if (workspace) store.setScope({ id: workspace.id, name: workspace.displayName || workspace.name }); }
    if (invocation.contextId) { const staged = await client.consumeLauncherContext(invocation.contextId); addItems(staged.items); }
    if (kind) { store.setCategory(kind); store.setInput(invocation.query ?? ""); store.setView("results"); }
    else if (invocation.action === "search") { store.setCategory(null); store.setInput(invocation.query ?? ""); store.setView("results"); }
    else if (invocation.action === "ask") { if (invocation.query !== undefined) store.setInput(invocation.query); store.setView("conversation"); }
    else if (invocation.action === "new-conversation") store.setView("conversation");
    else if (invocation.action === "resume") store.setView("conversation");
    else if (invocation.action === "work") store.setView("work");
    else if (invocation.action === "speak") void speak();
    else if (invocation.action === "capture-region") void captureActions.region();
    else if (invocation.action === "capture-window") void captureActions.window();
    else if (invocation.action === "quick-action" && invocation.actionId) {
      const loaded = await client.launcherCatalog(invocation.projectId ?? null);
      const item = loaded.entries.find(entry => entry.id === invocation.actionId);
      if (!item) throw new Error(t("launcher.notice.action_unknown"));
      await runCatalogEntry(item, invocation.query ?? "");
    }
    else if (invocation.action === "dictate" || invocation.action === "record") {
      if (!desktop) openInApp("/recorder");
      else { if (invocation.action === "dictate" && surface === "panel") dismiss(); void launcherVoice(invocation.action).catch(() => openInApp("/recorder")); }
    }
    if (invocation.conversationId) store.setView("conversation");
    requestAnimationFrame(() => inputRef.current?.focus());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces, client, catalog, bindCurrent, adoptDraft]);
  useEffect(() => {
    if (!store.invocation || invocationRunning.current || sendingRef.current || uploadingRef.current) return;
    const invocation = store.invocation;
    invocationRunning.current = invocation.id;
    void applyInvocation(invocation).catch(error => notify({ tone: "error", text: error instanceof Error ? error.message : String(error) })).finally(() => {
      invocationRunning.current = null;
      if (useLauncherStore.getState().invocation?.id === invocation.id) useLauncherStore.getState().setInvocation(null);
      else { const pending = useLauncherStore.getState().invocation; if (pending) useLauncherStore.getState().setInvocation({ ...pending }); }
    });
  }, [store.invocation, applyInvocation, sending, uploading]);

  const conversations = useQuery({ queryKey: ["launcher-conversations", client.baseUrl], queryFn: () => client.assistantConversations({ limit: 50 }), enabled: store.visible && (store.view === "idle" || store.view === "history"), staleTime: 10_000 });
  const resumeConversation = async () => {
    if (sendingRef.current || uploadingRef.current) return;
    const incoming = useLauncherStore.getState().context;
    await switchTarget("");
    const current = (await client.assistantConversationCurrent()).conversation;
    store.bindConversation(current);
    if (current) await adoptDraft(current.id, true);
    store.addContext(incoming);
    store.setTarget({ kind: "assistant" });
    store.setView("conversation");
    inputRef.current?.focus();
  };
  const openFile = (result: LauncherSearchResult, destination: string, paneId?: string) => {
    if (!result.workspaceId || !result.path) return;
    rememberLauncherOpen(client.baseUrl, result);
    openInApp(launcherFileRoute({ projectId: result.workspaceId, workspaceId: result.workspaceId, path: result.path, name: result.title }, destination, paneId));
    setOpenChoice(null);
  };
  const openCreate = (kind: LauncherCreate["kind"], name?: string) => {
    const state = useLauncherStore.getState();
    const workspaceId = state.scope?.id ?? (state.view === "detail" ? state.detail?.result.workspaceId : null) ?? (state.target.kind === "project" ? state.target.workspaceId : state.workspaceContext?.workspaceId ?? "");
    const text = kind === "document" ? "" : excerptText(state.context);
    if (kind === "attach") attachmentOperation.current = { key: "", id: crypto.randomUUID() };
    setCreation({ kind, workspaceId, folder: workspaceId === state.workspaceContext?.workspaceId ? state.workspaceContext.folder ?? "" : "",
      name: name ?? (kind === "document" ? searchText.trim() : state.context.some(item => item.type === "selection") ? text.split("\n\n").at(-1)?.slice(0, 70).replace(/[/\\\n]/g, " ") ?? "" : ""), text, context: [...state.context] });
  };
  const selectionAction = (kind: "explain" | "translate" | "rewrite") => {
    const language = translationLanguage === "system" ? currentLocale() === "de" ? "German" : "English" : translationLanguage;
    const fallback = language === "English" ? "German" : "English";
    const prompt = kind === "translate" ? t("launcher.flow.translate_prompt", { language, fallback }) : t(`launcher.flow.${kind}_prompt`);
    void submitAsk([store.input.trim(), prompt].filter(Boolean).join("\n\n"));
  };
  const hasSelectedText = store.context.some(item => item.type === "selection" || item.type === "clipboard");
  const stageInChat = async (workspaceId: string, sessionId: string | undefined, items: AssistantContextItem[]) => {
    if (sendingRef.current || uploadingRef.current) return;
    uploadingRef.current = true; setUploading(true);
    try {
      const key = `${workspaceId}:${sessionId ?? "new"}`;
      if (attachmentOperation.current.key !== key) attachmentOperation.current = { key, id: crypto.randomUUID() };
      const { conversation: found } = await client.launcherProjectChat({ workspaceId, sessionId, operationId: attachmentOperation.current.id });
      const { draft } = await drafts.claim(found.id, owner);
      const attached: AssistantContextItem[] = items.map(item => item.type === "selection" ? { id: item.id, type: "clipboard", text: excerptText([item]), capturedAt: item.capturedAt } : item);
      const saved = persistentContext(draft.context);
      const context = [...saved, ...attached.filter(item => !saved.some(other => other.id === item.id))];
      await saveDraft(found.id, owner, { context, target: { kind: "project", workspaceId } });
      store.bindConversation(found); store.setInput(draft.text); store.replaceContext(context); store.setTarget({ kind: "project", workspaceId }); store.setView("conversation");
      projectOperation.current = crypto.randomUUID();
    } finally { uploadingRef.current = false; setUploading(false); }
  };
  const draftDocument = async (workspaceId: string, folder: string, name: string, format: string, instructions: string) => {
    await switchTarget(workspaceId);
    store.setView("results");
    const sent = await submitAsk(t("launcher.flow.draft_prompt", { project: workspaceId, path: `${folder ? `${folder}/` : ""}${name.endsWith(`.${format}`) ? name : `${name}.${format}`}`, instructions }));
    if (!sent) throw new Error(t("launcher.submission.unconfirmed"));
  };
  const browseCategory = (category: LauncherSearchKind) => {
    store.setCategory(category); if (category !== "files") store.setFileFilter({ types: null }); store.setInput(""); store.setOverlay(null); store.clearMultiSelect(); store.setView("results"); inputRef.current?.focus();
  };
  const startProjectConversation = async () => {
    const context = useLauncherStore.getState().workspaceContext;
    if (!context) return;
    await switchTarget(context.workspaceId);
    useLauncherStore.setState({ input: "", category: null, scope: null, fileFilter: { types: null, modifiedAfter: null, sourceKind: null }, view: "conversation" });
    inputRef.current?.focus();
  };
  const summarizeDocument = () => {
    const state = useLauncherStore.getState(), document = state.workspaceContext?.document;
    if (!document) return;
    if (!state.context.some(item => item.type === "file" && item.workspaceId === document.workspaceId && item.path === document.path)) {
      state.addContext([{ id: `view_${crypto.randomUUID()}`, type: "file", ...document, revision: document.revision ?? null, sourceLabel: null }]);
    }
    return submitAsk(t("launcher.suggest.summarize_prompt"));
  };
  const suggestedCategories = categorySuggestions(store.view === "idle" ? "" : store.input, aliases);
  const browsing = isBrowseActionQuery(store.input);
  const browserRows: NavigationRow[] = desktop && invocationContext && matchesOpenBrowser(store.input) ? [{
    id: "action:browser", title: t("launcher.browser.open"), subtitle: invocationContext.workspaceName, Icon: Globe,
    run: () => openInApp(launcherBrowserRoute(invocationContext.workspaceId, invocationContext.paneId)),
  }] : [];
  const shortcutCategory = suggestedCategories.find(kind => aliases[kind] === store.input.trim().toLocaleLowerCase());
  const categoryRows: NavigationRow[] = suggestedCategories.map(kind => ({
    id: `category:${kind}`, title: t("launcher.suggest.browse", { category: t(KIND_HINT[kind]) }), Icon: CATEGORY_ICONS[kind], shortcut: aliases[kind], run: () => browseCategory(kind), openInApp: () => openInApp(kind === "files" ? store.workspaceContext ? `/workspace/${encodeURIComponent(store.workspaceContext.workspaceId)}/files` : "/projects" : kind === "recordings" ? "/recorder" : kind === "chats" ? store.workspaceContext ? `/workspace/${encodeURIComponent(store.workspaceContext.workspaceId)}/sessions` : "/home" : `/${kind}`),
  }));
  const assistantRow: NavigationRow = { id: "search:assistant", title: assistant?.profile.name ?? t("assistant.title"), Icon: MessageSquare, avatar: <AssistantAvatar icon={assistant?.profile.icon} className="size-5" />, run: resumeConversation, openInApp: () => { void client.assistantConversationCurrent().then(({ conversation }) => openInApp(conversation ? workspaceSessionRoute(conversation.workspaceId, conversation.sessionId) : "/home")).catch(error => notify({ tone: "error", text: String(error) })); } };
  const assistantSuggestion = store.input.trim() && ["assistant", "ask", "fragen", assistant?.profile.name].some(word => word?.toLocaleLowerCase().startsWith(store.input.trim().toLocaleLowerCase()));
  const sourceFilters = searchCategory === "files" && store.view !== "detail" ? fileSourceSuggestions(store.input) : [];
  const filterSuggestions = [...sourceFilters, ...typedFilterSuggestions(store.input, workspaces, new Date(), {
    currentProjectId: store.workspaceContext?.workspaceId,
    recentProjectIds: [...new Set([...recents].sort((a, b) => b.openedAt - a.openedAt).flatMap(item => item.result.workspaceId ? [item.result.workspaceId] : []))],
  })];
  const creationName = searchCategory && !filterSuggestions.length ? searchText.trim() : "";
  const createDocumentRow: NavigationRow = { id: "create:document", title: creationName ? t("launcher.flow.create_named", { name: creationName }) : t("launcher.flow.create_document"), Icon: FilePlus2, run: () => openCreate("document", creationName) };
  const createTaskRow: NavigationRow = { id: "create:task", title: creationName ? t("launcher.suggest.create_task_named", { name: creationName }) : t("launcher.flow.create_task"), Icon: ListChecks, run: () => openCreate("task", creationName) };
  const recordMeetingRow: NavigationRow = { id: "action:record-meeting", title: t("launcher.suggest.record_meeting"), Icon: Mic, run: () => launcherVoice("record") };
  const typedFilters: NavigationRow[] = filterSuggestions.map(filter => ({
    id: filter.id, title: filter.title, Icon: filter.files?.sourceKind === "wiki" ? BookOpen : filter.project || filter.files?.sourceKind ? Folder : filter.files?.types?.length ? fileTypeIcon(filter.files.types[0]) : CalendarDays, run: () => {
      if (filter.project) {
        store.setScope(filter.project);
        if (store.fileFilter.sourceKind && store.fileFilter.sourceKind !== "project") store.setFileFilter({ sourceKind: null });
      }
      if (filter.files?.sourceKind) {
        store.setCategory("files"); store.setFileFilter({ sourceKind: filter.files.sourceKind });
        if (filter.files.sourceKind !== "project") store.setScope(null);
      }
      if (filter.files?.types) { store.setCategory("files"); store.setFileFilter({ types: filter.files.types }); }
      if (filter.files?.modifiedAfter) store.setFileFilter({ modifiedAfter: filter.files.modifiedAfter });
      if (store.view === "detail" && store.detail && !filter.project) {
        if (filter.files?.types && store.detail.result.kind === "projects") showDetail(store.detail.result, "files");
        else store.setInput("");
      } else { store.setInput(""); store.setView("results"); }
      inputRef.current?.focus();
    },
  }));
  const suggestionRows: NavigationRow[] = mode === "search" && !calculation ? [
    ...browserRows,
    ...typedFilters,
    ...(store.category && !store.input.trim() ? [] : categoryRows.filter(row => (browsing || row.id !== `category:${store.category}`) && !(row.id === "category:projects" && sourceFilters.some(filter => filter.files?.sourceKind === "project")))),
    ...(assistantSuggestion && !searchCategory ? [assistantRow] : []),
    ...(!browsing && !sourceFilters.length && (!store.fileFilter.sourceKind || store.fileFilter.sourceKind === "project") && !namedFileType && !store.fileFilter.types?.length && (searchCategory === "files" || !searchCategory && suggestedCategories.includes("files")) ? [createDocumentRow] : []),
    ...(!browsing && (searchCategory === "tasks" || !searchCategory && suggestedCategories.includes("tasks")) ? [createTaskRow] : []),
    ...(!browsing && desktop && !voice?.meeting && (searchCategory === "recordings" || !searchCategory && suggestedCategories.includes("recordings")) ? [recordMeetingRow] : []),
  ].sort((a, b) => Number(b.id.startsWith("filter:source:")) - Number(a.id.startsWith("filter:source:")) || Number(b.id === "action:browser") - Number(a.id === "action:browser") || Number(b.id === `category:${shortcutCategory}`) - Number(a.id === `category:${shortcutCategory}`)) : [];
  const chooseCommandContext = async (workspaceId?: string) => {
    const state = useLauncherStore.getState();
    state.setTarget(workspaceId ? { kind: "project", workspaceId } : { kind: "assistant" });
    state.setCategory(null); state.setScope(null); state.setFileFilter({ types: null, modifiedAfter: null, sourceKind: null }); state.setView("conversation"); inputRef.current?.focus();
  };
  const commandContextRows: NavigationRow[] = [
    { id: "command-context:assistant", title: assistant?.profile.name ?? t("assistant.title"), Icon: MessageSquare, run: () => chooseCommandContext() },
    ...workspaces.map(workspace => ({ id: `command-context:${workspace.id}`, title: workspace.displayName || workspace.name, Icon: Folder, run: () => chooseCommandContext(workspace.id) })),
  ];
  const openHistory = async () => {
    if (sendingRef.current || uploadingRef.current) return;
    const state = useLauncherStore.getState();
    if (state.view === "conversation" && state.conversation && drafts.owns(state.conversation.conversationId, owner)) {
      try { await saveDraft(state.conversation.conversationId, owner, { text: state.input, context: state.context, target: state.target, searchScope: state.scope?.id ?? null }); }
      catch (error) { notify({ tone: "error", text: String(error) }); return; }
    }
    state.setInput(""); state.setCategory(null); state.setScope(null); state.setFileFilter({ types: null, modifiedAfter: null, sourceKind: null }); state.setOverlay(null); state.setView("history");
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    inputRef.current?.focus();
  };
  const historyRows: NavigationRow[] = [
    ...(savedSearches.data?.searches ?? []).map(search => ({ id: `home:search:${search.id}`, title: search.name, subtitle: [search.kind ? t(KIND_HINT[search.kind]) : t("launcher.saved.all_kinds"), search.query].filter(Boolean).join(" · "), Icon: Bookmark, run: () => applySavedSearch(search), remove: () => { void deleteSavedSearch(search.id); } })),
    ...(conversations.data?.items ?? []).map(item => ({ id: `home:chat:${item.id}`, title: item.title, subtitle: t(item.kind === "day" ? "launcher.idle.day" : "launcher.idle.conversation"), Icon: MessageSquare, openInApp: () => openInApp(workspaceSessionRoute(item.workspaceId, item.sessionId)), run: async () => { store.bindConversation(item); await adoptDraft(item.id, true); store.setView("conversation"); inputRef.current?.focus(); } })),
  ].filter(row => `${row.title} ${row.subtitle}`.toLocaleLowerCase().includes(store.input.trim().toLocaleLowerCase()));
  const homeRows: NavigationRow[] = [
    ...(store.workspaceContext ? [{ id: "home:project-chat", title: t("launcher.suggest.project_chat", { project: store.workspaceContext.workspaceName }), Icon: MessageSquare, run: startProjectConversation }] : []),
    ...parkedDrafts.map((draft, index) => ({ id: `home:parked-draft:${index}`, title: t("launcher.flow.continue_draft"), subtitle: draft.workspaceContext?.workspaceName ?? t("assistant.title"), Icon: MessageSquare, run: async () => { useLauncherStore.setState({ ...draft, view: "conversation" }); if (draft.conversation) await adoptDraft(draft.conversation.conversationId, true); setParkedDrafts(previous => previous.filter(item => item !== draft)); } })),
    ...(store.workspaceContext?.document ? [{ id: "home:summarize-view", title: t("launcher.suggest.summarize_document"), subtitle: store.workspaceContext.document.name, Icon: FilePlus2, run: summarizeDocument }] : []),
    ...suggestedRecents(recents.map(item => ({ ...item, result: withFileOrigin(item.result) })).filter(item => visibleResult(item.result) && (!item.result.workspaceId || workspaces.some(workspace => workspace.id === item.result.workspaceId) || item.result.sourceId === "assistant") && !(store.workspaceContext?.document && item.result.workspaceId === store.workspaceContext.document.workspaceId && item.result.path === store.workspaceContext.document.path)), store.workspaceContext?.workspaceId).map(item => ({
      id: `home:recent:${resultKey(item.result)}`, result: item.result, title: item.result.title, subtitle: [t("launcher.suggest.recent"), item.result.subtitle].filter(Boolean).join(" · "), meta: item.result.kind === "files" ? <><LauncherFileOrigin item={item.result} /> · {t("launcher.suggest.recent")}</> : undefined, Icon: resultIcon(item.result), run: () => runResultAction(item.result, "open"),
    })),
    ...searchRoots.filter(visibleResult).map(result => ({ id: `home:folder:${result.id}`, title: result.title, Icon: Folder, result, run: () => showDetail(result) })),
    ...categoryRows.map(row => ({ ...row, subtitle: row.id !== "category:projects" ? store.workspaceContext?.workspaceName : undefined, run: () => { const context = store.workspaceContext; store.setScope(context && row.id !== "category:projects" ? { id: context.workspaceId, name: context.workspaceName } : null); return row.run(); } })),
    ...(store.workspaceContext ? [{ id: "home:create-task", title: t("launcher.flow.create_task"), subtitle: store.workspaceContext.workspaceName, Icon: ListChecks, run: () => openCreate("task", "") }] : []),
    ...(desktop && !voice?.meeting ? [recordMeetingRow] : []),
    ...(desktop ? [{ id: "home:capture-region", title: t("launcher.context.capture_region"), Icon: ScanLine, run: captureActions.region }] : []),
    ...(store.attentionCount ? [{ id: "home:work", title: t("launcher.flow.work"), subtitle: t("launcher.work.pending", { count: store.attentionCount }), Icon: ListChecks, run: () => openWork() }] : []),
    { id: "home:history", title: t("launcher.flow.history"), Icon: MessageSquare, run: openHistory },
  ];
  const detailRows: NavigationRow[] = store.detail?.result.kind === "projects" && !store.detail.category
    ? ["files", "tasks", "chats", "recordings"].flatMap(kind => {
      const category = LAUNCHER_SEARCH_KINDS.find(item => item === kind);
      return category && (t(KIND_HINT[category]).toLocaleLowerCase().includes(store.input.toLocaleLowerCase()) || categorySuggestions(store.input, aliases).includes(category) || namedCategoryQuery(store.input)?.category === category) ? [{ id: `detail:${category}`, title: t("launcher.suggest.browse", { category: t(KIND_HINT[category]) }), Icon: CATEGORY_ICONS[category], run: () => { if (store.detail) showDetail(store.detail.result, category); }, openInApp: () => { if (store.detail) void openDetailInApp({ result: store.detail.result, category }).catch(error => notify({ tone: "error", text: String(error) })); } }] : [];
    })
    : (detailItems.isError ? [] : detailItems.data?.items ?? []).filter(item => !hiddenIds.has(resultKey(item)) && !isLauncherInternalPath(item.path ?? item.id)).map(result => ({ id: resultKey(result), title: result.title, subtitle: result.fileType === "folder" ? t("launcher.detail.folder") : result.subtitle, meta: result.kind === "files" ? <LauncherFileOrigin item={result} /> : undefined, Icon: resultIcon(result), result, run: () => runResultAction(result, "open") }));
  const hiddenRows: NavigationRow[] = hidden.filter(item => item.title.toLocaleLowerCase().includes(store.input.toLocaleLowerCase())).map(item => ({ id: `restore:${item.id}`, title: item.title, subtitle: t("launcher.result_action.unhide"), Icon: Eye, restorable: true, run: () => restoreItem(item.id) }));
  const navigationRows = (store.view === "history" ? historyRows : store.view === "hidden" ? hiddenRows : store.view === "detail" ? [...(store.detail && (store.detail.result.kind === "projects" || store.detail.result.fileType === "folder") ? typedFilters : []), ...detailRows] : showCommands && store.view !== "conversation" ? commandContextRows : store.view === "idle" ? homeRows : store.view === "results" ? suggestionRows : []).filter(row => !hiddenIds.has(row.hideId ?? (row.result ? resultKey(row.result) : row.id)));

  const selectable: SelectableItem[] = mode === "ask" ? [] : [
    ...navigationRows.map(item => ({ id: item.id, primaryAction: "open" as const })),
    ...(showCommands ? commandItems.map(item => ({ id: item.id, primaryAction: item.kind === "agent" ? "run" as const : "open" as const }))
      : store.view === "results" ? calculation ? calculation.value !== null ? [{ id: "calculator", primaryAction: "copy-reference" as const }] : [] : visibleResults.map(item => ({ id: resultKey(item), primaryAction: primaryResultAction(item) })) : []),
  ];
  const selectionSignature = JSON.stringify(selectable.map(item => item.id));
  useEffect(() => {
    const state = useLauncherStore.getState();
    const next = reconcileSelection(state.selection, selectable);
    if (next.id !== state.selection.id || next.source !== state.selection.source) state.select(next);
    // The row identities, not changing labels, determine selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionSignature, store.view, store.selection.id, store.selection.source]);
  useEffect(() => {
    bodyRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [store.selection.id, store.view, selectionSignature]);
  const selected = enterTarget(store.selection, selectable);
  const selectedNavigation = navigationRows.find(item => item.id === selected?.id);
  const runNavigation = (row: NavigationRow) => { if (sendingRef.current || uploadingRef.current) return; return void Promise.resolve().then(row.run).catch(error => notify({ tone: "error", text: String(error) })); };
  const renderNavigationRows = (rows: NavigationRow[]) => <LauncherNavigationRows onOpenActions={id => openActions(id)} rows={rows.filter(row => navigationRows.some(visible => visible.id === row.id)).map(row => ({ ...row, run: () => { if (!sendingRef.current && !uploadingRef.current) return row.run(); } }))} selected={selected?.id ?? null} onSelect={id => store.select({ id, source: "user" })} onError={error => notify({ tone: "error", text: String(error) })} />;
  const copyCalculation = async () => {
    if (calculation?.value === null || !calculation) return;
    try { await navigator.clipboard.writeText(calculation.value); notify({ tone: "info", text: t("launcher.notice.copied") }); }
    catch { notify({ tone: "error", text: t("launcher.calculator.copy_failed") }); }
  };
  const goBack = async () => {
    if (savingNavigation.current) return;
    const state = useLauncherStore.getState();
    if (creation) { setCreation(null); refocusEntry(); return; }
    if (transfer) { setTransfer(null); refocusEntry(); return; }
    if (openChoice) { setOpenChoice(null); refocusEntry(); return; }
    if (state.view === "conversation" && parseLauncherEntry(state.input).mode === "command" && !state.overlay) { state.setInput(""); inputRef.current?.focus(); return; }
    const layer = escapeAction({ overlayOpen: state.overlay !== null, detail: ["conversation", "work", "detail", "hidden", "history"].includes(state.view), query: Boolean(state.input), category: Boolean(state.category || state.scope || hasFileFilter) });
    if (layer === "overlay") state.setOverlay(null);
    else if (layer === "view") {
      savingNavigation.current = true;
      if (state.view === "conversation" && state.conversation && drafts.owns(state.conversation.conversationId, owner)) {
        try { await saveDraft(state.conversation.conversationId, owner, { text: state.input, context: state.context, target: state.target, searchScope: state.scope?.id ?? null }); }
        catch (error) { savingNavigation.current = false; notify({ tone: "error", text: String(error) }); return; }
      }
      const previous = navigation.current.back(state);
      useLauncherStore.setState(previous);
      if (previous.view !== "conversation") useLauncherStore.getState().setTarget({ kind: "assistant" });
      if (previous.view === "conversation" && previous.conversation) {
        try { await adoptDraft(previous.conversation.conversationId, true); }
        catch (error) { notify({ tone: "error", text: String(error) }); }
      }
      savingNavigation.current = false;
    } else if (layer === "query") { state.setInput(""); state.select({ id: null, source: "auto" }); }
    else if (layer === "filter") { state.setCategory(null); state.setScope(null); state.setFileFilter({ types: null, modifiedAfter: null, sourceKind: null }); }
    else dismiss();
    inputRef.current?.focus();
  };
  const openWork = async () => {
    if (store.view === "work") { await goBack(); return; }
    const state = useLauncherStore.getState();
    if (state.view === "conversation" && state.conversation && drafts.owns(state.conversation.conversationId, owner)) {
      try { await saveDraft(state.conversation.conversationId, owner, { text: state.input, context: state.context, target: state.target, searchScope: state.scope?.id ?? null }); }
      catch (error) { notify({ tone: "error", text: String(error) }); return; }
    }
    store.setInput(""); store.setView("work"); inputRef.current?.focus();
  };
  const openActions = (id = selected?.id) => {
    if (!id || calculation) return;
    const row = navigationRows.find(item => item.id === id);
    store.setOverlay(row && !row.result ? { kind: "navigation-actions", id } : { kind: "actions", resultKey: row?.result ? resultKey(row.result) : id });
  };
  // Shared by the entry and home rows; native menus get first refusal.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || isComposingKeyEvent(event) || creation || transfer) return;
    const key = event.key;
    if (key === "Escape") { event.preventDefault(); event.stopPropagation(); void goBack(); return; }
    const modifier = isMacPlatform() ? event.metaKey : event.ctrlKey;
    if (hasSelectedText && modifier && !event.altKey && !event.shiftKey && ["1", "2", "3", "4"].includes(key)) {
      event.preventDefault(); event.stopPropagation();
      if (key === "4") openCreate("attach");
      else selectionAction(key === "1" ? "explain" : key === "2" ? "translate" : "rewrite");
      return;
    }
    const input = inputRef.current;
    if (!input || (event.target !== input && !(event.target instanceof Element && event.target.matches("[data-launcher-item]")))) return;
    if (!selectable.length && (event.key === "ArrowDown" || event.key === "Tab" && !event.shiftKey) && !modifier && !event.altKey) {
      const controls = bodyRef.current?.querySelector<HTMLElement>("[data-launcher-controls]");
      if (controls) { event.preventDefault(); (launcherControls(controls)[0] ?? controls).focus(); return; }
    }
    if (isAskShortcut({ key, modifier, shift: event.shiftKey, mode, command: showCommands })) { event.preventDefault(); void submitAsk(mode === "ask" ? entry.text : store.input); return; }
    if ((modifier && key.toLowerCase() === "k") || (key === "ArrowRight" && !event.shiftKey && !event.altKey && !modifier && input.selectionStart === input.selectionEnd && input.selectionEnd === input.value.length)) {
      if (selected && !calculation) { event.preventDefault(); event.stopPropagation(); openActions(); }
      return;
    }
    if (modifier && key.toLowerCase() === "y") {
      event.preventDefault(); event.stopPropagation();
      const result = selectedNavigation?.result ?? visibleResults.find(item => resultKey(item) === selected?.id);
      if (result && canPreviewResult(result)) store.setOverlay(store.overlay?.kind === "preview" ? null : { kind: "preview", resultKey: resultKey(result) });
      return;
    }
    if (modifier && key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); void saveCurrentSearch(); return; }
    if (openChoice) return;
    if (key === "ArrowDown" || key === "ArrowUp") { if (!selectable.length || event.shiftKey || modifier || event.altKey) return; event.preventDefault(); store.select(moveSelection(store.selection, selectable, key === "ArrowDown" ? 1 : -1)); return; }
    if (key === "Tab" && !event.shiftKey && !modifier && (selectedNavigation?.id.startsWith("category:") || selectedNavigation?.id.startsWith("filter:")) && store.input.trim()) { event.preventDefault(); runNavigation(selectedNavigation); return; }
    if (key === "Tab" && !event.shiftKey && showCommands) {
      const item = commandItems.find(item => item.id === selected?.id);
      if (item) { event.preventDefault(); const args = catalogArguments(item, entry.text); store.setInput(`/${item.command?.name ?? item.label.replace(/^\//, "")}${args ? ` ${args}` : " "}`); }
      return;
    }
    if (key === "Tab" && !event.shiftKey && !store.category && mode === "search" && (store.view === "idle" || store.view === "results")) {
      const activated = activateCategoryAlias(store.input, aliases, "tab");
      if (activated) { event.preventDefault(); store.setCategory(activated.category); store.setInput(activated.rest); }
      return;
    }
    if (key === "Backspace" && input.selectionStart === 0 && input.selectionEnd === 0 && mode === "search") {
      if (store.fileFilter.modifiedAfter) { event.preventDefault(); store.setFileFilter({ modifiedAfter: null }); }
      else if (store.fileFilter.sourceKind) { event.preventDefault(); store.setFileFilter({ sourceKind: null }); }
      else if (store.fileFilter.types?.length) { event.preventDefault(); store.setFileFilter({ types: null }); }
      else if (store.scope) { event.preventDefault(); store.setScope(null); }
      else if (store.category) { event.preventDefault(); store.setCategory(null); }
      return;
    }
    if (key !== "Enter") return;
    if (event.shiftKey && (mode === "ask" || mode === "conversation")) return;
    event.preventDefault();
    if (event.shiftKey) return;
    if (selectedNavigation && mode !== "ask") { runNavigation(selectedNavigation); return; }
    if (showCommands) { const item = commandItems.find(item => item.id === selected?.id); if (item) void runCatalogEntry(item, catalogArguments(item, entry.text)); return; }
    if (mode === "ask" || mode === "conversation") { void submitAsk(mode === "ask" ? entry.text : store.input); return; }
    if (calculation) { void copyCalculation(); return; }
    const result = store.results.find(item => resultKey(item) === selected?.id);
    if (result) void runResultAction(result, primaryResultAction(result));
  };
  const onInputChange = (value: string) => {
    if (store.view === "work") store.setView("idle");
    if (store.view === "detail" && store.detail && ["tasks", "recordings"].includes(store.detail.result.kind)) useLauncherStore.setState({ view: "results", detail: null });
    if (!value) { store.setInput(""); return; }
    if (pastedText.current) { pastedText.current = false; store.setInput(value); return; }
    if (!store.category && mode === "search" && (store.view === "idle" || store.view === "results")) {
      const activated = activateCategoryAlias(value, aliases);
      if (activated) { store.setCategory(activated.category); if (activated.category !== "files") store.setFileFilter({ types: null }); store.setInput(activated.rest); return; }
    }
    store.setInput(value);
  };
  const resetPosition = async () => {
    try {
      if (desktop) {
        const state = await launcherWindowControl("reset-position");
        store.setPositionMoved(state.moved);
      } else window.dispatchEvent(new Event("legalwork:launcher-reset-position"));
      inputRef.current?.focus();
    } catch (error) { notify({ tone: "error", text: String(error) }); }
  };
  const openConversationInApp = async () => {
    if (!conversation) return;
    const bound = conversation;
    const live = useLauncherStore.getState();
    await saveDraft(bound.conversationId, owner, { text: mode === "ask" ? entry.text : live.input, context: live.context,
      target: live.target, searchScope: live.scope?.id ?? null, model: local.prefs.defaultModel, variant: local.prefs.modelVariant });
    await drafts.release(bound.conversationId, owner);
    openInApp(`${workspaceSessionRoute(bound.workspaceId, bound.sessionId)}?conversation=${encodeURIComponent(bound.conversationId)}`);
  };

  const selectedResult = !calculation ? [...visibleResults, ...navigationRows.flatMap(row => row.result ? [row.result] : [])].find(item => resultKey(item) === (store.overlay?.kind === "actions" || store.overlay?.kind === "preview" ? store.overlay.resultKey : selectedNavigation?.result ? resultKey(selectedNavigation.result) : store.selection.id)) ?? null : null;
  const actionRow = store.overlay?.kind === "navigation-actions" ? navigationRows.find(row => row.id === (store.overlay?.kind === "navigation-actions" ? store.overlay.id : "")) : null;
  const verb = footerVerb(selected, showCommands ? "command" : mode);
  const pinnedKeys = useMemo(() => new Set(pins.map(pin => `${pin.kind}\u0000${pin.sourceId}\u0000${pin.id}`)), [pins]);
  const chatTargetName = store.target.kind === "project" ? workspaces.find(item => item.id === (store.target.kind === "project" ? store.target.workspaceId : ""))?.name ?? "" : assistant?.profile.name ?? t("assistant.title");
  const placeholder = mode === "conversation" ? t("launcher.placeholder.conversation", { name: chatTargetName }) : store.category ? t("launcher.placeholder.category", { kind: t(KIND_HINT[store.category]) }) : t("launcher.placeholder.search");

  return <div className="launcher-root" data-surface={surface} data-view={store.view} data-expanded={expanded || undefined} data-form-active={formActive || undefined} onKeyDown={onKeyDown}
    onDragEnter={event => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); if (dragDepth.current++ === 0) { setDragging(true); holdPanel(true); } }}
    onDragOver={event => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = uploading ? "none" : "copy"; } }}
    onDragLeave={event => { if (!event.dataTransfer.types.includes("Files") || !dragDepth.current) return; event.preventDefault(); if (--dragDepth.current === 0) { setDragging(false); holdPanel(false); } }}
    onDrop={event => { if (!event.dataTransfer.types.includes("Files")) return; event.preventDefault(); if (dragDepth.current) holdPanel(false); dragDepth.current = 0; setDragging(false); const dropped = droppedFiles(event.dataTransfer); if (dropped.folders) notify({ tone: "error", text: t("launcher.drop.folders") }); void uploadFiles(dropped.files); }}>
    <div className="launcher-panel" role="dialog" aria-label={t("launcher.title")}>
      {(dragging || uploading) && <div className="launcher-drop-status" role="status">{uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}{t(uploading ? "launcher.drop.busy" : "launcher.drop.hint")}</div>}
      {pendingContext && <div className="launcher-notice launcher-context-switch">{t("launcher.flow.new_context", { project: pendingContext.context?.workspaceName ?? t("assistant.title") })}<Button size="sm" variant="ghost" onClick={() => void useContext(pendingContext.context)}>{t("launcher.flow.use_context")}</Button><Button size="sm" variant="ghost" onClick={() => setPendingContext(null)}>{t("launcher.flow.keep_context")}</Button></div>}

      <div className="launcher-entry">
        {(["conversation", "work", "detail", "hidden", "history"].includes(store.view)) ? <Button variant="ghost" size="icon-sm" aria-label={t("launcher.back")} title={t("launcher.back")} onClick={() => void goBack()}><ArrowLeft className="size-4" /></Button> : <AssistantAvatar icon={assistant?.profile.icon} className="size-6" motion={sending ? "thinking" : undefined} />}
        <div className="launcher-entry-main">
        {hasSearchChips && <div className="launcher-chips">
        {store.category && !(store.category === "files" && store.fileFilter.types?.length) && <span className="launcher-chip" data-kind="category" title={t(KIND_HINT[store.category])}><span>{t(KIND_HINT[store.category])}</span><button type="button" aria-label={t("launcher.chip.remove_category")} onClick={() => { store.setCategory(null); inputRef.current?.focus(); }}><X className="size-3" /></button></span>}
        {store.scope && <span className="launcher-chip" data-kind="scope" title={store.scope.name}><span>{store.scope.name}</span><button type="button" aria-label={t("launcher.chip.remove_scope")} onClick={() => { store.setScope(null); inputRef.current?.focus(); }}><X className="size-3" /></button></span>}

        {(() => { const labels = fileFilterLabels(store.fileFilter); return <>
          {labels.type && <span className="launcher-chip" data-kind="filter" title={labels.type}><span>{labels.type}</span><button type="button" aria-label={t("launcher.filter.types_any")} onClick={() => { store.setFileFilter({ types: null }); inputRef.current?.focus(); }}><X className="size-3" /></button></span>}
          {labels.source && <span className="launcher-chip" data-kind="source" title={labels.source}><span>{labels.source}</span><button type="button" aria-label={t("launcher.filter.sources_any")} onClick={() => { store.setFileFilter({ sourceKind: null }); inputRef.current?.focus(); }}><X className="size-3" /></button></span>}
          {labels.modified && <span className="launcher-chip" data-kind="filter" title={labels.modified}><span>{labels.modified}</span><button type="button" aria-label={t("launcher.filter.modified_any")} onClick={() => { store.setFileFilter({ modifiedAfter: null }); inputRef.current?.focus(); }}><X className="size-3" /></button></span>}
        </>; })()}
        </div>}
        <div className="launcher-input-viewport" data-fade-left={singleLineInput && hasSearchChips && inputOverflowLeft || undefined}>
        <textarea ref={inputRef} className="launcher-input" wrap={singleLineInput ? "off" : "soft"} data-single-line={singleLineInput || undefined} onScroll={event => setInputOverflowLeft(event.currentTarget.scrollLeft > 1)} rows={1} value={store.input} placeholder={placeholder} aria-label={t("launcher.title")} autoFocus autoComplete="off" spellCheck={false} onChange={event => onInputChange(event.target.value)} role={selectable.length ? "combobox" : undefined} aria-autocomplete={selectable.length ? "list" : undefined} aria-expanded={selectable.length ? true : undefined} aria-controls={selectable.length ? "launcher-options" : undefined} aria-activedescendant={selected ? optionId(selected.id) : undefined}
          onFocus={() => { if (store.view === "conversation" && conversation && !drafts.owns(conversation.conversationId, owner)) void adoptDraft(conversation.conversationId, true); }}
          onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void uploadFiles(files); } else if (event.clipboardData.getData("text")) pastedText.current = true; }} />
        </div>
        </div>
        <div className="launcher-entry-actions">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("launcher.context.add")} title={t("launcher.context.add")} />}><Plus className="size-4" /></DropdownMenuTrigger>
            <DropdownMenuContent align="end" finalFocus={inputRef}>
              {desktop && <DropdownMenuItem disabled={!store.origin?.supportsSelection} title={store.origin?.platform === "windows" && !store.origin.supportsSelection ? t("launcher.context.selection_windows_hint") : undefined} onClick={() => void captureActions.selection()}><MousePointerSquareDashed className="size-4" />{t("launcher.context.add_selection")}{store.origin?.app ? ` (${store.origin.app})` : ""}</DropdownMenuItem>}
              <DropdownMenuItem onClick={() => void captureActions.clipboard()}><Clipboard className="size-4" />{t("launcher.context.paste_clipboard")}</DropdownMenuItem>
              <DropdownMenuItem onClick={captureActions.files}><Paperclip className="size-4" />{t("launcher.context.attach_file")}</DropdownMenuItem>
              {desktop && <><DropdownMenuSeparator /><DropdownMenuItem onClick={() => void captureActions.window()}><FilePlus2 className="size-4" />{t("launcher.context.capture_window")}</DropdownMenuItem><DropdownMenuItem onClick={() => void captureActions.region()}><ScanLine className="size-4" />{t("launcher.context.capture_region")}</DropdownMenuItem></>}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("launcher.menu.title")} />}><MoreHorizontal className="size-4" /></DropdownMenuTrigger>
            <DropdownMenuContent align="end" finalFocus={inputRef}>
              <DropdownMenuItem onClick={openHistory}><MessageSquare className="size-4" />{t("launcher.flow.history")}</DropdownMenuItem>
              <DropdownMenuItem disabled={!canSaveSearch} onClick={() => void saveCurrentSearch()}><Bookmark className="size-4" />{t("launcher.result_action.save-search")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => { store.setInput(""); store.setView("hidden"); refocusEntry(); }}><EyeOff className="size-4" />{t("launcher.hidden.title", { count: hidden.length })}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="icon-sm" aria-label={t("launcher.voice.speak")} title={t("launcher.voice.speak")} disabled={!dictation.supported || dictation.blocked || voiceBusy} onClick={() => void speak()}><Mic className="size-4" /></Button>


        </div>
      </div>
      {desktop && <LauncherOutputHistory visible={store.visible} />}
      <input ref={fileInputRef} type="file" multiple className="hidden" onChange={event => { holdPanel(false); const files = Array.from(event.target.files ?? []); event.target.value = ""; void uploadFiles(files); }} />
      {shell.bootstrapError && <div className="launcher-notice flex items-center justify-between gap-2" data-tone="error" role="alert">
        <span>{shell.bootstrapError}</span><Button size="sm" variant="ghost" onClick={() => void shell.refresh()}>{t("scheduled.retry")}</Button>
      </div>}
      {store.notice && <div className="launcher-notice" data-tone={store.notice.tone} role={store.notice.tone === "error" ? "alert" : "status"}>{store.notice.text}<button type="button" className="float-right" aria-label={t("common.close")} onClick={() => notify(null)}><X className="size-3.5" /></button></div>}
      {store.approval && surface === "panel" && <LauncherApprovalCard request={store.approval} onReply={async (id, decision) => { try { await launcherApprovalReply(id, decision); } finally { useLauncherStore.getState().setApproval(null); } }} />}
      {dictation.active && <div className="px-3 pt-2"><ComposerDictationBar dictation={dictation} sendDisabled={sending} /></div>}
      {store.context.length > 0 && <LauncherContextBar />}
      {store.context.some(item => item.id.startsWith("view_")) && <p className="px-3 text-xs text-muted-foreground">{t("launcher.flow.saved_reference")}</p>}
      {hasSelectedText && !formActive && <div className="launcher-context-actions">
        <Button variant="ghost" size="sm" disabled={sending} onClick={() => selectionAction("explain")}>{t("launcher.flow.explain")}<kbd>{mod}1</kbd></Button>
        <Button variant="ghost" size="sm" disabled={sending} onClick={() => selectionAction("translate")}>{t("launcher.flow.translate")}<kbd>{mod}2</kbd></Button>
        <select aria-label={t("launcher.flow.translation_language")} title={t("launcher.flow.translation_language")} value={translationLanguage} onChange={event => { setTranslationLanguage(event.target.value); try { window.localStorage.setItem(TRANSLATION_LANGUAGE_KEY, event.target.value); } catch { /* Preference stays active for this window. */ } }}>
          <option value="system">{t("launcher.flow.translation_system")}</option><option value="English">English</option><option value="German">Deutsch</option><option value="French">Français</option><option value="Spanish">Español</option><option value="Italian">Italiano</option>
        </select>
        <Button variant="ghost" size="sm" disabled={sending} onClick={() => selectionAction("rewrite")}>{t("launcher.flow.rewrite")}<kbd>{mod}3</kbd></Button>
        <Button variant="ghost" size="sm" onClick={() => openCreate("attach")}>{t("launcher.flow.create_attach")}<kbd>{mod}4</kbd></Button>
        <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={t("launcher.footer.actions")} title={t("launcher.footer.actions")} />}><MoreHorizontal className="size-4" /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => openCreate("excerpt")}>{t("launcher.flow.create_excerpt")}</DropdownMenuItem><DropdownMenuItem onClick={() => openCreate("task")}>{t("launcher.flow.create_task")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
      </div>}
      {store.view !== "conversation" && attentionItems.length > 0 && <AttentionCards items={attentionItems} busy={attentionBusy} onReply={replyAttention} onOpen={item => openInApp(workspaceSessionRoute(item.workspaceId, item.sessionId))} />}
      <div ref={bodyRef} className="launcher-body" onScroll={event => { if (event.currentTarget.scrollTop > 48 && !expandedByScroll) setScrollExpansion({ view: store.view, category: store.category }); }}>
        {transfer ? <LauncherTransferForm transfer={transfer} onClose={() => { setTransfer(null); store.clearMultiSelect(); runSearch(); refocusEntry(); }} /> : creation ? <LauncherCreateForm initial={creation} onClose={() => { setCreation(null); requestAnimationFrame(() => (bodyRef.current?.querySelector<HTMLElement>("[data-launcher-controls]") ?? inputRef.current)?.focus()); }} onAttach={stageInChat} onDraft={draftDocument}
          onTaskCreated={(task, workspaceId) => showDetail({ id: task.id, kind: "tasks", workspaceId, sourceId: "tasks", title: task.title, updatedAt: Date.parse(task.updatedAt), score: 0, match: "recent", completed: task.status === "done", actions: ["open", "complete", "hand-to-assistant"] })} /> : openChoice ? <div className="launcher-open-choice" onKeyDown={event => handleLauncherFocusKey(event, event.currentTarget, true)}>
          <strong>{t("launcher.flow.where_open")}</strong><p>{openChoice.title}</p>
          <Button autoFocus variant="outline" onClick={() => openFile(openChoice, openChoice.workspaceId ?? "")}>{t("launcher.flow.open_original", { project: workspaces.find(item => item.id === openChoice.workspaceId)?.name ?? openChoice.subtitle ?? "" })}</Button>
          <Button variant="outline" onClick={() => { if (store.workspaceContext) openFile(openChoice, store.workspaceContext.workspaceId, store.workspaceContext.paneId); }}>{t("launcher.flow.open_here", { project: store.workspaceContext?.workspaceName ?? "" })}</Button>
          <p className="text-xs text-muted-foreground">{t("launcher.flow.linked_hint")}</p>
        </div> : <>
        {showCommands && store.view === "conversation" && <SubmissionStatusRow submission={submission} onRetry={retrySubmission} />}
        {store.view === "results" && !calculation && <div id="launcher-options" role="listbox" aria-label={t("launcher.results.title")} aria-multiselectable>
          {renderNavigationRows(suggestionRows)}
          <LauncherResultList items={visibleResults} sources={store.sources} query={searchText} selectedKey={store.selection.id} multiSelect={store.multiSelect} pins={pinnedKeys} pending={store.searchPending} hideEmpty={navigationRows.length > 0}
            onSelect={key => { if (store.overlay?.kind !== "actions") store.select({ id: key, source: "user" }); }} onRun={(result, action) => void runResultAction(result, action)} onToggleMulti={store.toggleMultiSelect} onOpenActions={key => store.setOverlay({ kind: "actions", resultKey: key })} />

          {store.searchError && <p className="launcher-notice" data-tone="error">{store.searchError}</p>}
        </div>}
        {store.view === "results" && calculation && <div className="launcher-calculator" id="launcher-options" role="listbox" aria-label={t("launcher.calculator.title")}>
          {calculation.value !== null ? <div id={optionId("calculator")} role="option" aria-selected={selected?.id === "calculator"} data-selected={selected?.id === "calculator"} data-launcher-item className="launcher-row" onClick={() => void copyCalculation()}>
            <Calculator className="size-5 text-muted-foreground" /><div className="launcher-row-main"><div className="launcher-calculator-expression">{calculation.expression}</div><div className="launcher-calculator-value">{calculation.value}</div></div>
          </div> : <div className="launcher-empty">{t(calculation.error === "undefined" ? "launcher.calculator.undefined" : "launcher.calculator.incomplete")}</div>}
        </div>}
        {showCommands && store.view !== "conversation" && <><p className="launcher-section-title">{t("launcher.commands.choose_context")}</p><div id="launcher-options" role="listbox" aria-label={t("launcher.commands.choose_context")}>{renderNavigationRows(commandContextRows)}</div></>}
        {showCommands && store.view === "conversation" && (commandItems.length ? <div id="launcher-options" role="listbox" aria-label={t("launcher.commands.title")}>{commandItems.map(item => <div key={item.id} id={optionId(item.id)} data-launcher-item role="option" aria-selected={store.selection.id === item.id} data-selected={store.selection.id === item.id} className="launcher-row" onMouseMove={() => store.select({ id: item.id, source: "user" })} onClick={() => void runCatalogEntry(item)}>
          <span className="launcher-row-icon"><Sparkles className="size-4" /></span>
          <div className="launcher-row-main"><div className="launcher-row-title">{item.label}{item.favorite ? " ★" : ""}</div><div className="launcher-row-meta">{[t(`launcher.action_kind.${item.kind}`), item.source === "quick-action" ? t("launcher.source.quick_action") : item.source === "command" ? t("launcher.source.command") : item.source === "skill" ? t("launcher.source.skill") : null, item.requires.length ? t("launcher.requires", { inputs: item.requires.map(input => t(`launcher.input.${input}`)).join(", ") }) : null, item.description].filter(Boolean).join(" · ")}</div></div>
          <span className="launcher-row-hint">{item.shortcut}</span>
        </div>)}</div> : <div className="launcher-empty">{t(catalogQuery.isPending || skillsQuery.isLoading ? "launcher.coverage.searching" : "launcher.commands_empty")}</div>)}
        {store.view === "conversation" && !showCommands && conversation && <LauncherConversation onSave={text => setCreation({ kind: "document", workspaceId: store.target.kind === "project" ? store.target.workspaceId : "", folder: store.target.kind === "project" && store.target.workspaceId === store.workspaceContext?.workspaceId ? store.workspaceContext.folder ?? "" : "", name: conversation.title.replace(/[/\\]/g, " ").slice(0, 120), text, context: [] })} conversation={conversation} onOpenApp={() => void openConversationInApp().catch(error => notify({ tone: "error", text: String(error) }))} submission={submission} pendingOutput={pendingOutput} onRetry={retrySubmission} onOutputApplied={() => setPendingOutput(null)}
          onArchived={() => { const state = useLauncherStore.getState(); state.bindConversation(null); state.setInput(""); state.replaceContext([]); setSubmission(null); state.setView("idle"); void bindCurrent().catch(() => undefined); }} />}
        {store.view === "conversation" && !showCommands && !conversation && <div className="launcher-empty">{t("launcher.conversation.new_hint")}</div>}
        {store.view === "work" && <LauncherWork onOpenConversation={id => void client.assistantConversation(id).then(({ conversation: found }) => { store.bindConversation(found); store.setView("conversation"); }).catch(() => notify({ tone: "error", text: t("launcher.conversation.unavailable") }))} />}
        {store.view === "history" && <>
          <div className="launcher-detail-heading"><strong>{t("launcher.flow.history")}</strong></div>
          <div id="launcher-options" role="listbox" aria-label={t("launcher.flow.history")}>
            {renderNavigationRows(navigationRows)}
            {!navigationRows.length && <div className="launcher-empty">{savedSearches.isPending || conversations.isPending ? t("launcher.coverage.searching") : t(store.input.trim() ? "content_search.no_results" : "launcher.history.empty")}</div>}
          </div>
          {(savedSearches.isError || conversations.isError) && <p role="alert" className="launcher-notice" data-tone="error">{String(savedSearches.error ?? conversations.error)}</p>}
        </>}
        {(store.view === "detail" || store.view === "hidden") && <>
          <div className="launcher-detail-heading"><strong>{store.view === "hidden" ? t("launcher.hidden.title", { count: hidden.length }) : store.detail?.result.kind === "tasks" ? t("tasks.column_title") : [store.detail?.result.title, store.detail?.category ? t(KIND_HINT[store.detail.category]) : null].filter(Boolean).join(" / ")}</strong>
            {store.view === "hidden" && hidden.length > 0 ? <Button size="sm" variant="ghost" onClick={() => restoreItem()}>{t("launcher.hidden.restore_all")}</Button> : store.view === "detail" && store.detail && store.detail.result.kind !== "tasks" && <Button size="sm" variant="ghost" onClick={() => { if (store.detail) void openDetailInApp(store.detail).catch(error => notify({ tone: "error", text: String(error) })); }}>{t("launcher.result_action.open-in-app")}</Button>}
          </div>
          {store.view === "detail" && store.detail?.result.kind === "tasks" ? <LauncherTaskDetail key={store.detail.result.id} result={store.detail.result} onOpenApp={() => { if (store.detail) void openDetailInApp(store.detail).catch(error => notify({ tone: "error", text: String(error) })); }} onOpenChat={(sessionId, workspaceId) => { if (store.detail) void runResultAction({ ...store.detail.result, id: sessionId, sessionId, workspaceId, kind: "chats", sourceId: `local:${workspaceId}` }, "open"); }} />
            : store.view === "detail" && store.detail?.result.kind === "recordings" ? <LauncherPreviewPane result={store.detail.result} detail />
            : <div id="launcher-options" role="listbox" aria-label={t("launcher.title")}>{renderNavigationRows(navigationRows)}{!navigationRows.length && <div className="launcher-empty">{detailItems.isFetching && store.view === "detail" ? t("launcher.coverage.searching") : t("content_search.no_results")}</div>}{detailItems.isError && store.view === "detail" && <p role="alert">{String(detailItems.error)}</p>}{detailItems.data?.truncated && <p className="launcher-preview-note">{t("launcher.coverage.partial")}</p>}</div>}
        </>}
        {store.view === "idle" && mode !== "ask" && <div className="launcher-idle" id="launcher-options" role="listbox" aria-label={t("launcher.title")}>
          {renderNavigationRows(navigationRows)}
        </div>}
        </>}
      </div>
          {store.overlay?.kind === "actions" && selectedResult && <LauncherActionMenu result={selectedResult} multiSelected={store.multiSelect.size} pinned={isPinned(pins, selectedResult)} extra={["open-in-app", ...(canCopyLauncherResult(selectedResult, localFiles) ? ["copy-to-clipboard" as const] : []), ...(canPreviewResult(selectedResult) ? ["preview" as const] : []), "hide"]} projects={workspaces.filter(workspace => workspace.id !== selectedResult.workspaceId).map(workspace => ({ id: workspace.id, name: workspace.displayName || workspace.name }))}
            onTransfer={(action, projectId) => { store.setOverlay(null); void transferFiles(selectedResult, action, projectId); }}
            onRun={action => { store.setOverlay(null); void runResultAction(selectedResult, action); inputRef.current?.focus(); }} onExtra={action => { store.setOverlay(action === "preview" ? { kind: "preview", resultKey: resultKey(selectedResult) } : null); if (action === "open-in-app") void openResultInApp(selectedResult).catch(error => notify({ tone: "error", text: String(error) })); if (action === "copy-to-clipboard") void copyResult(selectedResult); if (action === "hide") hideItem({ id: resultKey(selectedResult), title: selectedResult.title }); inputRef.current?.focus(); }} onClose={() => { store.setOverlay(null); inputRef.current?.focus(); }} />}
      {actionRow && <LauncherRowMenu title={actionRow.title} onClose={() => { store.setOverlay(null); inputRef.current?.focus(); }} actions={[
        ...(actionRow.restorable ? [{ id: "unhide", title: t("launcher.result_action.unhide"), run: () => { store.setOverlay(null); runNavigation(actionRow); inputRef.current?.focus(); } }] : []),
        ...(actionRow.openInApp ? [{ id: "open-in-app", title: t("launcher.result_action.open-in-app"), run: () => { store.setOverlay(null); actionRow.openInApp?.(); } }] : []),
        ...(!actionRow.restorable ? [{ id: "hide", title: t("launcher.result_action.hide"), run: () => { hideItem({ id: actionRow.hideId ?? actionRow.id, title: actionRow.title }); inputRef.current?.focus(); } }] : []),
      ]} />}
      {store.overlay?.kind === "preview" && selectedResult && canPreviewResult(selectedResult) && <LauncherPreviewPane result={selectedResult} />}
      <div className="launcher-footer">
        <span className="launcher-footer-status" aria-live="polite">{sending ? t("launcher.submission.sending") : store.searchPending && !calculation ? <><Loader2 className="size-3 animate-spin motion-reduce:animate-none" />{t("content_search.searching")}</> : store.view === "idle" ? t("launcher.idle.compact_hint", { files: aliases.files }) : store.target.kind === "project" && store.view === "conversation" ? t("launcher.footer.target_bound") : ""}</span>
        <div className="launcher-footer-actions">
          {!transfer && !creation && !openChoice && !showCommands && (store.input.trim() || store.context.length > 0) && <button type="button" disabled={sending || uploading} onClick={() => void submitAsk(mode === "ask" ? entry.text : store.input)}>{store.target.kind === "project" ? t("launcher.flow.ask_project", { project: workspaces.find(item => item.id === (store.target.kind === "project" ? store.target.workspaceId : ""))?.name ?? "" }) : t("launcher.flow.ask")}<kbd>{mod}↵</kbd></button>}
          {!transfer && !creation && !openChoice && (calculation?.value != null ? <button type="button" onClick={() => void copyCalculation()}>{t("launcher.calculator.copy")}<kbd>↵</kbd></button> : verb !== "none" && verb !== "ask" && <span>{actionLabel(verb === "run" ? "run" : verb === "attach" ? "attach" : verb === "resume" ? "resume" : verb === "answer" ? "complete" : "open")}<kbd>↵</kbd></span>)}
          {selected && <button type="button" onClick={() => openActions()} title={`${mod}K`}>{t("launcher.footer.actions")}<kbd>→</kbd></button>}
          <button type="button" onClick={() => void goBack()}>{t(store.view === "idle" && !store.overlay ? "common.close" : "launcher.back")}<kbd>Esc</kbd></button>
        </div>
      </div>
    </div>
    {/* Native drag regions follow DOM order: keep this no-drag control after the drag surface. */}
    {store.positionMoved && <button type="button" className="launcher-position-reset" aria-label={t("launcher.flow.reset_position")} title={t("launcher.flow.reset_position")} onClick={() => void resetPosition()}><RotateCcw className="size-2.5" /></button>}
  </div>;
}
