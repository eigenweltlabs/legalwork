import { useRef, useState, type ChangeEvent } from "react";
import { Check, FlaskConical, GripVertical, Inbox, Loader2, Mic, PenLine, Upload, Workflow, X } from "lucide-react";
import { LazyMotion, Reorder, domMax, useDragControls } from "motion/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import legalworkMarkDark from "@/assets/legalwork-mark-dark.svg";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { DEFAULT_SHELL_CONFIG, useShellConfig, type ShellNavKey } from "../../../shell/shell-config";
import { readSidebarBrandLogo } from "../../../shell/sidebar-branding";

const NAV_ITEMS = {
  navNewChat: { label: "projects.new_chat", icon: PenLine },
  navTasks: { label: "sidebar.tasks", icon: Inbox },
  navWorkflows: { label: "sidebar.workflows", icon: Workflow },
  navRecorder: { label: "recorder.nav_label", icon: Mic },
  navEvaluations: { label: "sidebar.evals", icon: FlaskConical },
};

export function SidebarCustomization({ onDone }: { onDone: () => void }) {
  const { config, update } = useShellConfig();
  const move = (key: ShellNavKey, direction: number) => {
    const navOrder = [...config.navOrder];
    const index = navOrder.indexOf(key);
    const target = index + direction;
    if (target < 0 || target >= navOrder.length) return;
    navOrder.splice(index, 1);
    navOrder.splice(target, 0, key);
    update({ navOrder });
  };

  return (
    <section aria-label={t("projects.customize_nav")} className="w-full rounded-xl border border-border bg-background p-2 shadow-sm" onKeyDown={(event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDone();
      }
    }}>
        <div className="flex items-center justify-between px-2 pb-1">
          <h2 className="text-sm font-normal text-muted-foreground">{t("projects.customize")}</h2>
          <Button autoFocus variant="ghost" size="sm" className="h-8 px-2 font-normal text-blue-11 hover:text-blue-12" onClick={onDone}>{t("projects.customize_done")}</Button>
        </div>
        <LazyMotion features={domMax}>
          <Reorder.Group axis="y" values={config.navOrder} onReorder={(navOrder) => update({ navOrder })} className="space-y-0.5" aria-label={t("projects.customize_nav")}>
            {config.navOrder.map((key) => (
              <NavigationOption key={key} navKey={key} checked={config[key]} onCheckedChange={(checked) => update({ [key]: checked })} onMove={(direction) => move(key, direction)} />
            ))}
          </Reorder.Group>
        </LazyMotion>
    </section>
  );
}

export function SidebarBrandEditor() {
  const { config, update } = useShellConfig();
  const logoInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const uploadLogo = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setUploading(true);
    try {
      update({ sidebarBrandLogoDataUrl: await readSidebarBrandLogo(file) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("settings.customization.logo_error_load"));
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <div className="group/brand-logo relative size-8 shrink-0">
        <Button variant="ghost" size="icon" className="size-8 overflow-hidden rounded-md p-0" disabled={uploading} aria-label={t("settings.customization.upload_logo")} title={t("settings.customization.upload_logo")} onClick={() => logoInput.current?.click()}>
          <img src={config.sidebarBrandLogoDataUrl || legalworkMarkDark} alt="" className="size-8 object-contain" />
          <span className={cn("absolute inset-0 flex items-center justify-center bg-background/85 transition-opacity group-hover/brand-logo:opacity-100 group-focus-within/brand-logo:opacity-100", !uploading && "opacity-0")}>
            {uploading ? <Loader2 className="size-3.5 animate-spin" /> : <Upload className="size-3.5" />}
          </span>
        </Button>
        {config.sidebarBrandLogoDataUrl ? <Button variant="outline" size="icon-xs" className="absolute -right-1 -top-1 size-3.5 rounded-full opacity-0 group-hover/brand-logo:opacity-100 group-focus-within/brand-logo:opacity-100" disabled={uploading} aria-label={t("settings.customization.use_default")} title={t("settings.customization.use_default")} onClick={() => update({ sidebarBrandLogoDataUrl: "" })}><X className="size-2.5" /></Button> : null}
        <input ref={logoInput} type="file" accept="image/*" className="hidden" onChange={uploadLogo} />
      </div>
      <Input aria-label={t("settings.customization.sidebar_name_label")} className="h-8 min-w-0 flex-1 rounded-md px-1.5 text-[15px] font-semibold tracking-[-0.02em] md:text-[15px]" value={config.sidebarBrandName} placeholder={DEFAULT_SHELL_CONFIG.sidebarBrandName} onChange={(event) => update({ sidebarBrandName: event.currentTarget.value })} />
    </>
  );
}

function NavigationOption(props: {
  navKey: ShellNavKey;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  onMove: (direction: number) => void;
}) {
  const dragControls = useDragControls();
  const { icon: Icon, label: labelKey } = NAV_ITEMS[props.navKey];
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
      <Button variant="ghost" size="icon-xs" className="touch-none cursor-grab text-muted-foreground/50 hover:text-muted-foreground active:cursor-grabbing" aria-label={t("projects.reorder_nav", { name: label })} title={t("projects.reorder_nav_hint")}
        onPointerDown={(event) => dragControls.start(event)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          props.onMove(event.key === "ArrowUp" ? -1 : 1);
        }}
      ><GripVertical className="size-3.5" /></Button>
    </Reorder.Item>
  );
}
