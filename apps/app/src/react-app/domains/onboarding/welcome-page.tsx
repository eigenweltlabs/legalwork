/** @jsxImportSource react */
import { useId, useState } from "react";
import { FolderOpen, FolderPlus, Loader2, X } from "lucide-react";

import { t } from "@/i18n";
import { Page, PageTitlebarRegion } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { folderNameFromPath } from "@/react-app/shell/route-workspaces";
import type { CreateProjectInput } from "../workspace/create-project-modal";
import { StepDots } from "./onboarding-cover";

export type ProjectCreatePhase = "project" | "engine";

type WelcomePageProps = {
  onCreateProject: (input: CreateProjectInput) => Promise<void>;
  /** Native folder selection on desktop; a path field on the web. */
  onPickFolder?: () => Promise<string | null>;
  busy?: boolean;
  busyPhase?: ProjectCreatePhase | null;
  error?: string | null;
  totalSteps: number;
  analyticsEnabled: boolean;
  onAnalyticsChange: (enabled: boolean) => void;
};

export function WelcomePage(props: WelcomePageProps) {
  const id = useId();
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [showFolder, setShowFolder] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const disabled = Boolean(props.busy || picking);
  const error = pickError || props.error;
  const pickFolder = async () => {
    setPickError(null);
    if (!props.onPickFolder) {
      setShowFolder(true);
      return;
    }
    setPicking(true);
    try {
      const path = await props.onPickFolder();
      if (path) { setFolder(path); setShowFolder(true); }
    } catch {
      setPickError(t("welcome.project_pick_failed"));
    } finally {
      setPicking(false);
    }
  };

  return (
    <Page className="fixed inset-0 z-40 h-dvh overflow-y-auto bg-background" data-testid="project-onboarding">
      <PageTitlebarRegion />
      <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-6 pb-6 pt-12 sm:pb-8">
        <main className="mx-auto flex w-full max-w-[400px] flex-1 items-center py-12">
          <div className="w-full">
            <div aria-label={t("welcome.project_step", { total: String(props.totalSteps) })}>
              <StepDots step={1} total={props.totalSteps} />
            </div>
            <h1 className="text-[32px] font-medium leading-[1.15] tracking-[-0.04em]">{t("welcome.project_title")}</h1>
            <form className="mt-8 space-y-6" aria-busy={props.busy} onSubmit={(event) => {
              event.preventDefault();
              if (disabled || !name.trim()) return;
              setPickError(null);
              void props.onCreateProject({
                name: name.trim(),
                folderMode: folder.trim() ? "selected" : "default",
                ...(folder.trim() ? { folderPath: folder.trim() } : {}),
              });
            }}>
              <div className="space-y-2">
                <label htmlFor={`${id}-name`} className="text-[13px] font-medium">{t("projects.name")}</label>
                <Input id={`${id}-name`} name="projectName" autoFocus required maxLength={120} autoComplete="off" placeholder={t("welcome.project_name_placeholder")} value={name} disabled={disabled} onChange={(event) => setName(event.target.value)} className="h-11 rounded-lg bg-background px-3 text-sm" />
              </div>
              <fieldset disabled={disabled}>
                <legend className="mb-2 text-[13px] font-medium">{t("welcome.project_folders")} <span className="ml-1 font-normal text-muted-foreground">{t("welcome.project_optional")}</span></legend>
                {showFolder ? (
                  <div className="flex min-h-11 items-center gap-2 rounded-lg border border-border px-3 py-1.5">
                    {props.onPickFolder ? <button type="button" disabled={disabled} onClick={() => void pickFolder()} title={folder} aria-label={`${t("projects.location")}: ${folder}`} className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left text-sm hover:text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"><FolderOpen className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{folderNameFromPath(folder)}</span></button> : <Input autoFocus aria-label={t("projects.location")} value={folder} disabled={disabled} onChange={(event) => setFolder(event.target.value)} placeholder={t("welcome.project_folder_placeholder")} className="min-w-0 flex-1" />}
                    <Button type="button" size="icon-xs" variant="ghost" aria-label={t("projects.remove_source")} disabled={disabled} onClick={() => { setFolder(""); setShowFolder(false); setPickError(null); }}><X /></Button>
                  </div>
                ) : (
                  <Button type="button" variant="outline" className="h-11 w-full justify-start gap-2 rounded-lg border-dashed bg-transparent px-3 font-normal text-muted-foreground" disabled={disabled} onClick={() => void pickFolder()}>{picking ? <Loader2 className="animate-spin" /> : <FolderPlus />}{t("welcome.project_add_folder")}</Button>
                )}
              </fieldset>
              {error ? <p role="alert" className="text-sm leading-relaxed text-destructive">{error}</p> : null}
              <div className="pt-2">
                <Button type="submit" size="lg" className="h-11 w-full justify-center rounded-lg" disabled={disabled || !name.trim()}>
                  {props.busy ? <><Loader2 className="animate-spin" />{t("projects.creating")}</> : t("welcome.project_create")}
                </Button>
                <p role="status" aria-live="polite" className={props.busy ? "mt-3 text-center text-xs leading-5 text-muted-foreground" : "sr-only"}>
                  {props.busy ? t(props.busyPhase === "engine" ? "welcome.project_preparing" : "welcome.project_creating") : null}
                </p>
              </div>
            </form>
          </div>
        </main>
        <footer className="flex justify-center">
          <label className="flex cursor-pointer items-start gap-3 text-xs leading-5 text-muted-foreground">
            <Switch aria-label={t("welcome.analytics_aria")} checked={props.analyticsEnabled} onCheckedChange={props.onAnalyticsChange} disabled={disabled} className="data-checked:border-transparent data-checked:bg-foreground" />
            {t("welcome.analytics_body")}
          </label>
        </footer>
      </div>
    </Page>
  );
}
