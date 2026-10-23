import { useMetadataPolling } from "@/react-app/infra/metadata-polling";
import { WikiContentPreview } from "./wiki-content-preview";
import { WikiDiff, WikiContentStats } from "./wiki-diff";
import { t } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Loader2 } from "lucide-react";
import type { WikiSuggestion, WikiSuggestionInput } from "@legalwork/types/wiki-suggestions";
import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { parseWikiPageUrl } from "@legalwork/types/wiki";
import { openDesktopUrl } from "@/app/lib/desktop";
import { wikiPageHeading } from "./wiki-page-heading";
import { Button } from "@/components/ui/button";
import { WikiMarkdownEditor } from "./wiki-markdown-editor";
import { useRequestPanelTab } from "../session/panel/panel-tab-destination";
import { suggestionLocation, suggestionPagePath, suggestionTab } from "./wiki-suggestion-model";
import { wikiPanelTab } from "./wiki-tabs";
import { usePanelTabStore } from "../session/panel/panel-tab-store";
import { WikiSuggestionDestinationPicker } from "./wiki-suggestion-destination";
import { WikiPageHeader } from "./wiki-page-header";
import { resolveWikiLink } from "./wiki-model";
import "./wiki.css";
import { registerUnsavedDocument } from "../session/artifacts/docx-document-state";

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "The suggestion could not be updated.";
const input = (draft: WikiSuggestion): WikiSuggestionInput => ({ title: draft.title, content: draft.content, destination: draft.destination });
const fingerprint = (draft: WikiSuggestion) => JSON.stringify(input(draft));

