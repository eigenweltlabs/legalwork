import { Spinner } from "@legalwork/ui/react";
import type { SupportContact } from "@legalwork/types/desktop-ipc";
import { CalendarDays, Mail, Phone } from "lucide-react";
import { toast } from "sonner";
import { openDesktopUrl, openSupportPhone } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

const SUPPORT_EMAIL = "chris@eigenweltlabs.com";

export function SupportContactActions({ contact, loading, unavailable }: {
  contact: SupportContact | null;
  loading: boolean;
  unavailable: boolean;
}) {
  const person = !unavailable && contact && Date.parse(contact.endsAt) > Date.now() ? contact : null;
  const urgentHeading = person ? t("support.on_call", { name: person.name }) : t("support.urgent");
  const email = person?.email ?? SUPPORT_EMAIL;
  const openContact = (action: () => Promise<void>) => { void action().catch(() => toast.error(t("support.open_failed"))); };

  return (
    <section className="grid gap-2 border-t border-border/70 pt-3" aria-label={urgentHeading}>
      <h3 className="min-w-0 truncate text-sm font-medium" title={urgentHeading}>{urgentHeading}</h3>
      {loading ? (
        <div className="flex h-8 items-center justify-center text-muted-foreground">
          <Spinner size="sm" label={t("support.loading")} />
        </div>
      ) : <div className={person ? "grid grid-cols-3 gap-1.5" : "grid"}>
        {person && <Button size="sm" variant="outline" onClick={() => openContact(() => openSupportPhone(person.phone))}>
          <Phone className="size-3.5" />{t("support.phone")}
        </Button>}
        <Button size="sm" variant="outline" title={email} onClick={() => openContact(() => openDesktopUrl(`mailto:${email}`))}>
          <Mail className="size-3.5" />{t("support.email")}
        </Button>
        {person && <Button size="sm" variant="outline" onClick={() => openContact(() => openDesktopUrl(person.calendarUrl))}>
          <CalendarDays className="size-3.5" />{t("support.calendar")}
        </Button>}
      </div>}
    </section>
  );
}
