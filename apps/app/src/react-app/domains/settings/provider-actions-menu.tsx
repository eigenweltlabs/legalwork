import type { ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";

export function ProviderActionsMenu({ name, disabled, children }: {
  name: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={
        <Button variant="ghost" size="icon-sm" disabled={disabled} aria-label={t("settings.provider_actions", { name })} />
      }>
        <MoreHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}
