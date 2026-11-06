import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Trash2 } from "lucide-react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { pickDirectory } from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { LayoutSectionItem, LayoutSectionItemDescription, LayoutSectionItemHeader, LayoutSectionItemTitle } from "../settings-layout";

export function LauncherFoldersSection({ client }: { client: LegalworkServerClient }) {
  const cache = useQueryClient();
  const folders = useQuery({ queryKey: ["launcher-folders", client.baseUrl], queryFn: () => client.launcherFolders() });
  const [path, setPath] = useState(""), [name, setName] = useState(""), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const local = isDesktopRuntime() && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(client.baseUrl).hostname);
  const change = async (work: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await work(); await folders.refetch(); await cache.invalidateQueries({ queryKey: ["launcher-preview"] }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  const browse = async () => {
    try { const selected = await pickDirectory({ title: t("launcher.folders.choose") }); if (typeof selected === "string") setPath(selected); }
    catch (failure) { setError(String(failure)); }
  };
  return <LayoutSectionItem>
    <LayoutSectionItemHeader><div><LayoutSectionItemTitle>{t("launcher.folders.title")}</LayoutSectionItemTitle><LayoutSectionItemDescription>{t("launcher.folders.hint")}</LayoutSectionItemDescription></div></LayoutSectionItemHeader>
    <form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); void change(async () => { await client.addLauncherFolder({ path, name: name || undefined }); setPath(""); setName(""); }); }}>
      <div className="flex gap-2"><Input aria-label={t("launcher.folders.path")} placeholder={t("launcher.folders.path")} value={path} onChange={event => setPath(event.target.value)} disabled={busy} />
        {local && <Button type="button" variant="outline" onClick={() => void browse()} disabled={busy}><FolderPlus className="size-4" />{t("launcher.folders.choose")}</Button>}</div>
      <Input aria-label={t("launcher.folders.name")} placeholder={t("launcher.folders.name")} value={name} maxLength={160} onChange={event => setName(event.target.value)} disabled={busy} />
      <Button type="submit" className="self-start" disabled={busy || !path.trim()}>{t("launcher.folders.add")}</Button>
    </form>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {folders.isError && <p role="alert" className="text-sm text-destructive">{String(folders.error)}</p>}
    {folders.data?.folders.length === 0 && <p className="text-sm text-subtext">{t("launcher.folders.empty")}</p>}
    <ul className="divide-y divide-border">{folders.data?.folders.map(folder => <li className="flex items-center gap-3 py-3" key={folder.id}>
      <div className="min-w-0 flex-1"><p className="text-sm font-medium">{folder.name}</p><p className="break-all text-xs text-subtext">{folder.path}</p></div>
      <Button variant="ghost" size="icon-sm" aria-label={t("launcher.folders.remove", { name: folder.name })} disabled={busy} onClick={() => void change(() => client.removeLauncherFolder(folder.id))}><Trash2 className="size-4" /></Button>
    </li>)}</ul>
    <p className="text-xs text-subtext">{t("launcher.folders.remove_hint")}</p>
  </LayoutSectionItem>;
}
