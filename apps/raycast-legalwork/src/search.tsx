import { Action, ActionPanel, Icon, List, showToast, Toast } from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { stageFile, launch, readPairing, request, type Pairing, type SearchKind, type SearchResult, type SourceState } from "./legalwork";

const KINDS: { value: SearchKind | "all"; title: string }[] = [{ value: "all", title: "Everything" }, { value: "files", title: "Files" }, { value: "projects", title: "Projects" }, { value: "chats", title: "Chats" }, { value: "tasks", title: "Tasks" }, { value: "recordings", title: "Recordings" }];
const ICONS: Record<SearchKind, Icon> = { files: Icon.Document, projects: Icon.Folder, chats: Icon.Message, tasks: Icon.CheckCircle, recordings: Icon.Microphone };

export default function Command() {
  const [pairing, setPairing] = useState<Pairing | null | undefined>(undefined);
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<SearchKind | "all">("all");
  const [items, setItems] = useState<SearchResult[]>([]);
  const [sources, setSources] = useState<SourceState[]>([]);
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { void readPairing().then(setPairing); }, []);
  useEffect(() => {
    if (!pairing) return;
    controller.current?.abort();
    if (!query.trim() && kind !== "tasks") { setItems([]); setSources([]); return; }
    const current = new AbortController();
    controller.current = current;
    setLoading(true);
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q: query.trim(), content: "1", limit: "60", ...(kind !== "all" ? { kinds: kind } : {}) });
      request<{ items: SearchResult[]; sources: SourceState[] }>(pairing, `/launcher/search?${params}`, { signal: current.signal })
        .then(response => { if (!current.signal.aborted) { setItems(response.items); setSources(response.sources); } })
        .catch(error => { if (!current.signal.aborted) void showToast({ style: Toast.Style.Failure, title: "Search failed", message: error instanceof Error ? error.message : String(error) }); })
        .finally(() => { if (!current.signal.aborted) setLoading(false); });
    }, 150);
    return () => { clearTimeout(timer); current.abort(); };
  }, [pairing, query, kind]);
  // Ask attaches the file itself (a staged reference); other results carry their identifier in the question.
  const askAbout = async (item: SearchResult) => {
    if (!pairing) return;
    try {
      const staged = await stageFile(pairing, item);
      await launch("ask", staged ? { context: staged.id, project: item.workspaceId ?? undefined } : { q: item.title, project: item.workspaceId ?? undefined });
    } catch (error) { await showToast({ style: Toast.Style.Failure, title: "Could not attach the file", message: error instanceof Error ? error.message : String(error) }); }
  };
  if (pairing === null) return <List><List.EmptyView title="LegalWork is not paired" description="Enable Raycast pairing in LegalWork Settings, Assistant launcher." /></List>;
  const coverage = sources.filter(source => source.coverage !== "complete").map(source => `${source.label}: ${source.coverage}`).join(" · ");
  return <List isLoading={loading || pairing === undefined} searchText={query} onSearchTextChange={setQuery} throttle searchBarPlaceholder="Search files, projects, chats, tasks and recordings"
    searchBarAccessory={<List.Dropdown tooltip="Category" value={kind} onChange={value => setKind(value as SearchKind | "all")}>{KINDS.map(item => <List.Dropdown.Item key={item.value} value={item.value} title={item.title} />)}</List.Dropdown>}>
    {coverage ? <List.Section title={coverage} /> : null}
    {items.map(item => <List.Item key={`${item.kind}:${item.sourceId}:${item.id}`} icon={ICONS[item.kind]} title={item.title} subtitle={item.subtitle ?? item.path} accessories={[{ text: item.kind }]} actions={<ActionPanel>
      <Action title="Open in LegalWork" icon={Icon.ArrowRight} onAction={() => void launch(item.kind, { q: item.path ?? item.title, project: item.workspaceId ?? undefined })} />
      {item.actions.includes("attach") && <Action title="Ask About This" icon={Icon.SpeechBubble} onAction={() => void askAbout(item)} />}
      {item.path && <Action.CopyToClipboard title="Copy Path" content={item.path} />}
    </ActionPanel>} />)}
    {!items.length && query.trim() && !loading && <List.EmptyView title="No results" description={coverage || "Try another term or category."} />}
  </List>;
}
