import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, ArrowUpRight, Download, FolderOpen, Loader2, MessageSquare, Paperclip, Plus, X } from "lucide-react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { readWorkspaceFileDrag, hasWorkspaceFileDrag } from "@/app/lib/workspace-file-drag";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/sonner";
import { DocumentIcon } from "@/react-app/design-system/document-icon";
import { classifyOpenTarget } from "../session/artifacts/open-target";
import { workspaceSessionRoute } from "../../shell/workspace-routes";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";
import { calendarError } from "./calendar-format";

export function DeadlineLinks(props: {
  client: LegalworkServerClient; workspaceId: string; projectId: string;
  attachmentPaths: string[]; sessionIds: string[]; disabled: boolean;
  onAttachments: (paths: string[]) => void; onSessions: (ids: string[]) => void;
  onBusy: (busy: boolean) => void; onClose: () => void;
}) {
  const cache = useQueryClient(), navigate = useNavigate(), input = useRef<HTMLInputElement>(null);
  const [sessionPicker, setSessionPicker] = useState(false);
  const [picker, setPicker] = useState(false), [over, setOver] = useState(false), [busy, setBusy] = useState(false), [search, setSearch] = useState("");
  const links = useQuery({ queryKey: ["calendar-links", props.client.baseUrl, props.workspaceId, search], queryFn: () => props.client.calendarLinks(props.workspaceId, search) });
  const sessionOptions = (links.data?.sessions ?? []).filter(session => !props.sessionIds.includes(session.id)).map(session => ({ value: session.id, label: session.title }));
  const append = (paths: string[]) => {
    const next = [...new Set([...props.attachmentPaths, ...paths])];
    if (next.length > 50) { toast.error(t("calendar.attachment_limit")); return; }
    props.onAttachments(next);
  };
  const upload = async (files: File[]) => {
    if (busy || props.disabled || !files.length) return;
    setBusy(true); props.onBusy(true);
    const paths = [...props.attachmentPaths];
    try {
      for (const file of files) {
        if (paths.length >= 50) throw new Error(t("calendar.attachment_limit"));
        if (file.size > 20 * 1024 * 1024) throw new Error(t("calendar.attachment_size"));
        const cleaned = file.name.replace(/[\x00-\x1f/\\:*?"<>|]/g, "_").replace(/^[.]+|[. ]+$/g, "") || "attachment";
        const name = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(cleaned) ? `_${cleaned}` : cleaned;
        const written = await props.client.writeWorkspaceBinaryFile(props.workspaceId, { path: `Deadline attachments/${crypto.randomUUID()}/${name}`, data: await file.arrayBuffer() });
        if (!written.ok || !written.path) throw new Error(t("workspace.upload_incomplete"));
        paths.push(written.path);
        props.onAttachments([...paths]);
      }
    } catch (error) { toast.error(calendarError(error)); }
    finally {
      setBusy(false); props.onBusy(false);
      for (const key of ["workspace-files", "project-files", "deadline-file-picker"]) void cache.invalidateQueries({ queryKey: [key] });
    }
  };
  const download = async (path: string) => {
    try {
      const file = await props.client.downloadWorkspaceFile(props.workspaceId, path);
      const url = URL.createObjectURL(new Blob([file.data], { type: file.contentType ?? "application/octet-stream" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = path.split("/").at(-1) ?? "attachment";
      document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
    } catch (error) { toast.error(calendarError(error)); }
  };
  return <>
    <section className={cn("space-y-2 rounded-lg", over && "bg-muted/50 ring-1 ring-border")} onDragOver={event => {
      if (!hasWorkspaceFileDrag(event.dataTransfer) && !Array.from(event.dataTransfer.types).includes("Files")) return;
      event.preventDefault(); event.stopPropagation(); setOver(!props.disabled && !busy);
    }} onDragLeave={() => setOver(false)} onDrop={event => {
      event.preventDefault(); event.stopPropagation(); setOver(false);
      if (props.disabled || busy) return;
      const file = readWorkspaceFileDrag(event.dataTransfer);
      if (file) {
        if (file.workspaceId !== props.workspaceId) { toast.error(t("calendar.attachment_project")); return; }
        append([file.path]);
      } else void upload(Array.from(event.dataTransfer.files));
    }}>
      <div className="flex flex-wrap items-center gap-1">
        <span className="me-auto flex items-center gap-3 py-1 text-xs font-medium"><Paperclip className="size-4 text-muted-foreground" />{props.attachmentPaths.length ? t("tasks.attachments_count", { count: props.attachmentPaths.length }) : t("tasks.attachments_empty")}</span>
        <DropdownMenu><DropdownMenuTrigger render={<Button type="button" variant="ghost" size="sm" className="h-8 text-xs font-normal text-muted-foreground" disabled={props.disabled || busy || props.attachmentPaths.length >= 50} />}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}{t("tasks.add_attachment")}
        </DropdownMenuTrigger><DropdownMenuContent align="start"><DropdownMenuItem onClick={() => setPicker(true)}><FolderOpen />{t("calendar.choose_project_file")}</DropdownMenuItem><DropdownMenuItem onClick={() => input.current?.click()}><Plus />{t("calendar.upload_file")}</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
        <Popover open={sessionPicker} onOpenChange={open => { setSessionPicker(open); if (!open) setSearch(""); }}>
          <PopoverTrigger render={<Button type="button" variant="ghost" size="sm" className="h-8 text-xs font-normal text-muted-foreground" disabled={props.disabled || busy || props.sessionIds.length >= 50} />}><MessageSquare className="size-3.5" />{t("calendar.link_session")}</PopoverTrigger>
          <PopoverContent align="start" className="w-80 gap-0 overflow-hidden p-0">
            <div className="border-b border-border/60 p-2"><Input autoFocus aria-label={t("calendar.search_sessions")} placeholder={t("calendar.search_sessions")} className="h-8 border-0 bg-transparent text-xs shadow-none focus-visible:ring-0" value={search} onChange={event => setSearch(event.target.value)} /></div>
            <div className="max-h-56 overflow-y-auto p-1">
              {links.isPending ? <p role="status" className="p-3 text-xs text-muted-foreground">{t("calendar.loading")}</p> : links.isError ? <div className="p-3 text-xs text-muted-foreground"><p role="alert">{t("calendar.sessions_unavailable")}</p><Button type="button" variant="link" className="h-auto p-0 text-xs" onClick={() => void links.refetch()}>{t("common.refresh")}</Button></div> : sessionOptions.length ? sessionOptions.map(session => <Button key={session.value} type="button" variant="ghost" className="h-auto w-full justify-start px-2 py-2 text-xs font-normal" onClick={() => { props.onSessions([...props.sessionIds, session.value]); setSessionPicker(false); setSearch(""); }}><MessageSquare className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{session.label}</span></Button>) : <p className="p-3 text-xs text-muted-foreground">{t(search ? "content_search.no_results" : "calendar.no_sessions")}</p>}
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <input ref={input} type="file" multiple className="hidden" onChange={event => { void upload(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      {over && <p className="px-2 pb-3 text-xs text-muted-foreground">{t("calendar.attachments_hint")}</p>}
      {props.sessionIds.length > 0 && <ul className="space-y-1" aria-label={t("calendar.linked_sessions")}>{props.sessionIds.map(id => <li key={id} className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/30 px-2">
        <Button type="button" variant="ghost" className="h-auto min-w-0 flex-1 justify-start px-0 py-2 text-xs font-normal" disabled={props.disabled || busy} onClick={() => { props.onClose(); navigate(workspaceSessionRoute(props.projectId, id)); }}><MessageSquare className="size-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{links.data?.sessions.find(session => session.id === id)?.title ?? t("calendar.linked_session")}</span><ArrowUpRight className="ml-auto size-3 shrink-0 text-muted-foreground" /></Button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={t("calendar.unlink_session")} disabled={props.disabled} onClick={() => props.onSessions(props.sessionIds.filter(value => value !== id))}><X /></Button>
      </li>)}</ul>}
      {props.attachmentPaths.length > 0 && <ul className="space-y-1" aria-label={t("calendar.attachments")}>{props.attachmentPaths.map(path => <li key={path} className="flex min-w-0 items-center gap-2 rounded-lg bg-muted/30 px-2 py-1.5">
        <DocumentIcon kind={classifyOpenTarget(path, "file")} className="size-5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-xs" title={path}>{path.split("/").at(-1)}</span>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={`${t("tasks.download_attachment")}: ${path.split("/").at(-1)}`} onClick={() => void download(path)}><Download /></Button>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={`${t("tasks.remove_attachment")}: ${path.split("/").at(-1)}`} disabled={props.disabled || busy} onClick={() => props.onAttachments(props.attachmentPaths.filter(value => value !== path))}><X /></Button>
      </li>)}</ul>}
    </section>
    {picker && <ProjectFilePicker client={props.client} workspaceId={props.workspaceId} selected={props.attachmentPaths} onClose={() => setPicker(false)} onSelect={path => { append([path]); setPicker(false); }} />}
  </>;
}

function ProjectFilePicker(props: { client: LegalworkServerClient; workspaceId: string; selected: string[]; onClose: () => void; onSelect: (path: string) => void }) {
  const [path, setPath] = useState(""), [search, setSearch] = useState("");
  const files = useQuery({ queryKey: ["deadline-file-picker", props.client.baseUrl, props.workspaceId, path], queryFn: () => props.client.listWorkspaceDirectory(props.workspaceId, path) });
  const visible = files.data?.entries.filter(entry => !entry.name.startsWith(".") && entry.name.toLowerCase().includes(search.toLowerCase())) ?? [];
  return <Dialog open onOpenChange={open => { if (!open) props.onClose(); }}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>{t("calendar.choose_project_file")}</DialogTitle></DialogHeader>
    <div className="flex min-w-0 items-center gap-2"><Button type="button" variant="ghost" size="icon-sm" disabled={!path} aria-label={t("calendar.parent_folder")} onClick={() => { setPath(path.split("/").slice(0, -1).join("/")); setSearch(""); }}><ArrowLeft /></Button><span className="truncate text-xs text-muted-foreground" title={path}>{path || t("workspace_files.files")}</span></div>
    <Input aria-label={t("calendar.search_files")} placeholder={t("calendar.search_files")} value={search} onChange={event => setSearch(event.target.value)} />
    <div className="max-h-72 min-h-32 overflow-y-auto">{files.isPending ? <Loader2 className="mx-auto my-8 size-5 animate-spin" /> : files.isError ? <p role="alert" className="p-3 text-sm">{calendarError(files.error)}</p> : !visible.length ? <p className="py-6 text-center text-xs text-muted-foreground">{t(search ? "content_search.no_results" : "workspace_files.empty_title")}</p> : <ul>{visible.map(entry => <li key={entry.path}><Button type="button" variant="ghost" className="w-full justify-start text-sm" disabled={props.selected.includes(entry.path)} onClick={() => { if (entry.kind === "dir") { setPath(entry.path); setSearch(""); } else props.onSelect(entry.path); }}>{entry.kind === "dir" ? <FolderOpen className="size-4 shrink-0" /> : <DocumentIcon kind={classifyOpenTarget(entry.name, "file")} className="size-4 shrink-0" />}<span className="truncate">{entry.name}</span></Button></li>)}</ul>}</div>
  </DialogContent></Dialog>;
}
