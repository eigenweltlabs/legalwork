import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  const [mode, setMode] = useState<"default" | "selected">("default");
  const [folder, setFolder] = useState("");
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const defaults = useQuery({
    queryKey: ["project-defaults"],
    queryFn: () => props.client!.getProjectDefaults(),
    enabled: props.open && Boolean(props.client),
  });
  useEffect(() => {
    if (props.open) {
      setName("");
      setMode("default");
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
        className="sm:max-w-lg"
        showCloseButton={!props.submitting}
      >
        <DialogHeader>
          <DialogTitle>{t("projects.create")}</DialogTitle>
          <DialogDescription>
            {t("projects.create_description")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void props.onConfirm({
              name: name.trim(),
              folderMode: mode,
              ...(mode === "selected" ? { folderPath: folder.trim() } : {}),
            });
          }}
        >
          <label className="grid gap-2 text-sm">
            {t("projects.name")}
            <Input
              autoFocus
              required
              maxLength={120}
              value={name}
              disabled={props.submitting}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <fieldset disabled={props.submitting} className="space-y-3">
            <legend className="mb-2 text-sm font-medium">
              {t("projects.location")}
            </legend>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4">
              <input
                type="radio"
                name="storage"
                className="mt-1 accent-primary"
                checked={mode === "default"}
                onChange={() => setMode("default")}
              />
              <span className="grid min-w-0 gap-1 text-sm">
                <span className="font-medium">
                  {t("projects.default_folder")}
                </span>
                <span className="break-all text-xs text-muted-foreground">
                  {defaults.data?.folderPath ?? t("projects.loading")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("projects.default_hint")}
                </span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4">
              <input
                type="radio"
                name="storage"
                className="mt-1 accent-primary"
                checked={mode === "selected"}
                onChange={() => setMode("selected")}
              />
              <span className="grid gap-1 text-sm">
                <span className="font-medium">
                  {t("projects.selected_folder")}
                </span>
                <span className="text-xs text-muted-foreground">
                  {t("projects.selected_hint")}
                </span>
              </span>
            </label>
            {mode === "selected" ? (
              <div className="flex gap-2">
                <Input
                  required
                  aria-label={t("projects.location")}
                  value={folder}
                  onChange={(event) => setFolder(event.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={picking}
                  onClick={() => void pick()}
                >
                  <FolderOpen className="size-4" />
                  {t("projects.browse")}
                </Button>
              </div>
            ) : null}
          </fieldset>
          {props.error || pickError || defaults.error ? (
            <p role="alert" className="text-sm text-destructive">
              {props.error || pickError || t("projects.failed")}
            </p>
          ) : null}
          <DialogFooter>
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
                props.submitting ||
                !name.trim() ||
                (mode === "selected" && !folder.trim()) ||
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
