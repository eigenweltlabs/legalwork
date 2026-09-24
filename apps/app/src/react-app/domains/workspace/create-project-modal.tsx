import { useEffect, useState } from "react";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { folderNameFromPath } from "@/react-app/shell/route-workspaces";
import { Folder, FolderOpen, FolderPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";

export type CreateProjectInput = {
  name: string;
  folderMode: "default" | "selected";
  folderPath?: string;
};

export function CreateProjectModal(props: {
  open: boolean;
  client: LegalworkServerClient | null;
  submitting: boolean;
  error: string | null;
  onClose: () => void;
  onPickFolder: () => Promise<string | null>;
  onConfirm: (input: CreateProjectInput) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [showFolderInput, setShowFolderInput] = useState(false);
  const [folder, setFolder] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  useEffect(() => {
    if (props.open) {
      setName("");
      setShowFolderInput(false);
      setFolder("");
      setPickError(null);
    }
  }, [props.open]);
  const pick = async () => {
    setPicking(true);
    setPickError(null);
    try {
      const path = await props.onPickFolder();
      if (path) setFolder(path);
    } catch (error) {
      setPickError(
        error instanceof Error ? error.message : t("projects.failed"),
      );
    } finally {
      setPicking(false);
    }
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open && !props.submitting) props.onClose();
      }}
    >
      <DialogContent
        className="gap-6 rounded-3xl p-7 sm:max-w-xl sm:p-8"
        showCloseButton={!props.submitting}
      >
        <DialogHeader>
          <DialogTitle className="text-2xl font-semibold tracking-tight">{t("projects.create")}</DialogTitle>
          <DialogDescription className="sr-only">
            {t("projects.create_description")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void props.onConfirm({
              name: name.trim(),
              folderMode: folder.trim() ? "selected" : "default",
              ...(folder.trim() ? { folderPath: folder.trim() } : {}),
            });
          }}
        >
          <InputGroup className="h-12 rounded-xl bg-background">
            <InputGroupAddon className="h-full border-r border-border px-4 text-foreground"><Folder className="size-5" /></InputGroupAddon>
            <InputGroupInput autoFocus required maxLength={120} aria-label={t("projects.name")} placeholder={t("projects.name")} value={name} disabled={props.submitting} className="h-full px-4 text-base" onChange={(event) => setName(event.target.value)} />
          </InputGroup>
          <fieldset disabled={props.submitting || picking} className="space-y-3">
            <legend className="mb-3 text-sm font-medium">{t("projects.source_folders")}</legend>
            <div className="flex min-h-36 flex-col items-center justify-center gap-4 rounded-xl border border-border px-5 py-6">
              {folder && isDesktopRuntime() ? <div className="flex w-full items-center gap-3">
                <FolderOpen className="size-5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-sm">{folderNameFromPath(folder)}</span>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t("projects.remove_source")} onClick={() => setFolder("")}><X /></Button>
              </div> : <>
                <p className="text-sm text-muted-foreground">{t("projects.add_local_folder")}</p>
                {showFolderInput && !isDesktopRuntime() ? <div className="flex w-full items-center gap-2">
                  <Input aria-label={t("projects.location")} placeholder={t("projects.location")} value={folder} onChange={(event) => setFolder(event.target.value)} />
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t("projects.remove_source")} onClick={() => { setFolder(""); setShowFolderInput(false); }}><X /></Button>
                </div> : <Button type="button" variant="secondary" size="sm" className="rounded-full" onClick={() => { if (isDesktopRuntime()) void pick(); else setShowFolderInput(true); }}><FolderPlus />{t("projects.add_source")}</Button>}
              </>}
            </div>
            <p className="text-xs text-muted-foreground">{t(folder ? "projects.selected_hint" : "projects.source_default_hint")}</p>
          </fieldset>
          {props.error || pickError ? (
            <p role="alert" className="text-sm text-destructive">
              {props.error || pickError || t("projects.failed")}
            </p>
          ) : null}
          <DialogFooter className="mx-0 mb-0 mt-7 gap-3 border-0 bg-transparent p-0">
            <Button
              type="button"
              variant="ghost"
              disabled={props.submitting}
              onClick={props.onClose}
            >
              {t("projects.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={
                props.submitting || picking ||
                !name.trim() ||
                !props.client
              }
            >
              {props.submitting ? t("projects.creating") : t("projects.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
