import { useEffect, useRef, useState } from "react";
import JSZip from "jszip";
import { FolderOpen, Upload } from "lucide-react";
import type { PluginImportCandidate, PluginImportPreview, PluginImportProvider, PluginImportRequest, PluginImportScope, PluginImportSource } from "@legalwork/types/plugin-import";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { pickDirectory } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/utils";
import { t } from "@/i18n";

export type PluginImportStore = {
  discoverPluginImports(provider: PluginImportProvider): Promise<PluginImportCandidate[]>;
  previewPluginImports(request: PluginImportRequest): Promise<PluginImportPreview[]>;
  installPluginImport(request: PluginImportRequest): Promise<PluginImportPreview>;
};
export function PluginImportDialog(props: { provider: PluginImportProvider; store: PluginImportStore; canUseGlobalScope: boolean; onClose: () => void; onImported: () => void }) {
  const [scope, setScope] = useState<PluginImportScope>(props.canUseGlobalScope ? "global" : "project");
  const [path, setPath] = useState("");
  const [candidates, setCandidates] = useState<PluginImportCandidate[]>([]);
  const [discovering, setDiscovering] = useState(true);
  const [source, setSource] = useState<PluginImportSource | null>(null);
  const [previews, setPreviews] = useState<PluginImportPreview[]>([]);
  const [selectedRoot, setSelectedRoot] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const folderInput = useRef<HTMLInputElement>(null);
  const zipInput = useRef<HTMLInputElement>(null);
  const selected = previews.find(item => item.root === selectedRoot);
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    props.store.discoverPluginImports(props.provider).then(items => { if (!cancelled) setCandidates(items); }).catch(() => { /* Manual folder and ZIP import still work when discovery is unavailable. */ }).finally(() => { if (!cancelled) setDiscovering(false); });
    return () => { cancelled = true; mounted.current = false; };
  }, [props.provider, props.store]);
  const preview = async (nextSource: PluginImportSource) => {
    setBusy(true); setError(null); setPreviews([]); setSource(null);
    try {
      const items = await props.store.previewPluginImports({ source: nextSource, scope });
      if (!mounted.current) return;
      setSource(nextSource); setPreviews(items); setSelectedRoot(items[0]?.root ?? "");
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : t("extensions.import_failed")); }
    finally { if (mounted.current) setBusy(false); }
  };
  const chooseFolder = async () => {
    if (!isDesktopRuntime()) { folderInput.current?.click(); return; }
    try { const folder = await pickDirectory({ title: t("extensions.import_choose_folder") }); if (typeof folder === "string") { setPath(folder); await preview({ provider: props.provider, path: folder }); } }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("extensions.import_failed")); }
  };
  const upload = async (files: FileList | null, folder: boolean) => {
    if (!files?.length) return;
    setBusy(true); setError(null); setPreviews([]); setSource(null);
    try {
      const entries = Array.from(files);
      if (entries.length > 5000 || entries.reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024) throw new Error(t("extensions.import_size_limit"));
      let zipBase64: string;
      if (folder) {
        const zip = new JSZip();
        for (const file of entries) zip.file(file.webkitRelativePath || file.name, await file.arrayBuffer());
        zipBase64 = await zip.generateAsync({ type: "base64", compression: "DEFLATE" });
      } else {
        const bytes = new Uint8Array(await entries[0].arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        zipBase64 = btoa(binary);
      }
      await preview({ provider: props.provider, zipBase64 });
    } catch (cause) { if (mounted.current) { setError(cause instanceof Error ? cause.message : t("extensions.import_failed")); setBusy(false); } }
  };
  const install = async () => {
    if (!source || !selected) return;
    setBusy(true); setError(null);
    try {
      await props.store.installPluginImport({ source, scope, root: selected.root, digest: selected.digest });
      props.onImported(); props.onClose();
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : t("extensions.import_failed")); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <Dialog open onOpenChange={open => { if (!open && !busy) props.onClose(); }}>
    <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>{t(props.provider === "chatgpt" ? "extensions.import_chatgpt" : "extensions.import_claude")}</DialogTitle><DialogDescription>{t("extensions.import_description")}</DialogDescription></DialogHeader>
      <div className="space-y-4">
        <label className="block space-y-1"><span>{t("extensions.import_scope")}</span><select className="w-full rounded-lg border border-border bg-background p-2" value={scope} disabled={busy} onChange={event => { setScope(event.target.value === "global" ? "global" : "project"); setPreviews([]); setSource(null); }}>
          {props.canUseGlobalScope ? <option value="global">{t("extensions.import_all_projects")}</option> : null}<option value="project">{t("extensions.import_this_project")}</option>
        </select></label>
        <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void chooseFolder()}><FolderOpen />{t("extensions.import_choose_folder")}</Button><Button variant="outline" disabled={busy} onClick={() => zipInput.current?.click()}><Upload />{t("extensions.import_choose_zip")}</Button></div>
        <input ref={zipInput} type="file" accept=".zip,application/zip" className="hidden" aria-label={t("extensions.import_choose_zip")} onChange={event => { void upload(event.target.files, false); event.target.value = ""; }} />
        <input ref={element => { folderInput.current = element; element?.setAttribute("webkitdirectory", ""); }} type="file" multiple className="hidden" aria-label={t("extensions.import_choose_folder")} onChange={event => { void upload(event.target.files, true); event.target.value = ""; }} />
        <form className="flex gap-2" onSubmit={event => { event.preventDefault(); void preview({ provider: props.provider, path: path.trim() }); }}><Input aria-label={t("extensions.import_folder_path")} placeholder={t("extensions.import_folder_path")} value={path} disabled={busy} onChange={event => { setPath(event.target.value); setPreviews([]); setSource(null); }} /><Button variant="outline" type="submit" disabled={busy || !path.trim()}>{t("extensions.import_preview")}</Button></form>
        {discovering ? <p className="text-muted-foreground" role="status">{t("extensions.import_discovering")}</p> : candidates.length ? <div className="space-y-2"><p className="font-medium">{t("extensions.import_found")}</p><div className="max-h-40 overflow-y-auto space-y-1">{candidates.map(item => <Button key={item.path} className="w-full h-auto justify-start flex-col items-start whitespace-normal text-start" variant="outline" disabled={busy} onClick={() => { setPath(item.path); void preview({ provider: props.provider, path: item.path }); }}><span>{item.name}{item.version ? ` · ${item.version}` : ""}</span><span className="text-xs text-muted-foreground break-all">{item.path}</span></Button>)}</div></div> : <p className="text-muted-foreground text-sm">{t("extensions.import_none_found")}</p>}
        {previews.length > 1 ? <label className="block space-y-1"><span>{t("extensions.import_select_package")}</span><select className="w-full rounded-lg border border-border bg-background p-2" value={selectedRoot} disabled={busy} onChange={event => setSelectedRoot(event.target.value)}>{previews.map(item => <option key={item.root} value={item.root}>{item.name} · {item.root || "/"}</option>)}</select></label> : null}
        {selected ? <div className="rounded-xl border border-border p-4 space-y-3"><div><p className="font-medium">{selected.name}{selected.version ? ` · ${selected.version}` : ""}</p><p className="text-muted-foreground">{selected.description}</p><p className="text-xs text-muted-foreground">{t("extensions.import_file_count", { count: selected.fileCount })} · {(selected.bytes / 1024 / 1024).toFixed(1)} MB</p></div><ul className="space-y-1 max-h-40 overflow-y-auto">{selected.components.map(item => <li key={`${item.type}:${item.installedName}`} className="text-sm"><span className="text-muted-foreground">{t(item.type === "mcp" ? "extensions.connectors_label" : item.type === "skill" ? "skills.title" : item.type === "agent" ? "composer.agents_label" : "dashboard.commands")}</span> · {item.name}</li>)}</ul><div className="space-y-2"><p className="font-medium">{t("extensions.import_review")}</p><ul className="list-disc ps-5 text-sm text-muted-foreground space-y-1">{selected.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></div></div> : null}
        {error ? <p role="alert" className="text-red-11">{error}</p> : null}
        {busy ? <p role="status" className="text-muted-foreground">{t("extensions.import_working")}</p> : null}
      </div>
      <DialogFooter><Button variant="outline" disabled={busy} onClick={props.onClose}>{t("common.cancel")}</Button><Button disabled={busy || !selected || !source} onClick={() => void install()}>{t("extensions.import_install")}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
