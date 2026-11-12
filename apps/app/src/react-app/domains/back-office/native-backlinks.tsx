import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { z } from "@legalwork/types/back-office";
import { Button, Input } from "twenty-ui/primitives/input";
import { ListItem } from "twenty-ui/primitives/navigation";
import { Plus, X } from "lucide-react";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { toast } from "@/components/ui/sonner";
import { linkRecords, type BackOfficeState } from "./api";
import { useNativeRows } from "./native-table";
import { DirectoryMenu, DirectorySelect } from "./twenty-controls";
import type { NativeKind } from "./native-model";

const edge = z.object({
  kind: z.enum(["task", "deadline"]),
  sourceId: z.string(),
  projectKey: z.string(),
  title: z.string(),
});
export function NativeBacklinks({
  client,
  state,
  id,
}: {
  client: LegalworkServerClient;
  state: BackOfficeState;
  id: string;
}) {
  const [open, setOpen] = useState(false),
    [kind, setKind] = useState<NativeKind>("task"),
    [search, setSearch] = useState(""),
    [busy, setBusy] = useState(false);
  const navigate = useNavigate(),
    cache = useQueryClient();
  const query = useQuery({
    queryKey: [
      "native-directory",
      client.baseUrl,
      state.directoryId,
      state.permissions.userId,
      state.permissions.replicaId,
      "linked",
      id,
    ],
    meta: { liveBackOffice: true },
    queryFn: async () =>
      z.object({ links: z.array(edge) }).parse(await client.backOffice("/native-linked/" + id)).links,
    refetchInterval: 30000,
  });
  const options = useNativeRows(client, state, kind, "", false, open);
  const links = query.isError ? [] : query.data ?? [];
  const toggle = async (k: NativeKind, sourceId: string, projectKey: string, add: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await linkRecords(client, state, k, sourceId, projectKey, add ? [id] : [], add ? [] : [id]);
      await cache.invalidateQueries({ queryKey: ["native-directory", client.baseUrl] });
      setOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("back_office.create.failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bo-native-links">
      <div className="bo-schema-heading">
        <strong>{t("native.linked_work")}</strong>
        {state.permissions.edit && (
          <DirectoryMenu
            type="picker"
            open={open}
            onOpenChange={(v) => {
              setOpen(v);
              setSearch("");
            }}
            trigger={
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("native.linked_work")}
                startIcon={<Plus size={14} />}
              />
            }
          >
            <DirectorySelect
              label={t("native.linked_work")}
              value={kind}
              onChange={(v) => setKind(v === "deadline" ? "deadline" : "task")}
              options={[
                { value: "task", label: t("tasks.title") },
                { value: "deadline", label: t("native.deadlines") },
              ]}
            />
            <Input
              size="sm"
              aria-label={t("back_office.search_records")}
              placeholder={t("back_office.search_records")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="bo-choices">
              {(options.isError ? undefined : options.data)?.records
                .filter((r) =>
                  String(r.record.values.name).toLowerCase().includes(search.trim().toLowerCase()),
                )
                .slice(0, 100)
                .map((r) => {
                  const selected = links.some(
                    (l) =>
                      l.kind === kind &&
                      l.sourceId === r.sourceId &&
                      (kind === "task" || l.projectKey === r.workspaceId),
                  );
                  return (
                    <ListItem
                      key={r.record.id}
                      render={<button disabled={busy} />}
                      selected={selected}
                      indicator="check"
                      onClick={() => void toggle(kind, r.sourceId, r.workspaceId, !selected)}
                    >
                      {String(r.record.values.name)}
                    </ListItem>
                  );
                })}
            </div>
          </DirectoryMenu>
        )}
      </div>
      {links.map((l) => (
        <div className="bo-native-link" key={JSON.stringify([l.kind, l.projectKey, l.sourceId])}>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const object = l.kind === "task" ? "@tasks" : "@deadlines",
                record = l.kind + JSON.stringify([l.projectKey, l.sourceId]);
              navigate("/back-office/" + object + "?record=" + encodeURIComponent(record));
            }}
          >
            {l.title}
          </Button>
          {state.permissions.edit && (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label={t("common.remove") + ": " + l.title}
              startIcon={<X size={12} />}
              onClick={() => void toggle(l.kind, l.sourceId, l.projectKey, false)}
            />
          )}
        </div>
      ))}
    </div>
  );
}
