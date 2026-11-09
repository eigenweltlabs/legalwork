import { useEffect, useRef, useState } from "react";
import { Settings2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { BackOfficeFieldSchema, type BackOfficeValue } from "@legalwork/types/back-office";
import type { ProjectField } from "@legalwork/types/workspace";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { isMacPlatform } from "@/app/utils";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import { RecordCreationProvider } from "../back-office/record-creation-context";
import { RecordCreateRelation } from "../back-office/record-create-relation";
import { ObjectIcon } from "../back-office/object-icon";
import { projectReferenceObjects, useProjectBackOffice } from "./project-record-field";
import { clientsFromProjectMatters, primaryProjectObjects, projectConnectionField, withProjectField } from "./project-connections";
import { ProjectMoreFields } from "./project-more-fields";
import { ProjectFieldDialog } from "./project-field-dialog";
import { rememberMatter } from "./matter-picker-options";
import { projectErrorMessage } from "./project-errors";

export function ProjectReferenceActions({ client, fields, onSave, onCustomize }: {
  client: LegalworkServerClient; fields: ProjectField[]; onSave: (fields: ProjectField[]) => Promise<void>; onCustomize?: () => void;
}) {
  const directory = useProjectBackOffice(client), data = directory.data, navigate = useNavigate();
  const [active, setActive] = useState<string | null>(null), [value, setValue] = useState<BackOfficeValue>([]);
  const [busy, setBusy] = useState(false), [creating, setCreating] = useState(false), [error, setError] = useState("");
  const saving = useRef(false);
  const [extra, setExtra] = useState<ProjectField | null | undefined>();
  const scope = JSON.stringify([client.baseUrl, data?.directoryId, data?.permissions.userId, data?.permissions.principalKey, data?.permissions.replicaId]);
  useEffect(() => { setActive(null); setExtra(undefined); setError(""); }, [scope]);
  const allObjects = projectReferenceObjects(data);
  const objects = allObjects.filter(object => primaryProjectObjects.includes(object.id));
  const inherited = clientsFromProjectMatters(fields, data?.directoryId, data?.records ?? []);
  const selected = Array.isArray(value) ? value.filter(item => typeof item === "string") : typeof value === "string" ? [value] : [];
  const save = async (field: Extract<ProjectField, { type: "backoffice" }>) => {
    if (!data?.directoryId || saving.current || creating || !selected.length) return;
    saving.current = true; setBusy(true); setError("");
    const next = { ...field, value: { directoryId: data.directoryId, recordIds: selected } };
    try {
      await onSave(withProjectField(fields, next));
      if (field.objectId === "matters") selected.forEach(id => rememberMatter(scope, id));
      setActive(null);
    } catch (error) { setError(projectErrorMessage(error)); }
    finally { saving.current = false; setBusy(false); }
  };
  return <RecordCreationProvider client={client} state={data}>
    {inherited.length > 0 && <div className="mt-3 space-y-1 border-t border-border/60 pt-3">
      <p className="text-xs text-muted-foreground">{t("projects.connections.inherited_clients")}</p>
      {inherited.map(({ client, matters }) => <div key={client.id} className="flex flex-wrap items-center gap-x-2 text-xs">
        <Button variant="ghost" size="sm" className="h-auto gap-1.5 px-0 py-1 text-xs" onClick={() => navigate(`/back-office/clients?record=${client.id}`)}><ObjectIcon id="clients" size={13} />{String(client.values.name)}</Button>
        <span className="text-muted-foreground">{t("projects.connections.via", { matters: matters.map(matter => String(matter.values.name)).join(", ") })}</span>
      </div>)}
    </div>}
    <div className="mt-3 flex flex-wrap gap-2" aria-label={t("projects.connections.add")}>
      {objects.map(object => {
        const field = projectConnectionField(fields, object.id, object.plural);
        return <Popover key={object.id} open={active === object.id} onOpenChange={open => {
          if (saving.current) return;
          setActive(open ? object.id : null); setError("");
          if (open) setValue(field.value?.directoryId === data?.directoryId ? field.value?.recordIds ?? [] : []);
        }}>
          <PopoverTrigger render={<Button type="button" variant="outline" size="sm" className="text-xs" disabled={busy || !data?.directoryId} />}>
            <ObjectIcon id={object.id} size={14} />{t("projects.connections.add_record", { name: object.label })}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(400px,calc(100vw-32px))] max-h-[70vh] overflow-y-auto p-2">
            {active === object.id && <RecordCreateRelation inline field={BackOfficeFieldSchema.parse({ id: field.id, label: object.plural, type: "relation", target: object.id, multiple: field.multiple })}
              creationFilters={field.filters} value={value} disabled={busy} onChange={setValue} onCreatingChange={setCreating} onSubmit={() => void save(field)} />}
            {error && <p role="alert" className="p-2 text-xs text-destructive">{error}</p>}
            {!creating && <div className="mt-2 flex items-center justify-end gap-2 border-t pt-2">
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setActive(null)}>{t("projects.cancel")}</Button>
              <Button type="button" size="sm" disabled={busy || !selected.length} onClick={() => void save(field)}>{t("projects.connections.link")}<kbd className="ml-2 text-xs opacity-70">{isMacPlatform() ? "⌘↵" : "Ctrl+↵"}</kbd></Button>
            </div>}
          </PopoverContent>
        </Popover>;
      })}
      <ProjectMoreFields fields={fields} objects={allObjects} primaryIds={objects.map(object => projectConnectionField(fields, object.id, object.plural).id)} disabled={busy}
        onChoose={setExtra} onNew={() => setExtra(null)} />
      {onCustomize && <Button type="button" size="sm" variant="ghost" className="text-xs text-muted-foreground" disabled={busy} onClick={onCustomize}><Settings2 className="size-3.5" />{t("projects.customize_connections")}</Button>}
      {directory.error && <p role="alert" className="text-xs text-destructive">{t("projects.connections.unavailable")}</p>}
    </div>
    {extra !== undefined && <ProjectFieldDialog key={extra?.id ?? "new"} client={client} field={extra ?? undefined} onClose={() => setExtra(undefined)} onSave={field => onSave(withProjectField(fields, field))} />}
  </RecordCreationProvider>;
}
