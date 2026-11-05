import { t } from "@/i18n";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, ChevronLeft, ChevronRight, Folder, Pencil } from "lucide-react";
import type { WikiVault } from "@legalwork/types/wiki";
import type { WikiSuggestionDestination } from "@legalwork/types/wiki-suggestions";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { suggestionLocation, suggestionPagePath } from "./wiki-suggestion-model";

export function WikiSuggestionDestinationPicker({ client, wikis, value, disabled, onChange }: {
  client: LegalworkServerClient; wikis: WikiVault[]; value: WikiSuggestionDestination;
  disabled: boolean; onChange: (value: WikiSuggestionDestination) => void;
}) {
  const [open, setOpen] = useState(false);
  const [wikiId, setWikiId] = useState(value.wikiId);
  const [folder, setFolder] = useState(suggestionLocation(value.path).folder);
  const [name, setName] = useState(suggestionLocation(value.path).name);
  const snapshot = useQuery({ queryKey: ["wiki-suggestion-destination", client.baseUrl, wikiId], queryFn: () => client.wikiSnapshot(wikiId), enabled: open, staleTime: 0 });
  const folders = snapshot.data?.folders ?? [];
  const proposedFolder = Boolean(value.createFolders && wikiId === value.wikiId && snapshot.data?.wiki.purpose === "legal-research" && folder && (folder === suggestionLocation(value.path).folder || suggestionLocation(value.path).folder.startsWith(`${folder}/`)));
  const validFolder = Boolean(snapshot.data && (!folder || folders.includes(folder) || proposedFolder));
  const path = suggestionPagePath(folder, name);
  const selectedWiki = wikis.find(wiki => wiki.id === wikiId);
  const children = folders.filter(path => suggestionLocation(path).folder === folder).sort((a, b) => a.localeCompare(b));
  return <Popover open={open} onOpenChange={next => {
    if (next) { setWikiId(value.wikiId); setFolder(suggestionLocation(value.path).folder); setName(suggestionLocation(value.path).name); }
    setOpen(next);
  }}>
    <PopoverTrigger disabled={disabled} className="flex max-w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Change save location">
      <BookOpen className="size-3.5 shrink-0" /><span className="truncate">{wikis.find(wiki => wiki.id === value.wikiId)?.name ?? "Choose wiki"}</span>
      {suggestionLocation(value.path).folder && <><ChevronRight className="size-3 shrink-0" /><span className="truncate">{suggestionLocation(value.path).folder.split("/").join(" / ")}</span></>}
      <ChevronRight className="size-3 shrink-0" /><span className="truncate">{suggestionLocation(value.path).name}</span><Pencil className="ml-1 size-3 shrink-0" />
    </PopoverTrigger>
    <PopoverContent align="start" className="w-80 gap-3 p-3">
      <PopoverTitle className="text-sm">Save location</PopoverTitle>
      <Select value={wikiId} items={wikis.map(wiki => ({ value: wiki.id, label: wiki.name }))} onValueChange={id => { if (id) { setWikiId(id); setFolder(""); } }}>
        <SelectTrigger aria-label="Destination wiki" className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent>{wikis.map(wiki => <SelectItem key={wiki.id} value={wiki.id}>{wiki.name}</SelectItem>)}</SelectContent>
      </Select>
      <div className="rounded-md border">
        <div className="flex items-center gap-1 border-b px-2 py-1.5 text-xs">
          {folder && <Button size="icon-sm" variant="ghost" aria-label="Parent folder" onClick={() => setFolder(suggestionLocation(folder).folder)}><ChevronLeft className="size-3.5" /></Button>}
          <span className="truncate">{folder ? folder.split("/").join(" / ") : "Wiki home"}</span>
        </div>
        <div className="max-h-48 overflow-auto p-1" aria-label="Wiki folders">
          {snapshot.isFetching ? <p className="px-2 py-3 text-xs text-muted-foreground">Loading folders…</p> : snapshot.error ? <p role="alert" className="px-2 py-3 text-xs text-destructive">Could not load folders. <button className="underline" onClick={() => void snapshot.refetch()}>Retry</button></p> : !validFolder ? <p role="alert" className="px-2 py-3 text-xs">This folder is no longer available. <button className="underline" onClick={() => setFolder("")}>Choose another folder</button></p> : children.length ? children.map(path => <button key={path} className="flex w-full items-center gap-2 rounded px-2 py-2 text-left text-sm hover:bg-muted" onClick={() => setFolder(path)}><Folder className="size-4 text-muted-foreground" /><span className="truncate">{path.split("/").at(-1)}</span><ChevronRight className="ml-auto size-3 text-muted-foreground" /></button>) : <p className="px-2 py-3 text-xs text-muted-foreground">No subfolders</p>}
        </div>
      </div>
      {proposedFolder && !folders.includes(folder) && <p className="text-xs text-muted-foreground">{t("research.new_folders_on_save", { path: folder.split("/").join(" / ") })}</p>}
      <label className="space-y-1.5 text-xs text-muted-foreground">File name<Input aria-label="Page file name" className="mt-1.5" value={name} onChange={event => setName(event.target.value)} /></label>
      {!path && <p className="text-xs text-destructive">Enter a name without slashes.</p>}
      <Button size="sm" disabled={!selectedWiki || !validFolder || snapshot.isFetching || !path} onClick={() => {
        if (!path) return;
        onChange({ wikiId, path, ...(proposedFolder && !folders.includes(folder) ? { createFolders: true } : {}), baseRevision: wikiId === value.wikiId && path === value.path ? value.baseRevision : null });
        setOpen(false);
      }}>Use this location</Button>
    </PopoverContent>
  </Popover>;
}
