import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, FileText, LayoutGrid, ListTodo, Loader2, Mail, MessageSquare, Search, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { matchesSearch, searchTerms, type ContentSearchKind, type ContentSearchResponse, type ContentSearchResult } from "@legalwork/types/search";
import { t } from "@/i18n";
import { isMacPlatform } from "@/app/utils";
import { Command, CommandDialog, CommandDialogPopup, CommandDialogTitle, CommandEmpty, CommandFooter, CommandHeader, CommandInput, CommandItem, CommandList, CommandPanel } from "@/components/ui/command";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { SearchGlass } from "./search-glass";
import { rankSearchResults } from "./search-ranking";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ProjectDetails } from "@legalwork/types/workspace";
import { matchesProjectFilters, useProjectFilterStore } from "../domains/workspace/project-filters";
import { useProjectSyncStore } from "../domains/workspace/project-sync-store";
import { defaultProjectFields, useProjectDefaultsStore, withInitialProjectFields } from "../domains/workspace/project-defaults-store";
import "./command-palette.css";
import { useGlobalMailSearch } from './use-global-mail-search';
import type { GlobalMailHit } from './global-mail-search';

export type SessionOption = {
  workspaceId: string; sessionId: string; title: string; workspaceTitle: string;
  updatedAt: number; searchText: string; isActive: boolean;
};
export type SearchWorkspace = { id: string; title: string; local: boolean; server: string };
type SearchFilter = "all" | ContentSearchKind | 'mail';
const kinds: ContentSearchKind[] = ["sessions", "projects", "tasks", "files"];
const filters: SearchFilter[] = ["all", ...kinds, 'mail'];
const icons = { sessions: MessageSquare, projects: LayoutGrid, tasks: ListTodo, files: FileText };
const labels = () => ({ all: t("content_search.all"), sessions: t("content_search.sessions"), projects: t("content_search.projects"), tasks: t("content_search.tasks"), files: t("content_search.files"), mail: t('content_search.mail') });

function Highlight({ text, query }: { text: string; query: string }) {
  const terms = searchTerms(query).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return <>{text}</>;
  return <>{text.split(new RegExp(`(${terms.join("|")})`, "gi")).map((part, index) => index % 2
    ? <mark key={index} className="search-highlight">{part}</mark> : part)}</>;
}

