import { useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, ChevronRight, Folder } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import { useLauncherShell } from "./launcher-shell";
import { handleLauncherFocusKey } from "./launcher-focus";
import { isComposingKeyEvent } from "./launcher-keyboard";

export function launcherFolderLabel(path: string) { return path ? path.split("/").join(" › ") : t("launcher.folder.root"); }

export function LauncherFolderPicker({ workspaceId, value, onChange, disabled, autoFocus }: {
  workspaceId: string; value: string; onChange: (path: string) => void; disabled?: boolean; autoFocus?: boolean;
}) {
  const { client } = useLauncherShell();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState(value);
  const [query, setQuery] = useState("");
  const popup = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const browsingPath = open ? path : value;
  const list = useQuery({ queryKey: ["launcher-save-folders", client.baseUrl, workspaceId, browsingPath],
    queryFn: () => client.listWorkspaceDirectory(workspaceId, browsingPath), enabled: Boolean(workspaceId),
    staleTime: 0, refetchOnWindowFocus: "always", refetchInterval: 2000, retry: false,
  });
  const navigate = (next: string) => { setPath(next); setQuery(""); input.current?.focus(); };
  const up = () => navigate(path.split("/").slice(0, -1).join("/"));
  const folders = (list.isError ? [] : list.data?.entries ?? []).filter(item => item.kind === "dir" && !item.name.startsWith(".") && item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <label htmlFor={id} className="min-w-0">{t("launcher.flow.folder")}
    <Popover open={open} onOpenChange={next => { setOpen(next); if (next) { setPath(value); setQuery(""); } }}>
      <PopoverTrigger render={<Button id={id} type="button" variant="outline" autoFocus={autoFocus} disabled={disabled || !workspaceId} className="w-full min-w-0 justify-start rounded-md" />}
        onKeyDown={event => { if (event.key === "ArrowDown") { event.preventDefault(); setPath(value); setQuery(""); setOpen(true); } }}>
        <Folder className="size-4 shrink-0" /><span className="min-w-0 flex-1 truncate text-left">{!open && list.isError ? t("launcher.folder.unavailable") : launcherFolderLabel(value)}</span><ChevronDown className="size-4 shrink-0" />
      </PopoverTrigger>
      <PopoverContent ref={popup} align="start" className="w-(--anchor-width) min-w-64 max-h-(--available-height) gap-2 overflow-y-auto rounded-lg p-2" initialFocus={input}
        onFocusCapture={event => event.target.scrollIntoView({ block: "nearest" })}
        onKeyDown={event => {
          event.stopPropagation();
          if (isComposingKeyEvent(event)) return;
          if (event.key === "Escape") { event.preventDefault(); setOpen(false); return; }
          if ((event.key === "ArrowLeft" || event.key === "Backspace") && path && (event.target !== input.current || !query)) { event.preventDefault(); up(); return; }
          if (event.key === "Enter" && event.target === input.current) {
            event.preventDefault();
            if (folders[0]) navigate(folders[0].path);
            else if (!query && list.isSuccess && !list.isFetching) { onChange(path); setOpen(false); }
            return;
          }
          if (event.key === "ArrowDown" && event.target === input.current) { event.preventDefault(); popup.current?.querySelector<HTMLButtonElement>("[data-folder-option]")?.focus(); return; }
          handleLauncherFocusKey(event, popup.current, true);
        }}>
        <div className="flex min-w-0 items-center gap-1">
          <Button type="button" size="icon-sm" variant="ghost" disabled={!path} aria-label={t("launcher.folder.up")} onClick={up}><ArrowLeft className="size-4" /></Button>
          <span className="truncate text-xs text-muted-foreground" title={launcherFolderLabel(path)}>{launcherFolderLabel(path)}</span>
        </div>
        <Input ref={input} value={query} placeholder={t("launcher.folder.search")} aria-label={t("launcher.folder.search")} onChange={event => setQuery(event.target.value)} />
        <div className="max-h-40 overflow-y-auto" aria-label={t("launcher.flow.folder")}>
          {list.isPending ? <p className="p-2 text-xs text-muted-foreground">{t("launcher.preview.loading")}</p> : list.isError ? <div role="alert" className="p-2 text-xs"><p>{t("launcher.folder.unavailable")}</p><Button type="button" variant="ghost" size="sm" onClick={() => navigate("")}>{t("launcher.folder.root")}</Button></div> : <>
            {folders.map(folder => <Button type="button" data-folder-option key={folder.path} variant="ghost" className="w-full justify-start rounded-md" onClick={() => navigate(folder.path)} onKeyDown={event => { if (event.key === "ArrowRight") { event.preventDefault(); event.stopPropagation(); navigate(folder.path); } }}>
              <Folder className="size-4 shrink-0" /><span className="flex-1 truncate text-left">{folder.name}</span><ChevronRight className="size-4 shrink-0" />
            </Button>)}
            {!folders.length && <p className="p-2 text-xs text-muted-foreground">{t(query ? "content_search.no_results" : "launcher.folder.no_subfolders")}</p>}
          </>}
        </div>
        <Button type="button" size="sm" disabled={!list.isSuccess || list.isFetching} onClick={() => { onChange(path); setOpen(false); }}>{t("launcher.folder.use")}</Button>
      </PopoverContent>
    </Popover>
  </label>;
}
