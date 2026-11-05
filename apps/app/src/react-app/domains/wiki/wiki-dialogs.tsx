import { WikiDiffStats } from "./wiki-diff";
import { WikiRevisionDialog } from "./wiki-revision-dialog";
import { useEffect, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Copy, FileText, FolderOpen, History, Loader2, RotateCcw, Trash2, UserRound, Users } from "lucide-react";
import type { WikiRevision, WikiCreateInput, WikiPage, WikiSharingInput, WikiTeamOverview, WikiUpdateInput, WikiVault } from "@legalwork/types/wiki";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { pickDirectory } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { useLocal } from "@/react-app/kernel/local-provider";
import { wikiNewPagePath } from "./wiki-model";
import { joinedTeamWikiIds, wikiSharingError, wikiSharingInput, wikiSharingValid } from "./wiki-sharing";

export type WikiWorkspaceOption = { id: string; displayNameResolved: string };
export const wikiSelectClass = "h-9 w-full rounded-lg border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
export const wikiError = (error: unknown) => error instanceof Error ? error.message : String(error);

function DialogError({ message }: { message: string | null }) {
  return message ? <p role="alert" className="wiki-dialog-error rounded-lg bg-destructive/5 px-3 py-2 text-sm leading-relaxed text-destructive">{message}</p> : null;
}

function TeamNotice(props: { loading: boolean; error: unknown; team: WikiTeamOverview | undefined; retry: () => void }) {
  if (props.loading) return <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 size={14} className="animate-spin" />{t("wiki.loading_team")}</p>;
  if (props.error) return <div className="flex items-start gap-3 rounded-lg border bg-muted/30 p-3"><p role="alert" className="flex-1 text-xs leading-relaxed text-muted-foreground">{wikiSharingError(props.error)}</p><Button type="button" size="sm" variant="outline" onClick={props.retry}>{t("wiki.retry")}</Button></div>;
  return props.team ? <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Users size={14} />{t("wiki.sharing_firm", { name: props.team.orgName ?? t("wiki.your_firm") })}</p> : null;
}