export function WikiSuggestionPanel({ client, workspaceId, id, tabId }: { client: LegalworkServerClient; workspaceId: string; id: string; tabId: string }) {
  const metadataInterval = useMetadataPolling(client.baseUrl, 3000);
  const cache = useQueryClient(), open = useRequestPanelTab();
  const key = ["wiki-suggestion", client.baseUrl, workspaceId, id];
  const query = useQuery({ queryKey: key, queryFn: () => client.wikiSuggestion(workspaceId, id), refetchInterval: metadataInterval });
  const wikis = useQuery({ queryKey: ["wikis", client.baseUrl], queryFn: () => client.listWikis() });
  const siblings = useQuery({ queryKey: ["wiki-suggestions", client.baseUrl, workspaceId], queryFn: () => client.wikiSuggestions(workspaceId), refetchInterval: metadataInterval });
  const [draft, setDraft] = useState<WikiSuggestion | null>(null);
  const [toolbarTarget, setToolbarTarget] = useState<HTMLDivElement | null>(null);
  const [viewModeRequest, setViewModeRequest] = useState<{ mode: "source" | "rich-text" }>({ mode: "rich-text" });
  const snapshot = useQuery({ queryKey: ["wiki-suggestion-destination", client.baseUrl, draft?.destination.wikiId], queryFn: () => client.wikiSnapshot(draft!.destination.wikiId), enabled: Boolean(draft), refetchInterval: 3000 });
  const replaceTab = usePanelTabStore(state => state.replaceTab);
  useEffect(() => {
    if (draft?.status === "saved") replaceTab(tabId, wikiPanelTab(client.baseUrl, draft.destination.wikiId, { kind: "page", path: draft.destination.path }, wikiPageHeading(draft.content, draft.title).title));
  }, [draft, replaceTab, tabId, client.baseUrl]);
  const current = useRef<WikiSuggestion | null>(null), saved = useRef<string>(""), saving = useRef<Promise<WikiSuggestion> | null>(null);
  const [busy, setBusy] = useState(false), [savingDraft, setSavingDraft] = useState(false), [error, setError] = useState("");
  const [mode, setMode] = useState<"preview" | "diff" | "edit">("preview");
  const destinationPage = useQuery({ queryKey: ["wiki-contribution-current", client.baseUrl, draft?.destination.wikiId, draft?.destination.path, snapshot.data?.pages.find(page => page.path === draft?.destination.path)?.revision], enabled: Boolean(draft), queryFn: async () => {
    if (!draft) throw new Error("The draft is still loading.");
    try { return await client.readWikiPage(draft.destination.wikiId, draft.destination.path); }
    catch (error) { if (error instanceof LegalworkServerError && error.status === 404) return { content: "", revision: "" }; throw error; }
  } });
  const baseline = destinationPage.data?.content ?? "";
  const [existing, setExisting] = useState<{ content: string; revision: string } | null>(null);
  const [conflict, setConflict] = useState<WikiSuggestion | null>(null);
  const dirty = () => Boolean(current.current && fingerprint(current.current) !== saved.current);
  useEffect(() => registerUnsavedDocument(tabId, "Wiki suggestion", dirty), [workspaceId, id, tabId]);
  useEffect(() => {
    if (!query.data || dirty() || saving.current) return;
    current.current = query.data; saved.current = fingerprint(query.data); setDraft(query.data);
  }, [query.data]);
  const change = (update: Partial<WikiSuggestionInput>) => {
    if (!current.current) return;
    const next = { ...current.current, ...update };
    current.current = next; setDraft(next); setError("");
  };
  const handleError = async (error: unknown) => {
    setError(errorMessage(error));
    if (error instanceof LegalworkServerError && ["suggestion_changed", "suggestion_closed"].includes(error.code)) {
      try { setConflict(await client.wikiSuggestion(workspaceId, id)); }
      catch (latestError) { setError(errorMessage(latestError)); }
    }
  };
  const resolveConflict = (keepEdits: boolean) => {
    if (!conflict || !current.current) return;
    const next = keepEdits ? { ...conflict, ...input(current.current) } : conflict;
    saved.current = fingerprint(conflict); current.current = next; setDraft(next);
    setConflict(null); setError(""); cache.setQueryData(key, conflict);
  };
  const persist = async (): Promise<WikiSuggestion> => {
    if (saving.current) { await saving.current; return persist(); }
    if (!current.current) throw new Error("The draft is still loading.");
    if (!dirty()) return current.current;
    const value = current.current;
    setSavingDraft(true);
    const operation = client.updateWikiSuggestion(workspaceId, id, { ...input(value), revision: value.revision });
    saving.current = operation;
    try {
      const result = await operation;
      saved.current = fingerprint(result);
      const next = current.current === value ? result : { ...current.current!, revision: result.revision };
      current.current = next; setDraft(next); cache.setQueryData(key, result);
    } finally { saving.current = null; setSavingDraft(false); }
    return persist();
  };
  useEffect(() => {
    if (!draft || conflict || draft.status !== "pending" || !dirty() || !draft.title.trim() || !draft.destination.path.endsWith(".md")) return;
    const timer = setTimeout(() => { void persist().catch(handleError); }, 600);
    return () => clearTimeout(timer);
  }, [draft, conflict]);
  const review = async (action: "save" | "dismiss") => {
    setBusy(true); setError("");
    try {
      const ready = await persist();
      const result = await client.reviewWikiSuggestion(workspaceId, id, action, ready.revision);
      current.current = result; saved.current = fingerprint(result); setDraft(result); cache.setQueryData(key, result);
      void cache.invalidateQueries({ queryKey: ["wiki-suggestions", client.baseUrl, workspaceId] });
      void cache.invalidateQueries({ queryKey: ["wiki-contributions", client.baseUrl] });
      if (action === "save") {
        await cache.invalidateQueries({ queryKey: ["wiki-snapshot", client.baseUrl, result.destination.wikiId] });
        replaceTab(tabId, wikiPanelTab(client.baseUrl, result.destination.wikiId, { kind: "page", path: result.destination.path }, wikiPageHeading(result.content, result.title).title));
      }
    } catch (error) { await handleError(error); }
    finally { setBusy(false); }
  };
  const inspectDestination = async () => {
    if (!draft) return;
    setError("");
    try {
      const page = await client.readWikiPage(draft.destination.wikiId, draft.destination.path);
      if (current.current?.destination.wikiId === draft.destination.wikiId && current.current.destination.path === draft.destination.path) setExisting(page);
    } catch (error) { setError(errorMessage(error)); }
  };
  if (!draft) return <div className="p-6 text-sm text-muted-foreground" role={query.error ? "alert" : "status"}>{query.error ? errorMessage(query.error) : "Loading suggestion…"}</div>;
  const pending = draft.status === "pending";
  const pages = snapshot.data?.pages ?? [];
  const location = suggestionLocation(draft.destination.path);
  const validDestination = Boolean(snapshot.data && (!location.folder || snapshot.data.folders?.includes(location.folder)) && suggestionPagePath(location.folder, location.name) === draft.destination.path);
  const targetPage = pages.find(page => page.path === draft.destination.path);
  const needsReview = Boolean(targetPage && targetPage.revision !== draft.destination.baseRevision);
  const openPage = (path: string) => open(wikiPanelTab(client.baseUrl, draft.destination.wikiId, { kind: "page", path }, pages.find(page => page.path === path)?.title ?? path), { besideChat: true });
  const openLink = (href: string) => {
    if (/^https?:|^mailto:|^tel:/i.test(href)) { void openDesktopUrl(href); return; }
    const reference = parseWikiPageUrl(href);
    if (reference) { open(wikiPanelTab(client.baseUrl, reference.wikiId, { kind: "page", path: reference.path }, reference.path), { besideChat: true }); return; }
    let target: string;
    try { target = decodeURIComponent(href.replace(/^#?wiki:/, "").replace(/^\[\[|\]\]$/g, "").split("|")[0]); } catch { return; }
    const destination = resolveWikiLink(pages, snapshot.data?.assets.map(asset => asset.path) ?? [], target, draft.destination.path, /^#?wiki:/.test(href) || href.startsWith("[["));
    if (destination) open(wikiPanelTab(client.baseUrl, draft.destination.wikiId, destination, pages.find(page => page.path === destination.path)?.title ?? destination.path), { besideChat: true });
  };
  const available = wikis.data?.items.filter(wiki => wiki.writable && wiki.allowInProjects && (wiki.projectWorkspaceIds == null || wiki.projectWorkspaceIds.includes(workspaceId))) ?? [];
  const remaining = siblings.data?.items.filter(item => item.status === "pending" && item.id !== id) ?? [];
  return <div className="flex h-full min-h-0 flex-col">
    <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3 text-xs">
      <span className="mr-auto text-muted-foreground" role="status">{!pending ? <span className="flex items-center gap-1.5"><Check className="size-3.5" />{draft.status === "saved" ? "Saved to wiki" : "Dismissed"}</span> : savingDraft ? "Saving draft…" : dirty() ? "Unsaved draft changes" : "Project draft · Not yet in the wiki"}</span>
      {pending ? <><Button size="sm" variant="ghost" disabled={busy || Boolean(conflict)} onClick={() => void review("dismiss")}>Dismiss</Button><Button size="sm" disabled={busy || Boolean(conflict) || !validDestination || needsReview || !available.some(wiki => wiki.id === draft.destination.wikiId)} onClick={() => void review("save")}>{busy && <Loader2 className="size-3.5 animate-spin" />}Save to wiki</Button></> : null}
    </div>
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-[880px] px-[clamp(32px,4vw,56px)] pt-6">
        <div className="flex min-w-0 items-center gap-1"><span className="shrink-0 text-xs text-muted-foreground">Save in</span><WikiSuggestionDestinationPicker client={client} wikis={available} value={draft.destination} disabled={!pending || busy} onChange={destination => { setExisting(null); change({ destination }); }} /></div>
        {pending && <p className="mt-2 text-xs text-muted-foreground" role="status">{snapshot.isLoading ? "Checking destination…" : snapshot.error ? "Could not check this wiki. Choose the location again." : !validDestination ? "Choose an existing folder in this wiki." : needsReview ? <>A page with this name already exists. <button className="underline underline-offset-2" onClick={() => void inspectDestination()}>Review before replacing</button>, or choose a different name.</> : targetPage ? "Updates the existing page when you save." : "Creates a new page when you save."}</p>}
        {error && <div role="alert" className="mt-3 text-sm text-destructive">{error} {!conflict && <button className="underline" onClick={() => { if (!dirty()) void query.refetch(); else void persist().catch(handleError); }}>Retry</button>}</div>}
        {conflict && <div className="mt-4 rounded-lg border p-4"><p className="text-sm font-medium">The draft changed while you were editing</p><p className="mt-1 text-xs text-muted-foreground">Your edits are still below. Review the latest version before continuing.</p><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{conflict.content}</pre><div className="mt-3 flex gap-2"><Button size="sm" variant="outline" onClick={() => resolveConflict(false)}>Use latest draft</Button>{conflict.status === "pending" && <Button size="sm" variant="outline" onClick={() => resolveConflict(true)}>Keep my edited draft</Button>}</div></div>}
        {existing && <div className="mt-4 rounded-lg border p-4"><p className="text-sm font-medium">Current wiki page</p><WikiDiff before={existing.content} after={draft.content} beforeLabel={t("wiki.current_version")} afterLabel={t("wiki.proposed_contribution")} /><Button className="mt-3" size="sm" variant="outline" onClick={() => { change({ destination: { ...draft.destination, baseRevision: existing.revision } }); setExisting(null); }}>Use this page as the destination</Button></div>}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-3">
        <Button size="sm" aria-pressed={mode === "preview"} variant={mode === "preview" ? "secondary" : "ghost"} onClick={() => setMode("preview")}>{t("wiki.version_content")}</Button>
        <Button size="sm" aria-pressed={mode === "diff"} variant={mode === "diff" ? "secondary" : "ghost"} onClick={() => setMode("diff")}>{t("wiki.compare_contribution")}</Button>
        {pending && <Button size="sm" aria-pressed={mode === "edit"} variant={mode === "edit" ? "secondary" : "ghost"} onClick={() => setMode("edit")}>{t("wiki.edit_markdown")}</Button>}
        {destinationPage.data && <WikiContentStats before={baseline} after={draft.content} />}
      </div>
      {destinationPage.error && <p role="alert" className="p-4 text-sm text-destructive">{destinationPage.error.message}<Button size="sm" variant="ghost" onClick={() => void destinationPage.refetch()}>{t("wiki.retry")}</Button></p>}
      {mode === "diff" ? destinationPage.data ? <WikiDiff before={baseline} after={draft.content} beforeLabel={t("wiki.current_version")} afterLabel={t("wiki.proposed_contribution")} /> : <p className="p-4">{t("wiki.loading")}</p> : mode === "preview" ? <WikiContentPreview client={client} wikiId={draft.destination.wikiId} path={draft.destination.path} content={draft.content} /> : <div className="wiki-editor-content">
        <WikiPageHeader toolbarRef={setToolbarTarget} content={draft.content} fallbackTitle={draft.title} pages={pages} path={draft.destination.path}
          readOnly={!pending || busy} onChange={content => change({ content })} onSource={() => setViewModeRequest({ mode: "source" })} onOpen={openPage} />
        <WikiMarkdownEditor toolbarTarget={toolbarTarget} externalFrontmatter value={draft.content} baseline={baseline} onChange={content => change({ content })} readOnly={!pending || busy}
          viewModeRequest={viewModeRequest} linkTargets={pages.map(page => ({ path: page.path, title: page.title }))} onOpenLink={openLink}
          imageUpload={async () => { throw new Error("Wiki suggestions contain Markdown. Add reusable attachments in the wiki workspace."); }} imagePreview={async source => source} />
      </div>}
      {remaining.length > 0 && <div className="mx-auto max-w-3xl border-t px-6 py-5"><p className="mb-2 text-xs text-muted-foreground">Other suggestions to review</p>{remaining.map(item => <Button key={item.id} size="sm" variant="ghost" className="mr-2" onClick={() => open(suggestionTab(item), { besideChat: true })}>{item.title}</Button>)}</div>}
    </div>
  </div>;
}
