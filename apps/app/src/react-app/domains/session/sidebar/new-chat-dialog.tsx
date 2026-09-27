import { useState } from "react";
import { ArrowRight, Plus } from "lucide-react";
import type { WorkspaceSessionGroup } from "@/app/types";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { t } from "@/i18n";
import { WorkspaceIcon } from "../../../design-system/workspace-icon";
import { workspaceLabel } from "./utils";

export function NewChatDialog(props: {
  groups: WorkspaceSessionGroup[];
  disabled: boolean;
  onClose: () => void;
  onSelectProject: (workspaceId: string) => void;
  onCreateProject: () => void;
}) {
  const [query, setQuery] = useState("");
  const search = query.trim().normalize("NFC").toLocaleLowerCase();
  const projects = props.groups.filter(({ workspace }) => workspaceLabel(workspace).normalize("NFC").toLocaleLowerCase().includes(search));

  return <Dialog open onOpenChange={open => { if (!open) props.onClose(); }}>
    <DialogContent className="flex max-h-[80vh] flex-col gap-4 sm:max-w-lg">
      <DialogHeader className="pr-8">
        <DialogTitle>{t("projects.new_chat")}</DialogTitle>
        <DialogDescription>{t("projects.new_chat_select_project")}</DialogDescription>
      </DialogHeader>
      <Command items={projects} filter={null} value={query} onValueChange={setQuery}>
        <div className="rounded-xl border bg-background">
          <CommandInput className="h-11 w-full" aria-label={t("projects.new_chat_search")} placeholder={t("projects.new_chat_search")} />
        </div>
        <div className="mt-2 min-h-0 overflow-y-auto">
          <CommandEmpty>{t("sidebar.no_projects")}</CommandEmpty>
          <CommandList className="max-h-64 p-0">
            {projects.map(({ workspace }) => <CommandItem
              key={workspace.id}
              value={workspace.id}
              disabled={props.disabled}
              className="group gap-3 rounded-xl px-3 py-3"
              onClick={() => { props.onClose(); props.onSelectProject(workspace.id); }}
            >
              <WorkspaceIcon workspaceId={workspace.id} sizeClass="size-5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{workspaceLabel(workspace)}</span>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground opacity-0 group-data-highlighted:opacity-100" />
            </CommandItem>)}
          </CommandList>
        </div>
      </Command>
      <DialogFooter className="sm:justify-start">
        <Button variant="ghost" className="gap-2" onClick={() => { props.onClose(); props.onCreateProject(); }}>
          <Plus className="size-4" />{t("projects.create")}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
