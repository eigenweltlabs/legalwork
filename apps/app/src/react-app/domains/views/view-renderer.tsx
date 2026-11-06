import { openDesktopUrl } from "@/app/lib/desktop";
import { parseTaskLink } from "../tasks/task-reference";
import { useRequestOpenTask } from "../session/panel/panel-tab-destination";
import { DashboardIcon } from "../../design-system/dashboard-icon";
import { useMetadataPolling } from "@/react-app/infra/metadata-polling";
import { ViewSaveDialog } from "./view-save-dialog";
import { ViewSaveActions } from "./view-save-actions";
import { savedViewKey } from "./view-save-locations";
import { viewInput } from "./view-save";
import { t } from "@/i18n";
import { Component, useCallback, useEffect, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import { getResolvedThemeMode, subscribeToTheme } from "@/app/theme";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { OpenUIView as OpenUIRenderer } from "@legalwork/openui";
import "@legalwork/openui/styles.css";
import type { ViewOwner, ViewPreview, ViewRecord, WikiDataResult } from "@legalwork/types/views";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Download, Loader2, RefreshCw } from "lucide-react";
import { downloadViewFile } from "./view-file";
import { viewDataStatus, viewSourceAvailable } from "./view-data-status";
import { useRequestPanelTab } from "../session/panel/panel-tab-destination";
import { useProjectFiles } from "../workspace/project-file-context";
import { projectFileTab } from "../workspace/project-file-tab";
import { viewSourceTab } from "./view-source";
import { viewBoardSource } from "./view-board";
import { wikiDraftHasChanges } from "../wiki/wiki-drafts";
import type { ViewReference } from "./view-reference";
import "./views.css";

