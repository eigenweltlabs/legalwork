import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { backOfficeProjectContext } from "@legalwork/types/back-office";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { BackOfficeStateSchema } from "./api";

export function ProjectMatters({
  client,
  projectId,
  name,
}: {
  client: LegalworkServerClient;
  projectId: string;
  name: string;
}) {
  useLocale();
  const navigate = useNavigate(),
    cache = useQueryClient();
  const [choosing, setChoosing] = useState(false),
    [matterId, setMatterId] = useState(""),
    [error, setError] = useState("");
  const key = ["back-office", client.baseUrl, "auto"];
  const state = useQuery({
    queryKey: key,
    queryFn: async () =>
      BackOfficeStateSchema.parse(await client.backOffice("")),
  });
  const records = state.data?.records ?? [];
  const { links, matters, clients } = backOfficeProjectContext(
    records,
    projectId,
  );
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState(name);
  const [newClient, setNewClient] = useState("");
  const mutate = async (body: unknown, path = "/records") => {
    try {
      await client.backOffice(path, { method: "POST", body });
      await cache.invalidateQueries({
        queryKey: ["back-office", client.baseUrl],
      });
      setMatterId("");
      setChoosing(false);
      setCreating(false);
      setError("");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not update the link.",
      );
    }
  };
  return (
    <section className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <Link2 className="size-4 text-muted-foreground" />
          Matters
        </h3>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setChoosing(!choosing)}
            disabled={!state.data?.permissions.edit}
          >
            <Plus className="size-3.5" />
            Link matter
          </Button>
        </div>
      </div>
      {matters.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {matters.map((matter) => (
            <div
              key={matter.id}
              className="flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs"
            >
              <button
                onClick={() =>
                  navigate(`/back-office/matters?record=${matter.id}`)
                }
              >
                {String(matter.values.name)}
              </button>
              {state.data?.permissions.edit && (
                <button
                  aria-label={`Unlink ${matter.values.name}`}
                  onClick={() => {
                    const link = links.find(
                      (link) => link.values.matter === matter.id,
                    );
                    if (link)
                      void mutate({
                        id: link.id,
                        objectId: "projectLinks",
                        revision: link.revision,
                        values: {},
                        archived: true,
                      });
                  }}
                >
                  <X className="size-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          {state.error
            ? state.error.message
            : "This project has no linked matters."}
        </p>
      )}
      {clients.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("back_office.clients.plural")} ·{" "}
          {clients.map((client) => String(client.values.name)).join(", ")}
        </p>
      )}
      <Button
        size="sm"
        variant="ghost"
        className="mt-2"
        disabled={!state.data?.permissions.edit}
        onClick={() => {
          setCreating(!creating);
          setChoosing(false);
        }}
      >
        Create and link a matter
      </Button>
      {creating && (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void mutate(
              { name: newName, clients: newClient ? [newClient] : [] },
              `/projects/${encodeURIComponent(projectId)}/matter`,
            );
          }}
        >
          <label className="text-xs text-muted-foreground">
            Matter name
            <Input
              required
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
            />
          </label>
          <select
            className="rounded-md border bg-background p-2 text-xs"
            aria-label="Client for new matter"
            value={newClient}
            onChange={(event) => setNewClient(event.target.value)}
          >
            <option value="">No client yet</option>
            {records
              .filter((record) => record.objectId === "clients")
              .map((record) => (
                <option key={record.id} value={record.id}>
                  {String(record.values.name)}
                </option>
              ))}
          </select>
          <p className="text-xs text-muted-foreground">
            Choose the client explicitly. Similar project and client names do
            not create a link.
          </p>
          <Button size="sm" type="submit">
            Create matter
          </Button>
        </form>
      )}
      {choosing && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (matterId)
              void mutate({
                objectId: "projectLinks",
                revision: 0,
                values: { name, projectId, matter: matterId },
              });
          }}
        >
          <select
            className="min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
            aria-label="Matter to link"
            value={matterId}
            onChange={(event) => setMatterId(event.target.value)}
          >
            <option value="">Choose a matter…</option>
            {records
              .filter(
                (record) =>
                  record.objectId === "matters" &&
                  !matters.some((matter) => matter.id === record.id),
              )
              .map((matter) => (
                <option value={matter.id} key={matter.id}>
                  {String(matter.values.name)}
                </option>
              ))}
          </select>
          <Button size="sm" disabled={!matterId} type="submit">
            Link
          </Button>
        </form>
      )}
      {error && (
        <p className="mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
