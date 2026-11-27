import { useState } from "react";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { t } from "@/i18n";
import { isComposingKeyEvent } from "./launcher-keyboard";

export function LauncherProjectChatPicker({ projects, onSelect, onBack }: {
  projects: { id: string; name: string; displayName?: string | null }[];
  onSelect: (id: string) => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState("");
  const matches = projects.filter(project => (project.displayName || project.name).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="p-2" onKeyDownCapture={event => {
    if (event.key === "Escape" && !isComposingKeyEvent(event)) { event.preventDefault(); event.stopPropagation(); onBack(); }
  }}>
    <Command items={matches.map(project => project.id)} filter={null} value={query} onValueChange={setQuery}>
      <CommandInput aria-label={t("launcher.chat.choose_project")} placeholder={t("launcher.chat.choose_project")} />
      <CommandEmpty>{t("content_search.no_results")}</CommandEmpty>
      <CommandList className="max-h-64 overflow-y-auto">
        {matches.map(project => <CommandItem key={project.id} value={project.id} onClick={() => onSelect(project.id)}>
          {project.displayName || project.name}
        </CommandItem>)}
      </CommandList>
    </Command>
  </div>;
}
