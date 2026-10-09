import { useCallback, useEffect, useRef, useState } from "react";
import { AppWindowMac, Copy, PanelsTopLeft, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { toast } from "@/components/ui/sonner";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { useShellConfig } from "../../../shell/shell-config";
import { openWorkspaceWindow } from "./workspace-window";

export function WorkspaceWindowButton({ workspaceId, openWindow = openWorkspaceWindow, showButton = true }: {
  workspaceId: string;
  openWindow?: typeof openWorkspaceWindow;
  showButton?: boolean;
}) {
  const { config, update } = useShellConfig();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"copy" | "empty">("copy");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const launching = useRef(false);
  const choose = useCallback(() => {
    setMode(config.newWindowBehavior === "empty" ? "empty" : "copy");
    setRemember(config.newWindowBehavior !== "ask");
    setOpen(true);
  }, [config.newWindowBehavior]);
  const launch = useCallback(async (mode: "copy" | "empty", saveChoice?: boolean) => {
    if (launching.current) return;
    launching.current = true;
    setBusy(true);
    try {
      await openWindow(workspaceId, undefined, mode);
      if (saveChoice !== undefined) update({ newWindowBehavior: saveChoice ? mode : "ask" });
      setOpen(false);
    } catch { toast.error(t("projects.open_in_new_window_failed")); }
    finally { launching.current = false; setBusy(false); }
  }, [workspaceId, openWindow, update]);
  const request = useCallback(() => {
    if (config.newWindowBehavior === "ask") choose();
    else void launch(config.newWindowBehavior);
  }, [config.newWindowBehavior, choose, launch]);
  useEffect(() => {
    window.addEventListener("legalwork:native-menu:open-session-window", request);
    return () => window.removeEventListener("legalwork:native-menu:open-session-window", request);
  }, [request]);
  return <>
    {showButton && <ContextMenu><ContextMenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={busy} onClick={request} title={t("workspace.open_window")} aria-label={t("workspace.open_window")}><AppWindowMac size={16} /></Button>} />
      <ContextMenuContent>
        <ContextMenuItem disabled={busy} onClick={() => void launch("empty")}><PanelsTopLeft />{t("workspace.window_empty")}</ContextMenuItem>
        <ContextMenuItem disabled={busy} onClick={() => void launch("copy")}><Copy />{t("workspace.window_copy")}</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={busy} onClick={choose}><Settings2 />{t("workspace.window_change_choice")}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>}
    <Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><DialogContent>
      <DialogHeader><DialogTitle>{t("workspace.open_window")}</DialogTitle><DialogDescription>{t("workspace.window_description")}</DialogDescription></DialogHeader>
      <RadioGroup disabled={busy} value={mode} onValueChange={value => { if (value === "empty" || value === "copy") setMode(value); }} className="gap-2 rounded-xl bg-muted/40 p-2" aria-label={t("workspace.open_window")}>
        {(["empty", "copy"] satisfies Array<typeof mode>).map(value => <label key={value} className={cn("flex cursor-pointer items-center gap-3 rounded-lg border border-transparent p-3 text-sm hover:bg-background/60", mode === value && "border-border bg-background shadow-sm")}>
          <RadioGroupItem value={value} />{value === "empty" ? <PanelsTopLeft className="size-4" /> : <Copy className="size-4" />}
          <span><span className="block font-medium">{t(value === "empty" ? "workspace.window_empty" : "workspace.window_copy")}</span><span className="block text-xs text-muted-foreground">{t(value === "empty" ? "workspace.window_empty_hint" : "workspace.window_copy_hint")}</span></span>
        </label>)}
      </RadioGroup>
      <label className="flex cursor-pointer items-center gap-2 text-sm"><Checkbox checked={remember} disabled={busy} onCheckedChange={setRemember} />{t("workspace.window_remember")}</label>
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>{t("common.cancel")}</Button><Button disabled={busy} onClick={() => void launch(mode, remember)}>{t("workspace.window_create")}</Button></DialogFooter>
    </DialogContent></Dialog>
  </>;
}
