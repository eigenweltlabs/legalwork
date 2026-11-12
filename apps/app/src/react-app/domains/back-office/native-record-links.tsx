import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2 } from "lucide-react";
import { z } from "@legalwork/types/back-office";
import type { BackOfficeLinkChanges, LegalworkServerClient } from "@/app/lib/legalwork-server";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { t } from "@/i18n";
import { onSyncPoke } from "../../kernel/sync-events";
import { useProjectBackOffice } from "../workspace/project-record-field";
import { linkRecords } from "./api";
import { CellEditor } from "./cell-editor";
import { nativeModel, stringIds, type NativeKind } from "./native-model";
import { BackOfficeTheme } from "./twenty-controls";
import { RecordCreationProvider } from "./record-creation-context";

type Changes = BackOfficeLinkChanges | undefined;
type Props = {
  client: LegalworkServerClient;
  kind: NativeKind;
  sourceId?: string;
  workspace?: string;
  disabled?: boolean;
  draft?: Changes;
  onDraftChange?: Dispatch<SetStateAction<Changes>>;
};

const applyChanges = (ids: string[], changes: Pick<BackOfficeLinkChanges, "add" | "remove">) =>
  [...new Set([...ids.filter(id => !changes.remove.includes(id)), ...changes.add])];

export function NativeRecordLinks({ client, kind, sourceId, workspace = "", disabled, draft, onDraftChange }: Props) {
  const directory = useProjectBackOffice(client);
  const state = directory.data;
  const directoryId = state?.directoryId, userId = state?.permissions.userId;
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const projectKey = kind === "task" ? "" : workspace;
  const key = ["native-directory", client.baseUrl, directoryId, userId, state?.permissions.replicaId, "source", kind, projectKey, sourceId];
  const links = useQuery({
    queryKey: key, enabled: Boolean(sourceId && directoryId && userId),
    meta: { liveBackOffice: true },
    queryFn: async () => {
      if (!sourceId || !directoryId || !userId) throw new Error(t("back_office.create.unavailable"));
      const params = new URLSearchParams({ kind, projectKey, sourceId, directoryId, userId });
      return z.object({ ids: z.array(z.string()) }).parse(await client.backOffice(`/native-links?${params}`)).ids;
    },
  });
  useEffect(() => onSyncPoke(poke => {
    if (sourceId && (poke.backOffice || poke.resync || poke.policy || poke.reload))
      void cache.invalidateQueries({ queryKey: ["native-directory", client.baseUrl] }, { cancelRefetch: false });
  }), [cache, client.baseUrl, sourceId]);
  useEffect(() => setOpen(false), [client.baseUrl, directoryId, userId, sourceId, projectKey]);
  useEffect(() => {
    if (directoryId && userId && draft && (directoryId !== draft.directoryId || userId !== draft.userId))
      onDraftChange?.(undefined);
  }, [directoryId, userId, draft, onDraftChange]);

  const names = useMemo(() => new Map(state?.records.map(record => [record.id, String(record.values.name ?? "")])), [state?.records]);
  if (!state || !directoryId || !userId) return null;
  const base = links.isError ? [] : links.data ?? [];
  const selected = draft?.directoryId === directoryId && draft.userId === userId ? applyChanges(base, draft) : base;
  const field = nativeModel(kind).fields.find(f => f.id === "linked")!;
  const canEdit = !disabled && state.permissions.edit && (!sourceId || links.isSuccess);
  return <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
    {!state.permissions.edit && <span className="text-muted-foreground">{t("native.linked")}</span>}
    {state.permissions.edit && <Popover open={open && canEdit} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button type="button" variant="outline" size="sm" className="h-8 gap-2 px-2.5 text-xs" disabled={!canEdit} />}>
        <Link2 className="size-3.5 text-muted-foreground" />{t("native.link_records")}
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[var(--available-height)] w-80 max-w-[var(--available-width)] overflow-auto p-1">
        <BackOfficeTheme><RecordCreationProvider client={client} state={state}>
          <CellEditor field={field} value={selected} records={state.records} onCancel={() => setOpen(false)} onSave={async (value, previous = selected) => {
            const next = stringIds(value);
            const add = next.filter(id => !previous.includes(id)), remove = previous.filter(id => !next.includes(id));
            if (!add.length && !remove.length) return;
            if (onDraftChange) {
              onDraftChange(current => {
                const before = current?.directoryId === directoryId && current.userId === userId ? applyChanges(base, current) : base;
                const after = applyChanges(before, { add, remove });
                const added = after.filter(id => !base.includes(id)), removed = base.filter(id => !after.includes(id));
                return added.length || removed.length ? { directoryId, userId, add: added, remove: removed } : undefined;
              });
            } else if (sourceId) {
              await linkRecords(client, state, kind, sourceId, projectKey, add, remove);
              cache.setQueryData<string[]>(key, ids => applyChanges(ids ?? base, { add, remove }));
              void cache.invalidateQueries({ queryKey: ["native-directory", client.baseUrl] });
            }
          }} />
        </RecordCreationProvider></BackOfficeTheme>
      </PopoverContent>
    </Popover>}
    {selected.filter(id => names.has(id)).map(id => <span key={id} className="max-w-full truncate rounded-md bg-muted px-2 py-1" title={names.get(id)}>{names.get(id)}</span>)}
    {links.isError && <Button type="button" size="sm" variant="ghost" onClick={() => void links.refetch()}>{t("back_office.history.retry")}</Button>}
  </div>;
}
