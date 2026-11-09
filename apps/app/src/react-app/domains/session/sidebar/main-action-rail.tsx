import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { Settings } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { useOrgPolicyForbids } from "@/react-app/domains/connections/org-policy";
import { useShellConfig, type ShellNavKey } from "../../../shell/shell-config";
import { SIDEBAR_ITEMS } from "./sidebar-customization";
import { useControlAction, type LegalworkControlAction } from "../../../shell/control/control-provider";

export type MainRailActions = Record<ShellNavKey, {
  onClick: () => void;
  active?: boolean;
  available?: boolean;
}>;

export function MainActionRail({ actions, onOpenWindow, onOpenSettings, settingsActive = false, unreadTasks = 0, children }: {
  actions: MainRailActions;
  onOpenWindow?: (key: ShellNavKey) => void;
  onOpenSettings?: () => void;
  settingsActive?: boolean;
  unreadTasks?: number;
  children: ReactNode;
}) {
  const { config } = useShellConfig();
  const navigate = useNavigate();
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const openSettings = useCallback(() => {
    if (onOpenSettings) onOpenSettings();
    else navigate("/settings/general");
  }, [navigate, onOpenSettings]);
  const settingsAction = useMemo<LegalworkControlAction>(() => ({
    id: "navigation.settings.open",
    label: t("status.settings"),
    description: "Open Settings using the button above the account button in the navigation rail.",
    sideEffect: "navigation",
    targetRef: settingsButtonRef,
    execute: openSettings,
  }), [openSettings]);
  useControlAction(settingsAction);
  // What the firm switched off leaves the rail.
  const firmOff: Partial<Record<ShellNavKey, boolean>> = {
    navRecorder: useOrgPolicyForbids("recorder.allow"),
    navEvaluations: useOrgPolicyForbids("evaluations.allow"),
  };
  const items = config.navOrder.filter(key => config[key] && actions[key].available !== false && !firmOff[key]);

  return (
    <nav aria-label={t("sidebar.main_actions")} className="flex w-[var(--lw-window-left-rail-width)] shrink-0 flex-col items-center gap-1.5 px-1 py-2 mac:titlebar-no-drag">
      {items.map(key => {
        const Icon = SIDEBAR_ITEMS[key].icon;
        const label = t(SIDEBAR_ITEMS[key].label);
        return (
          <Tooltip key={key}>
            <TooltipTrigger render={<Button variant="ghost" size="icon" className={cn("relative size-9 cursor-pointer rounded-lg text-muted-foreground hover:bg-foreground/10 hover:text-foreground active:bg-foreground/15", actions[key].active && "bg-sidebar-accent text-foreground")} aria-label={label} aria-pressed={Boolean(actions[key].active)} onClick={actions[key].onClick} onDoubleClick={() => onOpenWindow?.(key)} />}>
              <Icon className="size-[18px]" strokeWidth={1.6} />
              {key === "navTasks" && unreadTasks > 0 && !actions[key].active && <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary" />}
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={10}>{label}</TooltipContent>
          </Tooltip>
        );
      })}
      <div className="mt-auto flex shrink-0 flex-col items-center gap-1.5 pt-4">
        <Tooltip>
          <TooltipTrigger render={<Button ref={settingsButtonRef} variant="ghost" size="icon" className={cn("size-9 rounded-lg text-muted-foreground hover:bg-foreground/10 hover:text-foreground active:bg-foreground/15", settingsActive && "bg-sidebar-accent text-foreground")} aria-label={t("status.settings")} aria-pressed={settingsActive} onClick={openSettings} />}>
            <Settings className="size-[18px]" strokeWidth={1.6} />
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={10}>{t("status.settings")}</TooltipContent>
        </Tooltip>
        {children}
      </div>
    </nav>
  );
}
