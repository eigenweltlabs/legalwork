import { useRef, useState, type ChangeEvent } from "react";
import { CalendarDays, House, FolderOpen, LayoutGrid, Pin, Clock, TableProperties, ListTodo, Files, MessageSquare, Check, FlaskConical, GripVertical, Inbox, Loader2, Mic, PenLine, Upload, Workflow, X } from "lucide-react";
import { LazyMotion, Reorder, domMax, useDragControls } from "motion/react";
import { toast } from "@/components/ui/sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import legalworkMarkDark from "@/assets/legalwork-mark-dark.svg";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { DEFAULT_SHELL_CONFIG, useShellConfig, type ShellNavKey, type ChatSectionKey, type ProjectNavKey } from "../../../shell/shell-config";
import { readSidebarBrandLogo } from "../../../shell/sidebar-branding";
import { changeOrgPolicySetting, useOrgPolicy } from "../../connections/org-policy";

export const SIDEBAR_ITEMS = {
  navHome: { label: "home.nav_label", icon: House },
  navScheduled: { label: "scheduled.title", icon: Clock },
  navCalendar: { label: "calendar.title", icon: CalendarDays },
  navProjects: { label: "projects.plural", icon: LayoutGrid },
  sectionPinned: { label: "sidebar.pinned_sessions", icon: Pin },
  sectionPinnedProjects: { label: "sidebar.pinned_projects", icon: FolderOpen },
  sectionProjects: { label: "projects.plural", icon: FolderOpen },
  sectionRecent: { label: "sidebar.recent_sessions", icon: Clock },
  projectCalendar: { label: "calendar.title", icon: CalendarDays },
  projectHome: { label: "projects.home", icon: House },
  projectReviews: { label: "projects.tab_review", icon: TableProperties },
  projectTasks: { label: "projects.tasks", icon: ListTodo },
  projectFiles: { label: "projects.files", icon: Files },
  projectSessions: { label: "sidebar.collapse_sessions", icon: MessageSquare },
  navNewChat: { label: "projects.new_chat", icon: PenLine },
  navTasks: { label: "sidebar.tasks", icon: Inbox },
  navWorkflows: { label: "sidebar.workflows", icon: Workflow },
  navRecorder: { label: "recorder.nav_label", icon: Mic },
  navEvaluations: { label: "sidebar.evals", icon: FlaskConical },
};

export function SidebarCustomization({ onDone }: { onDone: () => void }) {
  const { config, update } = useShellConfig();
  const options = <K extends ShellNavKey | ChatSectionKey | ProjectNavKey>(keys: K[], change: (keys: K[]) => void, label: string) => (
    <div className="mt-3">
      <h3 className="px-2 pb-1 text-xs text-muted-foreground">{label}</h3>
      <Reorder.Group axis="y" values={keys} onReorder={change} aria-label={label}>
        {keys.map(key => <NavigationOption key={key} navKey={key} checked={key === "projectSessions" ? config.collapseProjectSessions : config[key]} onCheckedChange={checked => update(key === "projectSessions" ? { collapseProjectSessions: checked } : { [key]: checked })} onMove={direction => {
          const next = [...keys], index = next.indexOf(key), target = index + direction;
          if (target < 0 || target >= next.length) return;
          next.splice(index, 1); next.splice(target, 0, key); change(next);
        }} />)}
      </Reorder.Group>
    </div>
  );

  return (
    <section aria-label={t("projects.customize_nav")} className="flex min-h-0 w-full flex-1 flex-col p-2 mac:titlebar-no-drag" onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDone();
      }
    }}>
      <div className="lw-sidebar-brand flex shrink-0 items-center gap-2.5 px-3 pb-3 pt-2">
        <SidebarBrandEditor onDone={onDone} />
      </div>
      <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-background p-2 shadow-sm">
        <div className="flex shrink-0 items-center justify-between px-2 pb-1">
          <h2 className="text-sm font-normal text-muted-foreground">{t("projects.customize")}</h2>
          <Button autoFocus variant="ghost" size="sm" className="h-8 px-2 font-normal text-blue-11 hover:text-blue-12" onClick={onDone}>{t("projects.customize_done")}</Button>
        </div>
        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
        <LazyMotion features={domMax}>
          {options(config.navOrder, navOrder => update({ navOrder }), t("sidebar.main_actions"))}
          {options(config.chatSectionOrder, chatSectionOrder => update({ chatSectionOrder }), t("sidebar.chat_sections"))}
          {options(config.projectNavOrder, projectNavOrder => update({ projectNavOrder }), t("sidebar.project_items"))}
        </LazyMotion>
        </div>
      </div>
    </section>
  );
}