function AudienceFields(props: { team: WikiTeamOverview; value: WikiSharingInput; onChange: (value: WikiSharingInput) => void; disabled?: boolean }) {
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(50);
  const members = props.team.members.filter((member) => member.userId !== props.team.userId && `${member.name ?? ""} ${member.email ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <div className="space-y-3">
    <label className="grid gap-2 text-sm font-medium">{t("wiki.audience")}
      <select className={wikiSelectClass} value={props.value.access} disabled={props.disabled} onChange={(event) => props.onChange({ ...props.value, access: event.target.value === "members" ? "members" : "org" })}>
        <option value="org">{t("wiki.everyone_in_firm")}</option><option value="members">{t("wiki.selected_members")}</option>
      </select>
    </label>
    {props.value.access === "members" ? <div className="overflow-hidden rounded-xl border">
      {props.team.members.length > 10 ? <div className="border-b p-2"><Input className="h-8 text-xs" aria-label={t("wiki.search_members")} placeholder={t("wiki.search_members")} value={search} onChange={(event) => { setSearch(event.target.value); setLimit(50); }} /></div> : null}
      <div className="wiki-member-list max-h-44 overflow-y-auto p-1">
        {members.slice(0, limit).map((member) => <label key={member.userId} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-muted/40">
          <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={props.value.memberIds.includes(member.userId)} disabled={props.disabled} onChange={(event) => props.onChange({ ...props.value, memberIds: event.target.checked ? [...props.value.memberIds, member.userId] : props.value.memberIds.filter((id) => id !== member.userId) })} />
          <span className="min-w-0 text-sm"><span className="block truncate">{member.name || member.email || t("wiki.member")}</span>{member.name && member.email ? <span className="block truncate text-xs text-muted-foreground">{member.email}</span> : null}</span>
        </label>)}
        {members.length === 0 ? <p className="px-3 py-4 text-xs text-muted-foreground">{t("wiki.no_members")}</p> : null}
      </div>
      {members.length > limit ? <Button type="button" variant="ghost" size="sm" className="mx-2 mb-2" onClick={() => setLimit((current) => current + 50)}>{t("wiki.show_more", { remaining: members.length - limit })}</Button> : null}
      <p className="border-t bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground">{t("wiki.owner_access")}</p>
    </div> : null}
  </div>;
}

function LocalFolderField(props: { value: string; onChange: (value: string) => void; onError: (message: string) => void; disabled?: boolean }) {
  return <label className="grid gap-2 text-sm">{t("wiki.folder")}
    <div className="flex gap-2"><Input value={props.value} disabled={props.disabled} onChange={(event) => props.onChange(event.target.value)} placeholder={t("wiki.default_folder")} /><Button type="button" variant="outline" size="icon" disabled={props.disabled} aria-label={t("wiki.choose_folder")} onClick={() => { void pickDirectory({ title: t("wiki.choose_folder") }).then((value) => { if (typeof value === "string") props.onChange(value); }).catch((error) => props.onError(wikiError(error))); }}><FolderOpen size={16} /></Button></div>
    <span className="text-xs leading-relaxed text-muted-foreground">{t("wiki.folder_hint")}</span>
  </label>;
}

export function CreateWikiDialog(props: { client: LegalworkServerClient; serverUrl: string; wikis: WikiVault[]; onClose: () => void; onCreate: (input: WikiCreateInput) => Promise<void>; onJoin: (input: { wikiId: string; root?: string }) => Promise<void> }) {
  const language = useLocale() === "de" ? "de" : "en";
  const { prefs } = useLocal();
  const [tab, setTab] = useState<"create" | "join">("create");
  const [shared, setShared] = useState(false);
  const [name, setName] = useState("");
  const [root, setRoot] = useState("");
  const [template, setTemplate] = useState<NonNullable<WikiCreateInput["template"]>>("firm");
  const [sharing, setSharing] = useState<WikiSharingInput>(wikiSharingInput());
  const [joinId, setJoinId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const team = useQuery({ queryKey: ["wiki-team", props.serverUrl], queryFn: () => props.client.wikiTeam(), enabled: shared || tab === "join", retry: false });
  const joined = joinedTeamWikiIds(props.wikis);
  const valid = tab === "join" ? Boolean(joinId && team.data && !joined.has(joinId)) : Boolean(name.trim() && (!shared || wikiSharingValid(sharing, team.data)));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!valid) return;
    setBusy(true); setError(null);
    try {
      if (tab === "join") await props.onJoin({ wikiId: joinId, ...(root.trim() ? { root: root.trim() } : {}) });
      else await props.onCreate({ name: name.trim(), ...(root.trim() ? { root: root.trim() } : {}), template, ...(template === "legal-research" ? { language, ...(prefs.researchCountry ? { country: prefs.researchCountry } : {}) } : {}), ...(shared ? { sharing } : {}) });
    } catch (err) { setError(shared || tab === "join" ? wikiSharingError(err) : wikiError(err)); }
    finally { setBusy(false); }
  };
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) props.onClose(); }}>
    <DialogContent className="wiki-dialog flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-lg">
      <form onSubmit={submit} className="flex min-h-0 flex-col overflow-hidden">
        <DialogHeader className="wiki-dialog-header shrink-0 px-6 pb-4 pt-6 pr-12"><DialogTitle>{t("wiki.new_wiki")}</DialogTitle><DialogDescription>{t("wiki.new_wiki_hint")}</DialogDescription></DialogHeader>
        <Tabs value={tab} onValueChange={(value) => { if (value === "create" || value === "join") { setTab(value); setError(null); } }} className="min-h-0 gap-0">
          <TabsList className="wiki-dialog-tabs shrink-0 mx-6 mb-1 w-auto"><TabsTrigger value="create" disabled={busy}>{t("wiki.create")}</TabsTrigger><TabsTrigger value="join" disabled={busy}>{t("wiki.join_shared")}</TabsTrigger></TabsList>
          <div className="wiki-dialog-body max-h-[60vh] overflow-y-auto px-6 py-5">
            <TabsContent value="create" keepMounted className="space-y-5">
              <label className="grid gap-2 text-sm font-medium">{t("wiki.name")}<Input autoFocus required={tab === "create"} disabled={busy} value={name} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder={t("wiki.name_placeholder")} /></label>
              <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">{t("wiki.visibility")}</legend>
                <div className="grid grid-cols-2 gap-3">
                  {[false, true].map((value) => <label key={String(value)} className="relative cursor-pointer">
                    <input type="radio" name="wiki-visibility" className="peer sr-only" checked={shared === value} disabled={busy} onChange={() => { setShared(value); setError(null); }} />
                    <span className="wiki-choice-card flex h-full flex-col gap-2 rounded-xl border p-4 transition-colors hover:bg-muted/30 peer-checked:border-primary/60 peer-checked:bg-primary/5 peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                      <span className="flex items-center justify-between">{value ? <Users size={18} className="text-muted-foreground" /> : <UserRound size={18} className="text-muted-foreground" />}{shared === value ? <Check size={14} className="text-primary" /> : null}</span>
                      <span className="text-sm font-medium">{t(value ? "wiki.shared_label" : "wiki.personal_label")}</span><span className="text-xs leading-relaxed text-muted-foreground">{t(value ? "wiki.shared_short" : "wiki.personal_short")}</span>
                    </span>
                  </label>)}
                </div>
              </fieldset>
              {shared ? <div className="space-y-4"><TeamNotice loading={team.isLoading} error={team.error} team={team.data} retry={() => void team.refetch()} />{team.data ? <AudienceFields team={team.data} value={sharing} onChange={setSharing} disabled={busy} /> : null}</div> : null}
              <label className="grid gap-2 text-sm font-medium">{t("wiki.starter")}<select className={wikiSelectClass} value={template} disabled={busy} onChange={(event) => { const value = event.target.value; if (value === "firm" || value === "blank" || value === "legal-research") setTemplate(value); }}><option value="firm">{t("wiki.firm_starter")}</option><option value="legal-research">{t("wiki.research_starter")}</option><option value="blank">{t("wiki.blank_starter")}</option></select></label>
              {template === "legal-research" ? <p className="text-xs leading-relaxed text-muted-foreground">{t("wiki.research_starter_hint")}</p> : null}
            </TabsContent>
            <TabsContent value="join" keepMounted className="space-y-4">
              <TeamNotice loading={team.isLoading} error={team.error} team={team.data} retry={() => void team.refetch()} />
              {team.data ? <div className="space-y-2">{team.data.items.length ? team.data.items.map((item) => <label key={item.id} className={`relative flex items-center gap-3 rounded-xl border p-3.5 transition-colors ${joined.has(item.id) ? "opacity-50" : "cursor-pointer hover:bg-muted/30"} ${joinId === item.id ? "border-primary/60 bg-primary/5" : ""}`}>
                <input type="radio" name="join-wiki" className="size-4 accent-primary" value={item.id} checked={joinId === item.id} disabled={busy || joined.has(item.id)} onChange={() => setJoinId(item.id)} /><Users size={18} className="shrink-0 text-muted-foreground" /><span className="min-w-0 text-sm"><span className="block truncate font-medium">{item.name}</span><span className="mt-0.5 block text-xs text-muted-foreground">{joined.has(item.id) ? t("wiki.already_added") : t(item.access === "org" ? "wiki.everyone_in_firm" : "wiki.selected_members")}</span></span>
              </label>) : <div className="rounded-xl border border-dashed p-6 text-center"><Users size={24} className="mx-auto mb-3 text-muted-foreground" /><p className="text-sm text-muted-foreground">{t("wiki.no_shared_wikis")}</p></div>}</div> : null}
            </TabsContent>
            <details className="group mt-5 border-t pt-4"><summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground"><FolderOpen size={14} />{t("wiki.folder_options")}<ChevronDown size={14} className="ml-auto transition-transform group-open:rotate-180" /></summary><div className="pt-4"><LocalFolderField value={root} onChange={setRoot} onError={setError} disabled={busy} /></div></details>
            {error ? <div className="mt-4"><DialogError message={error} /></div> : null}
          </div>
        </Tabs>
        <DialogFooter className="wiki-dialog-footer shrink-0 mx-0 mb-0"><Button type="button" variant="ghost" onClick={props.onClose} disabled={busy}>{t("wiki.cancel")}</Button><Button type="submit" disabled={busy || !valid}>{busy ? <Loader2 size={16} className="animate-spin" /> : null}{t(tab === "join" ? "wiki.join" : "wiki.create")}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

function WikiSharingPanel(props: { client: LegalworkServerClient; serverUrl: string; wiki: WikiVault; busy: boolean; onShare: (input: WikiSharingInput, update: boolean) => Promise<void>; onStop: () => Promise<void>; onError: (message: string | null) => void; onBusyChange: (busy: boolean) => void }) {
  const [input, setInput] = useState<WikiSharingInput>(wikiSharingInput(props.wiki.pendingSharing ?? props.wiki.sharing));
  const [confirmStop, setConfirmStop] = useState(false);
  const [sharing, setSharing] = useState(false);
  const team = useQuery({ queryKey: ["wiki-team", props.serverUrl], queryFn: () => props.client.wikiTeam(), retry: false });
  const teamBinding = props.wiki.sync && "kind" in props.wiki.sync ? props.wiki.sync : null;
  const record = props.wiki.sharing ?? (teamBinding ? team.data?.items.find((item) => item.id === teamBinding.wikiId) : undefined);
  const legacy = Boolean(props.wiki.sync && !("kind" in props.wiki.sync));
  useEffect(() => { setInput(wikiSharingInput(props.wiki.pendingSharing ?? record)); setConfirmStop(false); }, [props.wiki.pendingSharing?.access, props.wiki.pendingSharing?.memberIds.join(","), record?.id, record?.access, record?.memberIds.join(",")]);
  const run = async (operation: () => Promise<void>) => { setSharing(true); props.onBusyChange(true); props.onError(null); try { await operation(); } catch (error) { props.onError(wikiSharingError(error)); } finally { setSharing(false); props.onBusyChange(false); } };
  const editable = (!record && !teamBinding) || record?.role === "owner";
  return <section className="space-y-5">
    <div className="flex items-start gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/50">{record || teamBinding || legacy ? <Users size={18} /> : <UserRound size={18} />}</span><div className="space-y-1"><h3 className="text-sm font-medium">{t(record ? record.access === "org" ? "wiki.shared_with_firm" : "wiki.shared_with_members" : teamBinding ? "wiki.shared_label" : legacy ? "wiki.move_sharing" : "wiki.personal_label")}</h3><p className="text-xs leading-relaxed text-muted-foreground">{t(record ? "wiki.team_sync_hint" : teamBinding ? "wiki.sharing_unavailable" : legacy ? "wiki.legacy_sharing" : "wiki.personal_hint")}</p></div></div>
    <TeamNotice loading={team.isLoading} error={team.error} team={team.data} retry={() => void team.refetch()} />
    {editable ? <>
      {team.data ? <AudienceFields team={team.data} value={input} onChange={setInput} disabled={sharing || props.busy} /> : null}
      <div className="flex flex-wrap items-center gap-2"><Button type="button" disabled={sharing || props.busy || !wikiSharingValid(input, team.data)} onClick={() => void run(() => props.onShare(input, Boolean(record)))}>{sharing ? <Loader2 size={16} className="animate-spin" /> : <Users size={16} />}{t(record ? "wiki.update_audience" : legacy ? "wiki.move_sharing" : "wiki.share_wiki")}</Button></div>
      {record ? <div className="border-t pt-4"><Button type="button" variant="ghost" size="sm" disabled={sharing || props.busy} className="-ml-2 text-destructive" onClick={() => { if (confirmStop) void run(props.onStop); else setConfirmStop(true); }}>{t(confirmStop ? "wiki.stop_sharing_confirm" : "wiki.stop_sharing")}</Button>{confirmStop ? <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{t("wiki.stop_sharing_hint")}</p> : null}</div> : null}
    </> : <div className="space-y-3 rounded-xl border bg-muted/20 p-4"><p className="text-xs text-muted-foreground">{t(record ? "wiki.owner_manages_sharing" : "wiki.sharing_unavailable")}</p>{record?.access === "members" && team.data ? <div className="text-sm">{record.memberIds.map((id) => { const member = team.data.members.find((entry) => entry.userId === id); return member?.name || member?.email; }).filter(Boolean).join(", ")}</div> : null}</div>}
  </section>;
}

export function WikiSettingsDialog(props: { client: LegalworkServerClient; serverUrl: string; wiki: WikiVault; projectWorkspaces: WikiWorkspaceOption[]; initialTab?: "general" | "sharing" | "agents"; onClose: () => void; onUpdate: (input: WikiUpdateInput) => Promise<void>; onShare: (input: WikiSharingInput, update: boolean) => Promise<void>; onStopSharing: () => Promise<void>; onForget: () => Promise<void> }) {
  const [tab, setTab] = useState(props.initialTab ?? "general");
  const [name, setName] = useState(props.wiki.name);
  const [requireAgentApproval, setRequireAgentApproval] = useState(props.wiki.requireAgentApproval !== false);
  const [allowInProjects, setAllowInProjects] = useState(props.wiki.allowInProjects);
  const [projectWorkspaceIds, setProjectWorkspaceIds] = useState<string[] | null>(props.wiki.projectWorkspaceIds ?? null);
  const [busy, setBusy] = useState(false);
  const [sharingBusy, setSharingBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState(false);
  const working = busy || sharingBusy;
  const run = async (operation: () => Promise<void>) => { setBusy(true); setError(null); try { await operation(); } catch (err) { setError(wikiError(err)); } finally { setBusy(false); } };
  return <Dialog open onOpenChange={(open) => { if (!open && !working) props.onClose(); }}>
    <DialogContent className="wiki-dialog flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-lg">
      <form className="flex min-h-0 flex-col overflow-hidden" onSubmit={(event) => { event.preventDefault(); if (tab !== "sharing" && !working && name.trim()) void run(() => props.onUpdate({ name: name.trim(), allowInProjects, projectWorkspaceIds, requireAgentApproval })); }}>
        <DialogHeader className="wiki-dialog-header shrink-0 px-6 pb-4 pt-6 pr-12"><DialogTitle>{t("wiki.settings")}</DialogTitle><DialogDescription>{t("wiki.settings_hint")}</DialogDescription></DialogHeader>
        <Tabs value={tab} onValueChange={(value) => { if (value === "general" || value === "sharing" || value === "agents") setTab(value); }} className="min-h-0 gap-0">
          <TabsList className="wiki-dialog-tabs shrink-0 mx-6 mb-1 w-auto"><TabsTrigger value="general" disabled={working}>{t("wiki.settings_general")}</TabsTrigger><TabsTrigger value="sharing" disabled={working}>{t("wiki.sharing")}</TabsTrigger><TabsTrigger value="agents" disabled={working}>{t("wiki.settings_agents")}</TabsTrigger></TabsList>
          <div className="wiki-dialog-body max-h-[60vh] overflow-y-auto px-6 py-5">
            <TabsContent value="general" keepMounted className="space-y-5">
              <label className="grid gap-2 text-sm font-medium">{t("wiki.name")}<Input required disabled={working} value={name} maxLength={100} onChange={(event) => setName(event.target.value)} /></label>
              <details className="group rounded-xl border px-4 py-3">
                <summary className="flex cursor-pointer list-none items-center gap-2 text-sm"><FolderOpen size={16} className="text-muted-foreground" />{t("wiki.local_files")}<ChevronDown size={14} className="ml-auto text-muted-foreground transition-transform group-open:rotate-180" /></summary>
                <div className="space-y-4 pt-4">
                  {!props.wiki.isDefaultLocation ? <div className="border-b pb-4">
                    <p className="mb-2 text-xs text-muted-foreground">{t("wiki.folder")}</p>
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="min-w-0 flex-1" title={props.wiki.root}><p className="truncate text-sm font-medium">{props.wiki.root.split(/[/\\]/).filter(Boolean).at(-1) ?? props.wiki.root}</p><p className="select-text truncate text-xs text-muted-foreground">{props.wiki.root}</p></div>
                      <Button type="button" size="icon-sm" variant="ghost" className="shrink-0" aria-label={t("wiki.copy_path")} title={t("wiki.copy_path")} onClick={() => { void navigator.clipboard.writeText(props.wiki.root).then(() => toast.success(t("wiki.copied"))).catch((error) => setError(wikiError(error))); }}><Copy size={14} /></Button>
                    </div>
                  </div> : null}
                  <div><p className="text-xs leading-relaxed text-muted-foreground">{t("wiki.forget_hint")}</p><Button size="sm" variant="ghost" className="-ml-2 mt-2 text-destructive" type="button" disabled={working} onClick={() => { if (removeConfirm) void run(props.onForget); else setRemoveConfirm(true); }}><Trash2 size={14} />{t(removeConfirm ? "wiki.forget_confirm" : "wiki.forget")}</Button></div>
                </div>
              </details>
            </TabsContent>
            <TabsContent value="sharing" keepMounted><WikiSharingPanel client={props.client} serverUrl={props.serverUrl} wiki={props.wiki} busy={busy} onShare={props.onShare} onStop={props.onStopSharing} onError={setError} onBusyChange={setSharingBusy} /></TabsContent>
            <TabsContent value="agents" keepMounted className="space-y-5">
              <div className="flex items-start justify-between gap-4"><Label htmlFor="wiki-agent-approval" className="block text-sm leading-normal"><span className="font-medium">{t("wiki.agent_approval")}</span><span className="mt-2 block font-normal text-xs leading-relaxed text-muted-foreground">{t("wiki.agent_approval_hint")}</span></Label><Switch id="wiki-agent-approval" className="mt-0.5" checked={requireAgentApproval} disabled={working} onCheckedChange={setRequireAgentApproval} /></div>
              <div className="flex items-start justify-between gap-4"><Label htmlFor="wiki-project-access" className="block text-sm leading-normal"><span className="font-medium">{t("wiki.project_access")}</span><span className="mt-2 block font-normal text-xs leading-relaxed text-muted-foreground">{t("wiki.project_access_hint")}</span></Label><Switch id="wiki-project-access" className="mt-0.5" checked={allowInProjects} disabled={working} onCheckedChange={setAllowInProjects} /></div>
              {allowInProjects ? <div className="overflow-hidden rounded-xl border"><label className="flex cursor-pointer items-center gap-3 bg-muted/20 px-4 py-3 text-sm"><input type="checkbox" className="size-4 accent-primary" disabled={working} checked={projectWorkspaceIds === null} onChange={(event) => setProjectWorkspaceIds(event.target.checked ? null : [])} />{t("wiki.all_projects")}</label>{projectWorkspaceIds !== null ? <div className="max-h-48 overflow-y-auto border-t p-1">{props.projectWorkspaces.length ? props.projectWorkspaces.map((workspace) => <label key={workspace.id} className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm hover:bg-muted/30"><input type="checkbox" className="size-4 accent-primary" disabled={working} checked={projectWorkspaceIds.includes(workspace.id)} onChange={(event) => setProjectWorkspaceIds((current) => event.target.checked ? [...current ?? [], workspace.id] : (current ?? []).filter((id) => id !== workspace.id))} /><span className="truncate">{workspace.displayNameResolved}</span></label>) : <p className="px-3 py-4 text-xs text-muted-foreground">{t("wiki.no_projects")}</p>}</div> : null}</div> : null}
            </TabsContent>
            {error ? <div className="mt-4"><DialogError message={error} /></div> : null}
          </div>
        </Tabs>
        <DialogFooter className="wiki-dialog-footer shrink-0 mx-0 mb-0 items-center"><p className="mr-auto text-xs text-muted-foreground">{t("wiki.storage_size", { pages: props.wiki.pageCount, size: formatWikiSize(props.wiki.totalBytes) })}</p><Button variant="ghost" type="button" onClick={props.onClose} disabled={working}>{t(tab === "sharing" ? "common.close" : "wiki.cancel")}</Button>{tab !== "sharing" ? <Button disabled={working || !name.trim()} type="submit">{busy ? <Loader2 size={16} className="animate-spin" /> : null}{t("wiki.save")}</Button> : null}</DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function NewWikiPageDialog(props: { pages: WikiPage[]; initialPath?: string; onClose: () => void; onCreate: (path: string, templatePath: string | null) => Promise<void> }) {
  const initialPath = (props.initialPath ?? "").replace(/\\/g, "/");
  const initialSeparator = initialPath.lastIndexOf("/");
  const [title, setTitle] = useState(initialPath.slice(initialSeparator + 1).replace(/\.md$/i, ""));
  const [folder, setFolder] = useState(initialSeparator >= 0 ? initialPath.slice(0, initialSeparator) : "");
  const [template, setTemplate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const templates = props.pages.filter((page) => /^Templates\//i.test(page.path) || page.type === "template");
  const path = `${folder.trim() ? `${folder.trim()}/` : ""}${title.trim()}`;
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) props.onClose(); }}>
    <DialogContent className="wiki-dialog flex max-h-[90vh] flex-col gap-0 p-0">
      <form className="flex min-h-0 flex-col overflow-hidden" onSubmit={(event) => { event.preventDefault(); if (!title.trim()) return; setError(null); setBusy(true); void Promise.resolve().then(() => props.onCreate(wikiNewPagePath(path), template || null)).catch((err) => setError(wikiError(err))).finally(() => setBusy(false)); }}>
        <DialogHeader className="wiki-dialog-header shrink-0 px-6 pb-4 pt-6 pr-12"><DialogTitle>{t("wiki.new_page")}</DialogTitle><DialogDescription>{t("wiki.new_page_hint")}</DialogDescription></DialogHeader>
        <div className="wiki-dialog-body max-h-[65vh] space-y-5 overflow-y-auto px-6 pb-6 pt-2">
          <label className="grid gap-2 text-sm font-medium">{t("wiki.page_title")}<Input autoFocus required value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} placeholder={t("wiki.page_title_placeholder")} /></label>
          {templates.length ? <label className="grid gap-2 text-sm font-medium">{t("wiki.template")}<select className={wikiSelectClass} value={template} disabled={busy} onChange={(event) => setTemplate(event.target.value)}><option value="">{t("wiki.no_template")}</option>{templates.map((page) => <option key={page.path} value={page.path}>{page.title}</option>)}</select></label> : null}
          <details className="group border-t pt-4" open={initialSeparator >= 0 ? true : undefined}><summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground"><FolderOpen size={14} />{t("wiki.page_folder")}<ChevronDown size={14} className="ml-auto transition-transform group-open:rotate-180" /></summary><div className="space-y-2 pt-3"><Input aria-label={t("wiki.page_folder")} value={folder} disabled={busy} onChange={(event) => setFolder(event.target.value)} placeholder={t("wiki.page_folder_placeholder")} />{title.trim() ? <p className="break-all font-mono text-xs text-muted-foreground">{/\.md$/i.test(path) ? path : `${path}.md`}</p> : null}</div></details>
          <DialogError message={error} />
        </div>
        <DialogFooter className="wiki-dialog-footer shrink-0 mx-0 mb-0"><Button variant="ghost" type="button" onClick={props.onClose} disabled={busy}>{t("wiki.cancel")}</Button><Button type="submit" disabled={busy || !title.trim()}>{busy ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}{t("wiki.page_create")}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

export function formatWikiSize(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }

export function WikiHistoryDialog(props: { client: LegalworkServerClient; wikiId: string; initialPath: string; serverUrl?: string; writable?: boolean; onClose: () => void; onRestore: (path: string, revisionId: string, baseRevision: string) => Promise<void>; onRestoreTrash: (id: string) => Promise<void> }) {
  const [selected, setSelected] = useState<WikiRevision | null>(null);
  const [tab, setTab] = useState("history");
  const [path, setPath] = useState(props.initialPath);
  const [limit, setLimit] = useState(50);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const history = useQuery({ queryKey: ["wiki-history", props.serverUrl, props.wikiId, path], queryFn: () => props.client.wikiHistory(props.wikiId, path), enabled: tab === "history" });
  const trash = useQuery({ queryKey: ["wiki-trash", props.serverUrl, props.wikiId], queryFn: () => props.client.wikiTrash(props.wikiId), enabled: tab === "trash" });
  return <Dialog open onOpenChange={(open) => { if (!open && !busyId) props.onClose(); }}>
    <DialogContent className="wiki-dialog flex max-h-[90vh] flex-col gap-0 p-0 sm:max-w-xl">
      <DialogHeader className="wiki-dialog-header shrink-0 px-6 pb-4 pt-6 pr-12"><DialogTitle>{t("wiki.history")}</DialogTitle><DialogDescription>{t(tab === "trash" ? "wiki.trash_hint" : props.writable === false ? "wiki.history_read_only_hint" : "wiki.history_hint")}</DialogDescription></DialogHeader>
      <Tabs value={tab} onValueChange={(value) => { if (value === "history" || value === "trash") { setTab(value); setError(null); } }} className="min-h-0 gap-0">
        <TabsList className="wiki-dialog-tabs shrink-0 mx-6 mb-1 w-auto"><TabsTrigger value="history" disabled={Boolean(busyId)}><History size={14} />{t("wiki.history")}</TabsTrigger><TabsTrigger value="trash" disabled={Boolean(busyId)}><Trash2 size={14} />{t("wiki.trash")}</TabsTrigger></TabsList>
        <TabsContent value="history" className="wiki-dialog-body max-h-[65vh] space-y-4 overflow-y-auto px-6 pb-6 pt-4">
        <label className="grid gap-2 text-sm font-medium">{t("wiki.history_filter")}<Input value={path} disabled={Boolean(busyId)} onChange={(event) => { setPath(event.target.value); setLimit(50); }} placeholder={t("wiki.all_history")} /><span className="text-xs font-normal text-muted-foreground">{t("wiki.history_page_hint")}</span></label>
        <div className="wiki-history-list overflow-hidden rounded-xl border">
          {history.isLoading ? <div className="flex justify-center p-8"><Loader2 size={20} className="animate-spin text-muted-foreground" aria-label={t("wiki.loading")} /></div> : null}
          {history.data?.items.length === 0 ? <div className="p-8 text-center"><History size={24} className="mx-auto mb-3 text-muted-foreground" /><p className="text-sm text-muted-foreground">{t("wiki.no_history")}</p></div> : null}
          {history.data?.items.slice(0, limit).map((revision) => <button type="button" key={`${revision.path}/${revision.id}`} onClick={() => setSelected(revision)} className="wiki-history-row flex w-full items-center gap-3 border-b p-4 text-left last:border-b-0 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/40 text-muted-foreground">{revision.action === "delete" ? <Trash2 size={15} /> : revision.action === "restore" ? <RotateCcw size={15} /> : <FileText size={15} />}</span>
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{revision.path.split("/").at(-1)?.replace(/\.md$/i, "")}</p><p className="mt-0.5 truncate text-xs text-muted-foreground">{new Date(revision.createdAt).toLocaleString()} · {revision.action === "delete" ? t("wiki.revision_delete") : revision.action === "restore" ? t("wiki.revision_restore") : t("wiki.revision_write")} · {formatWikiSize(revision.size)}</p>{revision.path.includes("/") ? <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground/75">{revision.path}</p> : null}</div>
            <span className="flex shrink-0 flex-col items-end gap-1"><WikiDiffStats changes={revision.changes} /><span className="text-xs text-muted-foreground">{t("wiki.preview_version")} →</span></span>
          </button>)}
        </div>
        {history.data && history.data.items.length > limit ? <Button type="button" variant="ghost" size="sm" onClick={() => setLimit((current) => current + 50)}>{t("wiki.show_more", { remaining: history.data.items.length - limit })}</Button> : null}
        <DialogError message={error || (history.error ? wikiError(history.error) : null)} />
        </TabsContent>
        <TabsContent value="trash" className="wiki-dialog-body max-h-[65vh] space-y-4 overflow-y-auto px-6 pb-6 pt-4">
          {trash.isLoading ? <div className="flex justify-center p-8"><Loader2 size={20} className="animate-spin text-muted-foreground" aria-label={t("wiki.loading")} /></div> : trash.data?.items.length === 0 ? <div className="p-8 text-center"><Trash2 size={24} className="mx-auto mb-3 text-muted-foreground" /><p className="text-sm text-muted-foreground">{t("wiki.trash_empty")}</p></div> : trash.data?.items.map((entry) => <div key={entry.id} className="flex items-center gap-3 border-b py-3 last:border-b-0"><span className="min-w-0 flex-1 truncate text-sm" title={entry.path}>{entry.path}</span><Button size="sm" variant="outline" disabled={props.writable === false || Boolean(busyId)} onClick={() => { setBusyId(entry.id); setError(null); void props.onRestoreTrash(entry.id).then(() => trash.refetch()).catch((err) => setError(wikiError(err))).finally(() => setBusyId(null)); }}>{busyId === entry.id ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}{t("wiki.restore")}</Button></div>)}
          <DialogError message={error || (trash.error ? wikiError(trash.error) : null)} />
        </TabsContent>
      </Tabs>
      <DialogFooter className="wiki-dialog-footer shrink-0 mx-0 mb-0"><Button type="button" variant="ghost" disabled={Boolean(busyId)} onClick={props.onClose}>{t("common.close")}</Button></DialogFooter>
    </DialogContent>
    {selected && <WikiRevisionDialog client={props.client} wikiId={props.wikiId} revision={selected} writable={props.writable !== false} onClose={() => setSelected(null)} onRestore={async (path, id, baseRevision) => { await props.onRestore(path, id, baseRevision); await history.refetch(); }} />}
  </Dialog>;
}
