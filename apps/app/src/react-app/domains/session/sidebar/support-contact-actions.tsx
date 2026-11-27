import { useState } from "react";
import { Spinner } from "@legalwork/ui/react";
import type { SupportContact } from "@legalwork/types/desktop-ipc";
import { CalendarDays, Mail, Phone } from "lucide-react";
import { toast } from "sonner";
import { openDesktopUrl, openSupportPhone } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { t } from "@/i18n";

const SUPPORT_EMAIL = "chris@eigenweltlabs.com";

export function SupportContactActions({ authenticated, contact, loading, unavailable }: {
  authenticated: boolean;
  contact: SupportContact | null;
  loading: boolean;
  unavailable: boolean;
}) {
  const [expandedPhone, setExpandedPhone] = useState<string | null>(null);
  const person = authenticated && !unavailable && contact && Date.parse(contact.endsAt) > Date.now() ? contact : null;
  const urgentHeading = person ? t("support.on_call", { name: person.name }) : t("support.urgent");
  const email = person?.email ?? SUPPORT_EMAIL;
  const openContact = (action: () => Promise<void>) => { void action().catch(() => toast.error(t("support.open_failed"))); };

  return (
    <Collapsible render={<section />} data-support-phone
      open={Boolean(person && person.phone === expandedPhone)}
      onOpenChange={open => setExpandedPhone(open && person ? person.phone : null)}
      className="grid grid-rows-[1.25rem_2rem] gap-2 border-t border-border/70 pt-3" aria-label={urgentHeading}>
      <h3 className="min-w-0 truncate text-sm font-medium" title={urgentHeading}>{urgentHeading}</h3>
      <div className={person || loading ? "grid grid-cols-3 gap-1.5" : "grid"}>
        {authenticated && <Button size="sm" variant="outline" className="px-2" title={email}
          onClick={() => openContact(() => openDesktopUrl(`mailto:${email}`))}>
          <Mail className="size-3.5" />{t("support.email")}
        </Button>}
        {loading ? (
          <div className="col-span-2 col-start-2 flex h-8 items-center justify-center text-muted-foreground">
            <Spinner size="sm" label={t("support.loading")} />
          </div>
        ) : person && <>
          <CollapsibleTrigger render={<Button size="sm" variant="outline" className="px-2" />}>
            <Phone className="size-3.5" />{t("support.phone")}
          </CollapsibleTrigger>
          <Button size="sm" variant="outline" className="px-2" onClick={() => openContact(() => openDesktopUrl(person.calendarUrl))}>
            <CalendarDays className="size-3.5" />{t("support.calendar")}
          </Button>
        </>}
      </div>
      {person && <CollapsibleContent className="flex h-10 items-center justify-between gap-2 rounded-lg border border-border/70 bg-muted/30 px-2">
        <span dir="ltr" className="select-text text-sm font-medium tabular-nums">{person.phone}</span>
        <Button size="xs" onClick={() => openContact(() => openSupportPhone(person.phone))}>
          {t("support.call")}
        </Button>
      </CollapsibleContent>}
    </Collapsible>
  );
}