export function CommandPalette(props: {
  open: boolean;
  onClose: () => void;
  workspaces: SearchWorkspace[];
  sessions: SessionOption[];
  project: (workspaceId: string) => Promise<ProjectDetails>;
  search: (workspaceId: string, kind: "sessions" | "tasks" | "files", query: string, signal: AbortSignal, options?: { projectOnly?: boolean; retry?: boolean }) => Promise<ContentSearchResponse>;
  onOpenResult: (result: ContentSearchResult) => void;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState("__all__");
  const [revision, setRevision] = useState(0);
  const [preparing, setPreparing] = useState(0);
  const filterState = useProjectFilterStore();
  const syncStates = useProjectSyncStore(state => state.states);
  const savedDefaults = useProjectDefaultsStore(defaultProjectFields);
  const details = useQueries({ queries: props.workspaces.map(workspace => ({
    queryKey: ["search-project", workspace.id], queryFn: () => props.project(workspace.id),
    enabled: props.open && scope === "__filtered__" && filterState.filters.length > 0 && (!filterState.teamOnly || syncStates[workspace.id] !== undefined), staleTime: 0, retry: 1,
  })) });
  const eligibleIds = props.workspaces.filter((workspace, index) => {
    if (scope === "__all__") return true;
    if (scope !== "__filtered__") return workspace.id === scope;
    if (filterState.teamOnly && syncStates[workspace.id] === undefined) return false;
    if (!filterState.filters.length) return true;
    const detail = details[index].data;
    return detail && matchesProjectFilters(withInitialProjectFields(detail, savedDefaults).fields, filterState.filters, filterState.mode);
  }).map(workspace => workspace.id).join("\n");
  const scopedWorkspaces = useMemo(() => { const ids = new Set(eligibleIds.split("\n")); return props.workspaces.filter(workspace => ids.has(workspace.id)); }, [eligibleIds, props.workspaces]);
  const inputRef = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState<SearchFilter>("all");
  const [mailAccount, setMailAccount] = useState('');
  const navigate = useNavigate();
  const resultsByJob = useRef(new Map<string, ContentSearchResult[]>());
  const previousSearch = useRef("");
  const [results, setResults] = useState<ContentSearchResult[]>([]);
  const [pending, setPending] = useState(0);
  const [limited, setLimited] = useState(false);
  const [resultQuery, setResultQuery] = useState("");
  const trimmed = query.trim();
  const mail = useGlobalMailSearch(props.open && filter === 'mail', trimmed, mailAccount);
  const names = labels();

  useEffect(() => { if (!props.open) { setQuery(""); setFilter("all"); setScope("__all__"); setMailAccount(''); } }, [props.open]);
  useEffect(() => {
    const key = JSON.stringify([trimmed, filter, eligibleIds, scope]);
    if (previousSearch.current !== key) { previousSearch.current = key; resultsByJob.current.clear(); setResults([]); }
    setLimited(false); setPending(0); setPreparing(0); setResultQuery(trimmed);
    if (!props.open || filter === 'mail' || trimmed.length === 1 || (trimmed.length < 2 && filter !== "tasks" && filter !== "all") || filter === "projects") return;
    const controller = new AbortController();
    const jobs: Array<{ workspace: SearchWorkspace; kind: "sessions" | "tasks" | "files" }> = [];
    const taskServers = new Set<string>();
    for (const workspace of scopedWorkspaces) {
      if (trimmed.length >= 2 && (filter === "all" || filter === "sessions")) jobs.push({ workspace, kind: "sessions" });
      if (trimmed.length >= 2 && workspace.local && (filter === "all" || filter === "files")) jobs.push({ workspace, kind: "files" });
      if ((filter === "all" || filter === "tasks") && (scope !== "__all__" || !taskServers.has(workspace.server))) {
        taskServers.add(workspace.server); jobs.push({ workspace, kind: "tasks" });
      }
    }
    setPending(jobs.length);
    const timer = window.setTimeout(() => {
      const run = async (job: typeof jobs[number]) => {
        try {
          const response = await props.search(job.workspace.id, job.kind, trimmed, controller.signal, { projectOnly: scope !== "__all__" });
          if (controller.signal.aborted) return;
          resultsByJob.current.set(`${job.workspace.id}:${job.kind}`, response.items);
          setResults([...resultsByJob.current.values()].flat());
          if (response.limited) setLimited(true);
          if (response.preparing) setPreparing(current => current + (response.preparing ?? 0));
        } catch {
          // Keep showing matches from the other search sources.
        } finally {
          if (!controller.signal.aborted) setPending(current => Math.max(0, current - 1));
        }
      };
      // File extraction must never queue ahead of transcript search. Keep disk work modest.
      const files = jobs.filter(job => job.kind === "files");
      const worker = async () => { while (files.length && !controller.signal.aborted) { const job = files.shift(); if (job) await run(job); } };
      const records = jobs.filter(job => job.kind !== "files");
      const recordWorker = async () => { while (records.length && !controller.signal.aborted) { const job = records.shift(); if (job) await run(job); } };
      void Promise.all([recordWorker(), recordWorker(), recordWorker(), recordWorker(), worker(), worker()]);
    }, 220);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [props.open, scopedWorkspaces, props.search, trimmed, filter, scope, revision, eligibleIds]);

  useEffect(() => {
    if (!props.open || pending || !preparing) return;
    const timer = window.setTimeout(() => setRevision(value => value + 1), 1500);
    return () => window.clearTimeout(timer);
  }, [props.open, pending, preparing, revision]);

  const items = useMemo(() => {
    const projects: ContentSearchResult[] = scopedWorkspaces.filter(workspace => matchesSearch(workspace.title, trimmed)).map(workspace => ({
      kind: "projects", id: workspace.id, workspaceId: workspace.id, title: workspace.title, excerpt: "", updatedAt: 0,
    }));
    const recent: ContentSearchResult[] = props.sessions.filter(session => scopedWorkspaces.some(workspace => workspace.id === session.workspaceId) && (!trimmed || matchesSearch(session.title, trimmed))).map(session => ({
      kind: "sessions", id: session.sessionId, workspaceId: session.workspaceId, title: session.title, excerpt: "", updatedAt: session.updatedAt,
    }));
    const source = trimmed.length < 2 ? [...recent.slice(0, 8), ...projects.slice(0, 8), ...(resultQuery === trimmed ? results : [])] : [...projects, ...(resultQuery === trimmed ? results : [])];
    const unique = new Map<string, ContentSearchResult>();
    for (const item of source) unique.set(`${item.kind}:${item.workspaceId}:${item.id}`, item);
    return rankSearchResults([...unique.values()].filter(item => filter === "all" || item.kind === filter), trimmed);
  }, [scopedWorkspaces, props.sessions, trimmed, filter, results, resultQuery]);
  const visible = items.filter((item, index, all) => all.slice(0, index).filter(previous => previous.kind === item.kind).length < (filter === "all" ? 20 : 60));
  const mailPage = mail.state?.status === 'ready' ? mail.state.page : undefined;
  const commandItems: Array<ContentSearchResult | GlobalMailHit> = filter === 'mail' ? mailPage?.items ?? [] : visible;
  const openMail = () => { props.onClose(); navigate('/mail'); };

  return <CommandDialog open={props.open} onOpenChange={open => { if (!open) props.onClose(); }}>
    <CommandDialogPopup className="search-dialog" backdropClassName="search-backdrop" viewportClassName="search-viewport" onKeyDownCapture={event => {
      if (event.target !== inputRef.current) return;
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      setFilter(current => filters[(filters.indexOf(current) + (event.shiftKey ? -1 : 1) + filters.length) % filters.length]);
      inputRef.current?.focus({ preventScroll: true });
    }}>
      <CommandDialogTitle>{t("content_search.title")}</CommandDialogTitle>
      <Command items={commandItems} filter={null} value={query} onValueChange={setQuery}>
        <CommandHeader className="search-capsule">
          <SearchGlass />
          <CommandInput ref={inputRef} className="w-full" startAddon={null} maxLength={filter === 'mail' ? 512 : undefined} placeholder={t(filter === 'mail' ? 'content_search.mail_placeholder' : "content_search.placeholder")} aria-label={t("content_search.title")} />
          <Button variant="ghost" size="icon-sm" className="search-dismiss" onClick={props.onClose} aria-label={t("common.close")} title={`${t("common.close")} (Esc)`}><X /><kbd aria-hidden="true">esc</kbd></Button>
        </CommandHeader>
        <div className="search-results-glass">
        <SearchGlass />
        <div className="search-scope">
          {filter === 'mail' ? <Select value={mailAccount || '__all__'} onValueChange={value => { if (value) setMailAccount(value === '__all__' ? '' : value); }}>
            <SelectTrigger size="sm" aria-label={t('content_search.mail_account')}><SelectValue>{mailAccount ? mail.accounts.find(account => account.id === mailAccount)?.displayName ?? t('content_search.mail_account') : t('content_search.mail_all_accounts')}</SelectValue></SelectTrigger>
            <SelectContent align="start" className="search-scope-menu">
              <SelectItem value="__all__">{t('content_search.mail_all_accounts')}</SelectItem>
              {mail.accounts.map(account => <SelectItem key={account.id} value={account.id}>{account.displayName}</SelectItem>)}
            </SelectContent>
          </Select> : <>
          <Select value={scope} onValueChange={value => { if (value) setScope(value); }}>
            <SelectTrigger size="sm" aria-label={t("content_search.scope")}><SelectValue>{scope === "__all__" ? t("content_search.all_projects") : scope === "__filtered__" ? t("content_search.filtered_projects") : props.workspaces.find(workspace => workspace.id === scope)?.title}</SelectValue></SelectTrigger>
            <SelectContent align="start" className="search-scope-menu">
              <SelectItem value="__all__">{t("content_search.all_projects")}</SelectItem>
              {(filterState.teamOnly || filterState.filters.length > 0) && <SelectItem value="__filtered__">{t("content_search.filtered_projects")}</SelectItem>}
              {props.workspaces.map(workspace => <SelectItem key={workspace.id} value={workspace.id} title={workspace.title}>{workspace.title}</SelectItem>)}
            </SelectContent>
          </Select>
          {scope === "__filtered__" && <span>{filterState.filters.length > 0 && details.some(detail => detail.isFetching) ? t("content_search.searching") : filterState.filters.length > 0 && details.some(detail => detail.isError) ? t("content_search.metadata_unavailable") : t("content_search.projects_count", { count: scopedWorkspaces.length })}</span>}
          </>}
        </div>
        <Tabs value={filter} onValueChange={value => { if (value === "all" || value === "sessions" || value === "projects" || value === "tasks" || value === "files" || value === 'mail') setFilter(value); }} className="search-filters">
          <TabsList aria-label={t("content_search.filter")} aria-keyshortcuts="Tab Shift+Tab">
            {filters.map(kind => <TabsTrigger key={kind} value={kind} onClick={() => inputRef.current?.focus({ preventScroll: true })}>{names[kind]}</TabsTrigger>)}
          </TabsList>
        </Tabs>
        <CommandPanel className="search-results-panel">
          <CommandEmpty className="search-empty"><Search aria-hidden="true" />{filter === 'mail' ? <>
            <span>{!mail.state ? t('content_search.searching') : mail.state.status === 'too-long' ? t('content_search.mail_query_too_long') : mail.state.status === 'locked' ? t('content_search.mail_locked') : mail.state.status === 'unavailable' ? t('content_search.mail_unavailable') : !mailPage?.accounts.length ? t('content_search.mail_no_accounts') : trimmed.length === 1 ? t('content_search.keep_typing') : trimmed ? t('content_search.no_results') : t('content_search.mail_start')}</span>
            {mail.state?.status === 'unavailable' && <Button size="sm" variant="ghost" onClick={mail.retry}>{t('content_search.retry')}</Button>}
            {(mail.state?.status === 'locked' || mail.state?.status === 'unavailable' || mailPage?.accounts.length === 0) && <Button size="sm" variant="ghost" onClick={openMail}>{t('content_search.mail_open')}</Button>}
          </> : <span>{(pending || preparing) ? t("content_search.searching") : trimmed.length === 1 ? t("content_search.keep_typing") : trimmed ? t("content_search.no_results") : t("content_search.start")}</span>}</CommandEmpty>
          <CommandList>{(item: ContentSearchResult | GlobalMailHit) => {
            if (item.kind === 'mail') return <CommandItem key={item.id} value={item.id} className="search-result" onClick={() => { props.onClose(); navigate('/mail', { state: { mailSearchTarget: { serverOrigin: item.serverOrigin, accountId: item.accountId, locator: item.locator } } }); }}>
              <span className="search-result-icon" aria-hidden="true"><Mail /></span>
              <div className="min-w-0 flex-1">
                <div className="search-result-title"><Highlight text={item.subject || t('content_search.mail_no_subject')} query={trimmed} /></div>
                <div className="search-result-meta">{item.sender}{item.date ? ` · ${new Date(item.date).toLocaleDateString()}` : ''} · {item.account}</div>
                {item.snippet && <div className="search-result-excerpt"><Highlight text={item.snippet} query={trimmed} /></div>}
              </div><CornerDownLeft className="search-result-enter" aria-hidden="true" />
            </CommandItem>;
            const Icon = icons[item.kind];
            const project = props.workspaces.find(workspace => workspace.id === item.workspaceId)?.title;
            return <CommandItem key={`${item.kind}:${item.workspaceId}:${item.id}`} value={`${item.kind}:${item.workspaceId}:${item.id}`} className="search-result" onClick={() => { props.onClose(); props.onOpenResult(item); }}>
              <span className="search-result-icon" aria-hidden="true"><Icon /></span>
              <div className="min-w-0 flex-1">
                <div className="search-result-title"><Highlight text={item.title} query={trimmed} /></div>
                <div className="search-result-meta">{names[item.kind]}{item.completed ? ` · ${t("tasks.status_done")}` : ""}{project && item.kind !== "projects" ? ` · ${project}` : ""}{item.path && item.excerpt !== item.path ? ` · ${item.path}` : ""}</div>
                {item.incomplete && <div className="search-result-meta">{t("content_search.partial")}</div>}
                {item.sources?.some(source => source.page) && <div className="search-result-meta">{t("content_search.pages", { pages: [...new Set(item.sources.flatMap(source => source.page ? [source.page] : []))].join(", ") })}</div>}
                {trimmed && item.excerpt ? <div className="search-result-excerpt"><Highlight text={item.excerpt} query={trimmed} /></div> : null}
              </div>
              <CornerDownLeft className="search-result-enter" aria-hidden="true" />
            </CommandItem>;
          }}</CommandList>
        </CommandPanel>
        <CommandFooter>
          <span className="search-shortcut">{t("content_search.open_shortcut", { shortcut: isMacPlatform() ? "⌘ K" : "Ctrl + K" })}</span>
          <span aria-live="polite" className="search-footer-status">{filter === 'mail' ? !mail.state ? <><Loader2 className="size-3 animate-spin" />{t('content_search.searching')}</> : mailPage?.incomplete ? t('content_search.mail_incomplete') : mailPage?.limited ? t('content_search.refine') : mailPage && trimmed.length >= 2 ? t('content_search.results', { count: commandItems.length }) : null : (pending || preparing) ? <><Loader2 className="size-3 animate-spin" />{preparing ? t("content_search.preparing", { count: preparing }) : t("content_search.searching")}</> : limited || visible.length < items.length ? t("content_search.refine") : (trimmed || filter === "tasks") ? t("content_search.results", { count: visible.length }) : null}</span>
          <span className="search-key-help">{t("content_search.keys")}</span>
        </CommandFooter>
        </div>
      </Command>
    </CommandDialogPopup>
  </CommandDialog>;
}
