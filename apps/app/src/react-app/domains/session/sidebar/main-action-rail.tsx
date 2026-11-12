import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { BriefcaseBusiness, Settings } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import type { AssistantProfile } from "@legalwork/types/main-assistant";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { useOrgPolicyForbids } from "@/react-app/domains/connections/org-policy";
import { useShellConfig, type ShellNavKey, type ShellWindowNavKey } from "../../../shell/shell-config";
import { AssistantAvatar } from "./assistant-appearance";
import { SIDEBAR_ITEMS } from "./sidebar-customization";
import { useControlAction, type LegalworkControlAction } from "../../../shell/control/control-provider";

const RAIL_BUTTON_CLASS = "relative size-9 cursor-pointer rounded-lg text-muted-foreground hover:bg-foreground/10 hover:text-foreground active:bg-foreground/15";
const RAIL_BUTTON_ACTIVE_CLASS = "bg-sidebar-accent text-foreground";

type MainRailAction = {
  onClick: () => void;
  active?: boolean;
  available?: boolean;
  disabled?: boolean;
};

export type MainRailActions = Record<ShellWindowNavKey, MainRailAction> & {
  navAssistant?: MainRailAction & { profile?: AssistantProfile; unread?: boolean };
};

export function MainActionRail({ actions, onOpenWindow, onOpenSettings, settingsActive = false, unreadTasks = 0, children }: {
  actions: MainRailActions;
  onOpenWindow?: (key: ShellWindowNavKey) => void;
  onOpenSettings?: () => void;
  settingsActive?: boolean;
  unreadTasks?: number;
  children: ReactNode;
}) {
  const { config } = useShellConfig();
  const navigate = useNavigate();
  const location = useLocation();
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
  return (
    <nav aria-label={t("sidebar.main_actions")} className="flex w-[var(--lw-window-left-rail-width)] shrink-0 flex-col items-center gap-1.5 px-1 py-2 mac:titlebar-no-drag">
      {config.navOrder.map(key => {
        const action = actions[key];
        if (!action || !config[key] || action.available === false || firmOff[key]) return null;
        const Icon = key === "navAssistant" ? null : SIDEBAR_ITEMS[key].icon;
        const assistant = key === "navAssistant" ? actions.navAssistant : undefined;
        const label = assistant?.profile?.name ?? t(SIDEBAR_ITEMS[key].label);
        return (
          <Tooltip key={key}>
            <TooltipTrigger render={<Button variant="ghost" size="icon"
              className={cn(RAIL_BUTTON_CLASS, action.active && RAIL_BUTTON_ACTIVE_CLASS)}
              aria-label={label} aria-pressed={assistant ? undefined : Boolean(action.active)} aria-current={assistant?.active ? "page" : undefined}
              disabled={action.disabled} onClick={action.onClick} onDoubleClick={key === "navAssistant" ? undefined : () => onOpenWindow?.(key)} />}>
              {Icon ? <Icon className="size-[18px]" strokeWidth={1.6} /> : <AssistantAvatar icon={assistant?.profile?.icon} />}
              {assistant?.unread && <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-green-9" role="img" aria-label={t("assistant.unread_activity")} title={t("assistant.unread_activity")} />}
              {key === "navTasks" && unreadTasks > 0 && !action.active && <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary" />}
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={10}>{label}</TooltipContent>
          </Tooltip>
        );
      })}
      <Tooltip><TooltipTrigger render={<Button variant="ghost" size="icon" className={cn("relative size-9 cursor-pointer rounded-lg text-muted-foreground hover:bg-foreground/10 hover:text-foreground", location.pathname.startsWith("/back-office") && "bg-sidebar-accent text-foreground")} aria-label="Back Office" aria-pressed={location.pathname.startsWith("/back-office")} onClick={() => navigate("/back-office/matters")} />}><BriefcaseBusiness className="size-[18px]" strokeWidth={1.6} /></TooltipTrigger><TooltipContent side="right" sideOffset={10}>Back Office</TooltipContent></Tooltip>
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
