import { useNavigate } from "react-router-dom";
import type { ProjectField } from "@legalwork/types/workspace";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { ObjectIcon } from "../back-office/object-icon";
import { clientsFromProjectMatters } from "./project-connections";
import { useProjectBackOffice } from "./project-record-field";

export function ProjectMatterClients({ client, fields }: { client: LegalworkServerClient; fields: ProjectField[] }) {
  const { data, error } = useProjectBackOffice(client);
  const navigate = useNavigate();
  const inherited = clientsFromProjectMatters(fields, data?.directoryId, data?.records ?? []);
  if (error && fields.some(field => field.type === "backoffice")) return <p role="alert" className="mt-2 text-xs text-destructive">{t("projects.connections.unavailable")}</p>;
  if (!inherited.length) return null;
  return <div className="mt-3 space-y-1 border-t border-border/60 pt-3">
    <p className="text-xs text-muted-foreground">{t("projects.connections.inherited_clients")}</p>
    {inherited.map(({ client, matters }) => <div key={client.id} className="flex flex-wrap items-center gap-x-2 text-xs">
      <Button variant="ghost" size="sm" className="h-auto gap-1.5 px-0 py-1 text-xs" onClick={() => navigate(`/back-office/clients?record=${client.id}`)}><ObjectIcon id="clients" size={13} />{String(client.values.name)}</Button>
      <span className="text-muted-foreground">{t("projects.connections.via", { matters: matters.map(matter => String(matter.values.name)).join(", ") })}</span>
    </div>)}
  </div>;
}