function OpenUIView(props: Omit<ComponentProps<typeof OpenUIRenderer>, "dark">) {
  const theme = useSyncExternalStore(subscribeToTheme, getResolvedThemeMode, getResolvedThemeMode);
  return <OpenUIRenderer {...props} dark={theme === "dark"} />;
}
class ViewBoundary extends Component<{ children: ReactNode; fallback?: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div role="alert" className="lw-saved-view-error">This view could not be displayed.{this.props.fallback && <pre>{this.props.fallback}</pre>}</div> : this.props.children; }
}
function ResolvedView({ client, view, refreshKey, openSource, readOnly }: { client: LegalworkServerClient; view: ViewRecord; refreshKey: number; readOnly?: boolean; openSource?: (path: string) => void }) {
  const queryClient = useQueryClient();
  const requestTab = useRequestPanelTab();
  const projectFiles = useProjectFiles();
  const openTask = useRequestOpenTask();
  const openLink = (href: string) => {
    const task = parseTaskLink(href);
    if (task) openTask(task.taskId);
    else if (href.startsWith("https://")) void openDesktopUrl(href);
  };
  const [error, setError] = useState("");
  const wikis = useQuery({ queryKey: ["wikis", client.baseUrl], queryFn: () => client.listWikis(), enabled: view.mode === "dashboard" && view.owner.kind === "wiki" });
  const writable = !readOnly && view.mode === "dashboard" && view.owner.kind === "wiki" && wikis.data?.items.some(wiki => wiki.id === view.owner.id && wiki.writable);
  const results = useQuery({
    queryKey: ["view-data", client.baseUrl, view.owner.kind, view.owner.id, view.id, view.revision, refreshKey],
    queryFn: async (): Promise<Record<string, WikiDataResult>> => {
      if (view.mode === "report" || !Object.keys(view.queries).length) return view.datasets ?? {};
      if (view.owner.kind !== "wiki") throw new Error("This view has no wiki data source");
      const entries = await Promise.all(Object.entries(view.queries).map(async ([name, query]) => [name, await client.queryWiki(view.owner.id, query)]));
      return { ...view.datasets, ...Object.fromEntries(entries) };
    },
    refetchInterval: view.mode === "dashboard" ? 15_000 : false,
  });
  const query = useCallback(async (name: string): Promise<WikiDataResult> => {
    if (!results.data || !Object.hasOwn(results.data, name)) throw new Error(`Unknown data binding: ${name}`);
    const data: WikiDataResult = results.data[name];
    return { ...data, rows: data.rows.map(row => ({ ...row, __viewSourceOwner: data.sourceOwner ?? view.owner, __viewSourceAvailable: viewSourceAvailable(data, client.baseUrl), __viewBinding: name })) };
  }, [results.data, view.owner, client.baseUrl]);
  const canMove = (row: Record<string, unknown>, field: string) => Boolean(writable && results.data && viewBoardSource(view, results.data, row, field));
  const move = async (row: Record<string, unknown>, field: string, value: string) => {
    const source = writable && results.data && viewBoardSource(view, results.data, row, field);
    if (!source) throw new Error("This card cannot be changed from this view.");
    if (wikiDraftHasChanges(client.baseUrl, source.wikiId, source.path)) throw new Error("Save the page's pending edits before moving this card.");
    await client.updateWikiProperties(source.wikiId, { path: source.path, baseRevision: source.baseRevision, patch: { set: { [source.property]: value } } });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["view-data", client.baseUrl, "wiki", source.wikiId] }),
      queryClient.invalidateQueries({ queryKey: ["wiki-snapshot", client.baseUrl, source.wikiId] }),
      queryClient.invalidateQueries({ queryKey: ["wiki-search", client.baseUrl, source.wikiId] }),
    ]);
  };
  const navigate = useCallback((path: string, owner?: ViewOwner, binding?: string) => {
    if (binding && (!results.data || !Object.hasOwn(results.data, binding))) return;
    if ((!binding && !viewSourceAvailable(view, client.baseUrl)) || Object.entries(results.data ?? {}).some(([name, data]) => (!binding || binding === name) && !viewSourceAvailable(data, client.baseUrl))) { setError(t("views.source_connection_unavailable")); return; }
    const sourceOwner = owner ?? (binding ? results.data?.[binding]?.sourceOwner : undefined) ?? view.sourceOwner ?? view.owner;
    const tab = viewSourceTab(client.baseUrl, sourceOwner, path);
    if (!tab) return;
    if (openSource && sourceOwner.kind === view.owner.kind && sourceOwner.id === view.owner.id) return openSource(path);
    if (sourceOwner.kind === "workspace") {
      const source = projectFiles?.identify(client, sourceOwner.id, { name: path.split("/").at(-1) ?? path, path });
      if (!source) { setError("The source workspace is not connected."); return; }
      requestTab(projectFileTab(source));
      return;
    }
    requestTab(tab);
  }, [client, openSource, projectFiles, requestTab, results.data, view.owner]);
  const datasets: WikiDataResult[] = Object.values(results.data ?? {});
  return <>
    {results.isPending ? <div className="lw-saved-view-loading" role="status"><Loader2 className="size-4 animate-spin" />{t("views.loading_data")}</div> : results.error ? <div role="alert" className="lw-saved-view-error">{results.error.message}<Button variant="ghost" size="sm" onClick={() => void results.refetch()}>{t("wiki.retry")}</Button></div> : <ViewBoundary key={view.revision} fallback={view.fallbackMarkdown}><OpenUIView key={`${view.revision}:${datasets.map(data => data.revision).join(":")}` } program={view.program} query={query} openSource={navigate} openLink={openLink} boardActions={writable ? { canMove, move } : undefined} onError={setError} /></ViewBoundary>}
    {error && <details className="lw-saved-view-error"><summary>This view has an error</summary><pre>{error}</pre>{view.fallbackMarkdown && <pre>{view.fallbackMarkdown}</pre>}</details>}
    {datasets.some(data => data.truncated) && <p className="lw-view-data-note">Showing a limited set of records. Charts and local filters use the displayed data.</p>}
    {(!viewSourceAvailable(view, client.baseUrl) || datasets.some(data => !viewSourceAvailable(data, client.baseUrl))) && <p className="lw-view-data-note">{t("views.source_connection_unavailable")}</p>}
    {datasets.length > 0 && <details className="lw-view-provenance"><summary>{viewDataStatus(view).live ? t("views.data") : t("views.snapshot")} · {new Date(Math.min(...datasets.map(data => data.asOf))).toLocaleString()}</summary>{Object.entries(results.data ?? {}).flatMap(([binding, data]) => (data.sources ?? []).map(source => ({ ...source, binding, available: viewSourceAvailable(data, client.baseUrl), owner: data.sourceOwner ?? view.owner }))).slice(0, 50).map((source, i) => <button disabled={!source.available} key={`${source.path}:${i}`} onClick={() => navigate(source.path, source.owner, source.binding)}>{source.path}</button>)}</details>}
  </>;
}
export function SavedView({ client, reference, inline = false, onTitle, openSource, readOnly }: { client: LegalworkServerClient | null; reference: ViewReference; inline?: boolean; readOnly?: boolean; onTitle?: (title: string) => void; openSource?: (path: string) => void }) {
  const metadataInterval = useMetadataPolling(client?.baseUrl, 15000);
  const [refreshKey, setRefreshKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const view = useQuery({ queryKey: ["ui-view", client?.baseUrl, reference.owner.kind, reference.owner.id, reference.viewId], queryFn: () => { if (!client) throw new Error(t("views.connection_unavailable")); return client.readView(reference.owner, reference.viewId); }, enabled: Boolean(client), refetchInterval: metadataInterval });
  const download = useMutation({ mutationFn: async () => { if (client && view.data) await downloadViewFile(client, view.data); } });
  const status = view.data ? viewDataStatus(view.data) : null;
  useEffect(() => { if (view.data) onTitle?.(view.data.title); }, [view.data?.title, onTitle]);
  if (!client) return <div role="status" className="lw-saved-view-loading"><Loader2 className="size-4 animate-spin" />{t("views.loading")}</div>;
  return <div className={`lw-saved-view${inline ? " lw-saved-view-inline" : ""}`}>
    {view.data && <div className="lw-saved-view-toolbar">
      {!inline && <div className="lw-saved-view-identity"><DashboardIcon className="size-5" /><div><p className="lw-saved-view-name">{view.data.title}</p><span>{status?.live ? t("views.live_dashboard") : status?.asOf ? t("views.snapshot_at", { date: new Date(status.asOf).toLocaleString() }) : t("views.snapshot")}</span></div></div>}
      <div className="ml-auto flex items-center gap-1">
        {!readOnly && !view.error && <ViewSaveActions saved onSaveCopy={() => setSaving(true)} />}
        {!readOnly && <Button size="icon-xs" variant="ghost" disabled={download.isPending || Boolean(view.error)} aria-label={t("views.export_snapshot")} title={t("views.export_snapshot")} onClick={() => download.mutate()}>{download.isPending ? <Loader2 className="animate-spin" /> : <Download />}</Button>}
        <Button size="icon-xs" variant="ghost" aria-label={t(status?.live ? "views.refresh_data" : "views.reload_file")} title={t(status?.live ? "views.refresh_data" : "views.reload_file")} onClick={() => { void view.refetch(); setRefreshKey(value => value + 1); }}><RefreshCw className={view.isFetching ? "animate-spin" : ""} /></Button>
      </div>
    </div>}
    {download.error && <p role="alert" className="lw-saved-view-error">{download.error.message}</p>}
    {saving && view.data && <SavedViewCopy client={client} view={view.data} onClose={() => setSaving(false)} />}
    {view.error ? <div role="alert" className="lw-saved-view-error">{view.error.message}<Button size="sm" variant="ghost" onClick={() => void view.refetch()}>{t("wiki.retry")}</Button></div> : !view.data ? <div role="status" className="lw-saved-view-loading"><Loader2 className="size-4 animate-spin" />{t("views.loading")}</div> : <ResolvedView client={client} view={view.data} refreshKey={refreshKey} openSource={openSource} readOnly={readOnly} />}
  </div>;
}
function SavedViewCopy({ client, view, onClose }: { client: LegalworkServerClient; view: ViewRecord; onClose: () => void }) {
  const snapshot = useQuery({ queryKey: ["view-copy-snapshot", client.baseUrl, view.owner.kind, view.owner.id, view.id, view.revision], gcTime: 0, queryFn: async () => {
    const datasets = { ...view.datasets };
    if (view.owner.kind === "wiki" && view.mode === "dashboard") for (const [name, query] of Object.entries(view.queries)) datasets[name] = { ...await client.queryWiki(view.owner.id, query), sourceOwner: view.owner };
    return { ...viewInput(view), datasets };
  } });
  if (!snapshot.data) return <div className="p-4 text-sm">{snapshot.error ? snapshot.error.message : t("wiki.loading")}{snapshot.error && <Button variant="ghost" size="sm" disabled={snapshot.isFetching} onClick={() => void snapshot.refetch()}>{t("wiki.retry")}</Button>}<Button variant="ghost" size="sm" onClick={onClose}>{t("common.close")}</Button></div>;
  return <ViewSaveDialog scope={{ key: savedViewKey(client.baseUrl, view), existing: view }} client={client} preview={{ status: "preview", owner: view.owner, input: snapshot.data }} onClose={onClose} onSaved={onClose} />;
}
export function PreviewView({ client, preview, generationId }: { client: LegalworkServerClient; preview: ViewPreview; generationId: string }) {
  return <ResolvedView client={client} view={{ ...preview.input, queries: {}, mode: "report", owner: preview.owner, id: generationId, revision: generationId, updatedAt: 0 }} refreshKey={0} readOnly />;
}
export { OpenUIView };
