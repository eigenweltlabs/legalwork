import { Columns2, LayoutGrid, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";
import { usePanelTabStore } from "./panel-tab-store";
import { DEFAULT_WORKSPACE_OPENING } from "./workspace-opening";

export function WorkspaceViewMenu({ scope }: { scope: string }) {
  const opening = usePanelTabStore(state => state.opening[scope] ?? DEFAULT_WORKSPACE_OPENING);
  const setOpening = usePanelTabStore(state => state.setOpening);
  return <DropdownMenu>
    <DropdownMenuTrigger render={<Button variant="ghost" size="sm"><SlidersHorizontal className="size-4" />{t("workspace.view")}</Button>} />
    <DropdownMenuContent align="end" className="w-72">
      <DropdownMenuGroup>
        <DropdownMenuLabel>{t("workspace.opening_profile")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={opening.mode} onValueChange={value => {
          if (value === "chat-content" || value === "free") setOpening(scope, { mode: value });
        }}>
          <DropdownMenuRadioItem value="chat-content"><Columns2 />{t("workspace.chat_content")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="free"><LayoutGrid />{t("workspace.free")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>{t(opening.mode === "chat-content" ? "workspace.chat_position" : "workspace.new_content")}</DropdownMenuLabel>
        {opening.mode === "chat-content" ? <DropdownMenuRadioGroup value={opening.chatSide} onValueChange={value => {
          if (value === "left" || value === "right") setOpening(scope, { chatSide: value });
        }}>
          <DropdownMenuRadioItem value="left">{t("workspace.chat_left")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="right">{t("workspace.chat_right")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup> : <DropdownMenuRadioGroup value={opening.newContent} onValueChange={value => {
          if (value === "active" || value === "beside") setOpening(scope, { newContent: value });
        }}>
          <DropdownMenuRadioItem value="active">{t("workspace.open_active")}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="beside">{t("workspace.open_beside")}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>}
      </DropdownMenuGroup>
      <p className="px-3 py-2 text-xs leading-relaxed text-muted-foreground">{t("workspace.opening_hint")}</p>
    </DropdownMenuContent>
  </DropdownMenu>;
}