function SidebarBrandEditor({ onDone }: { onDone: () => void }) {
  const { config, update } = useShellConfig();
  const logoInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  // The firm's branding: locked while it enforces it; otherwise a change takes it back first.
  const locked = useOrgPolicy("branding")?.locked === true;
  const lockedText = locked ? t("org_policy.set_branding") : undefined;
  const updateBranding = (patch: Parameters<typeof update>[0]) => changeOrgPolicySetting("branding", () => update(patch));

  const uploadLogo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setUploading(true);
    try {
      const logo = await readSidebarBrandLogo(file);
      await updateBranding({ sidebarBrandLogoDataUrl: logo });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings.customization.logo_error_load"));
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <div className="group/brand-logo relative size-8 shrink-0">
        <Button variant="ghost" size="icon" className="size-8 overflow-hidden rounded-md p-0" disabled={uploading || locked} aria-label={t("settings.customization.upload_logo")} title={lockedText ?? t("settings.customization.upload_logo")} onClick={() => logoInput.current?.click()}>
          <img src={config.sidebarBrandLogoDataUrl || legalworkMarkDark} alt="" className="size-8 object-contain" />
          <span className={cn("absolute inset-0 flex items-center justify-center bg-background/85 transition-opacity group-hover/brand-logo:opacity-100 group-focus-within/brand-logo:opacity-100", !uploading && "opacity-0", locked && "hidden")}>
            {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
          </span>
        </Button>
        {config.sidebarBrandLogoDataUrl && !locked ? <Button variant="outline" size="icon-xs" className="absolute -right-1 -top-1 size-3.5 rounded-full opacity-0 group-hover/brand-logo:opacity-100 group-focus-within/brand-logo:opacity-100" disabled={uploading} aria-label={t("settings.customization.use_default")} title={t("settings.customization.use_default")} onClick={() => void updateBranding({ sidebarBrandLogoDataUrl: "" })}><X className="size-2.5" /></Button> : null}
        <input ref={logoInput} type="file" accept="image/*" className="hidden" onChange={uploadLogo} />
      </div>
      <Input aria-label={t("settings.customization.sidebar_name_label")} title={lockedText} disabled={locked} className="h-8 min-w-0 flex-1 rounded-md px-1.5 text-[15px] font-semibold tracking-[-0.02em] md:text-[15px]" value={config.sidebarBrandName} placeholder={DEFAULT_SHELL_CONFIG.sidebarBrandName} onChange={(event) => void updateBranding({ sidebarBrandName: event.currentTarget.value })} onKeyDown={(event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        onDone();
      }} />
    </>
  );
}

function NavigationOption(props: {
  navKey: ShellNavKey | ChatSectionKey | ProjectNavKey;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  onMove?: (direction: number) => void;
}) {
  const dragControls = useDragControls();
  const { icon: Icon, label: labelKey } = SIDEBAR_ITEMS[props.navKey];
  const label = t(labelKey);

  return (
    <Reorder.Item value={props.navKey} dragListener={false} dragControls={dragControls} dragElastic={0} className="relative flex h-10 items-center gap-1 rounded-lg bg-background pr-1" whileDrag={{ boxShadow: "0 3px 12px rgb(0 0 0 / 0.12)" }}>
      <Button variant="ghost" role="checkbox" aria-checked={props.checked} onClick={() => props.onCheckedChange(!props.checked)} className="h-10 min-w-0 flex-1 justify-start gap-2.5 px-2 font-normal text-foreground">
        <span aria-hidden="true" className={cn("flex size-4 shrink-0 items-center justify-center rounded-full border", props.checked ? "border-blue-9 bg-blue-9 text-white" : "border-muted-foreground/60 bg-transparent")}>
          {props.checked ? <Check className="size-3" strokeWidth={3} /> : null}
        </span>
        <Icon className="size-[18px] shrink-0" strokeWidth={1.5} />
        <span className="truncate">{label}</span>
      </Button>
      {props.onMove ? <Button variant="ghost" size="icon-xs" className="touch-none cursor-grab text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing" aria-label={t("projects.reorder_nav", { name: label })} title={t("projects.reorder_nav_hint")}
        onPointerDown={(event) => dragControls.start(event)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          props.onMove?.(event.key === "ArrowUp" ? -1 : 1);
        }}
      ><GripVertical className="size-3.5" /></Button> : null}
    </Reorder.Item>
  );
}
