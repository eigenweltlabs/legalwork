import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, CircleHelp, MessageCircle } from "lucide-react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { useEigenweltEntitlements } from "../../connections/eigenwelt-entitlements";
import { SupportContactActions } from "./support-contact-actions";

export function SupportMenu({ client, workspaceId, onAsk }: {
  client: LegalworkServerClient | null;
  workspaceId: string;
  onAsk: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [reserveContact, setReserveContact] = useState(false);
  const account = useEigenweltEntitlements({ client, workspaceId });
  const identity = account.data?.connected ? account.data.account : null;
  const checkingAccount = account.isLoading;
  const contact = useQuery({
    queryKey: ["support-contact", client?.baseUrl, identity?.userId, identity?.orgId],
    queryFn: async ({ signal }) => client ? (await client.supportContact(signal)).contact : null,
    enabled: Boolean(open && reserveContact && client && identity),
    gcTime: 0,
    retry: false,
    refetchInterval: (query) => {
      const endsAt = query.state.data?.endsAt;
      return endsAt ? Math.max(1000, Math.min(30_000, Date.parse(endsAt) - Date.now())) : 30_000;
    },
  });

  return (
    <Popover open={open} onOpenChange={nextOpen => {
      if (nextOpen) setReserveContact(Boolean(identity || checkingAccount));
      setOpen(nextOpen);
    }}>
      <Tooltip>
        <PopoverTrigger render={<TooltipTrigger render={
          <Button variant="ghost" size="icon" aria-label={t("support.title")}
            className="size-9 rounded-lg text-muted-foreground hover:bg-foreground/10 hover:text-foreground data-[popup-open]:bg-foreground/10 data-[popup-open]:text-foreground" />
        }><CircleHelp className="size-[18px]" strokeWidth={1.6} /></TooltipTrigger>} />
        <TooltipContent side="right" sideOffset={10}>{t("support.title")}</TooltipContent>
      </Tooltip>
      <PopoverContent side="right" align="end" sideOffset={12}
        className={cn(
          "w-80 max-w-[calc(100vw-1.5rem)] gap-3.5 data-starting-style:scale-100 data-ending-style:scale-100",
          reserveContact ? "h-60" : "h-40",
        )}>
        <PopoverHeader className="min-h-0 flex-1 overflow-y-auto">
          <PopoverTitle className="text-sm">{t("support.title")}</PopoverTitle>
          <PopoverDescription className="text-xs leading-relaxed">
            {t((identity || checkingAccount) && isDesktopRuntime() ? "support.description" : "support.description_signed_out")}
          </PopoverDescription>
        </PopoverHeader>
        <Button variant="outline"
          className="w-full justify-between rounded-lg border-foreground/35 bg-transparent font-semibold shadow-xs hover:border-foreground/55 hover:bg-foreground/5"
          onClick={() => { setOpen(false); onAsk(); }}>
          <span className="flex items-center gap-2">
            <MessageCircle aria-hidden className="size-4" />{t("support.ask")}
          </span>
          <ArrowRight aria-hidden className="size-3.5 opacity-80" />
        </Button>
        {reserveContact && <div className="h-[4.5625rem] shrink-0">
          {(identity || checkingAccount) && <SupportContactActions contact={contact.data ?? null}
            loading={checkingAccount || contact.isPending} unavailable={contact.isError} />}
        </div>}
      </PopoverContent>
    </Popover>
  );
}
