import { useEffect, useState, type CSSProperties } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "@legalwork/types/back-office";
import {
  Archive,
  ArrowDownToLine,
  BriefcaseBusiness,
  Building2,
  ChevronDown,
  Cloud,
  Database,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Upload,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { ThemeProvider } from "twenty-ui/theme";
import { Dropdown } from "twenty-ui/components/navigation";
import { Button } from "twenty-ui/primitives/input";
import type {
  BackOfficeRecord,
  BackOfficeValue,
  BackOfficeView,
} from "@legalwork/types/back-office";
import {
  BackOfficeRecordSchema,
  validateBackOfficeValues,
  isInternalBackOfficeObject,
} from "@legalwork/types/back-office";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { onSyncPoke } from "@/react-app/kernel/sync-events";
import { BackOfficeStateSchema, ModelPreviewSchema } from "./api";
import { RecordGrid } from "./record-grid";
import { RecordDetail } from "./record-detail";
import { ModelEditor } from "./model-editor";
import {
  DirectoryDialog,
  DirectoryMenu,
  DirectorySelect,
  directoryTheme,
} from "./twenty-controls";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { displayBackOfficeObject } from "./labels";
import "./back-office.css";

const primary = [
  { id: "matters", name: "Matters", icon: BriefcaseBusiness },
  { id: "clients", name: "Clients", icon: UsersRound },
  { id: "people", name: "People", icon: UserRound },
  { id: "companies", name: "Companies", icon: Building2 },
];
const projectsSchema = z.object({
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
});
const importSchema = z.object({
  planId: z.string(),
  valid: z.boolean(),
  rows: z.array(
    z.object({
      row: z.number(),
      values: z.record(z.string(), z.unknown()),
      warning: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});

export function BackOfficePage({ client }: { client: LegalworkServerClient }) {
  useLocale();
  const location = useLocation(),
    navigate = useNavigate(),
    cache = useQueryClient();
  const selected = location.pathname.split("/")[2] ?? "matters";
  const [dark, setDark] = useState(
    document.documentElement.classList.contains("dark"),
  );
  const [detailId, setDetailId] = useState<string | null>(
      new URLSearchParams(location.search).get("record"),
    ),
    [error, setError] = useState("");
  const [draft, setDraft] = useState<BackOfficeRecord | null>(null);
  const [focusNameId, setFocusNameId] = useState<string | null>(null);
  const [detailWidth, setDetailWidth] = useState(400);
  const [pendingChanges, setPendingChanges] = useState<
    | {
        id: string;
        summary: string;
        error: string | null;
        currentRevision: number | null;
        comparison: {
          field: string;
          proposed: string;
          current: string | null;
        }[];
      }[]
    | null
  >(null);
  const [discardChange, setDiscardChange] = useState<string | null>(null);
  const [menu, setMenu] = useState(false),
    [more, setMore] = useState(false),
    [archived, setArchived] = useState(false);
  const [importing, setImporting] = useState(false),
    [csv, setCsv] = useState(""),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [importPlan, setImportPlan] = useState<z.infer<typeof importSchema> | null>(
      null,
    );
  const key = ["back-office", client.baseUrl, "auto"];
  const query = useQuery({
    queryKey: key,
    queryFn: async () =>
      BackOfficeStateSchema.parse(await client.backOffice("")),
    refetchInterval: 30_000,
  });
  const data = query.isError ? undefined : query.data;
  const team = Boolean(data && data.scope !== "local");
  const projects = useQuery({
    queryKey: ["back-office-projects", client.baseUrl],
    queryFn: async () =>
      projectsSchema.parse(await client.backOffice("/projects")),
  });
  useEffect(
    () =>
      onSyncPoke((poke) => {
        if (poke.backOffice || poke.resync)
          void cache.invalidateQueries({
            queryKey: ["back-office", client.baseUrl],
          });
      }),
    [cache, client.baseUrl],
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setDark(document.documentElement.classList.contains("dark")),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setDetailId(new URLSearchParams(location.search).get("record"));
    setArchived(false);
    setError("");
  }, [selected, team, location.search]);
  const rawObject = data?.model.objects.find(
    (object) =>
      object.id === selected &&
      !object.archived &&
      !isInternalBackOfficeObject(object.id),
  );
  const object = rawObject && displayBackOfficeObject(rawObject);
  const archivedRecords = useQuery({
    queryKey: [...key, "archive", selected],
    enabled: archived && Boolean(object),
    queryFn: async () =>
      z.object({ records: z.array(BackOfficeRecordSchema) }).parse(
        await client.backOffice(`/records/${selected}?archived=true`, {
          team,
        }),
      ),
  });
  const records = [
    ...(data?.records ?? []),
    ...(archivedRecords.data?.records ?? []),
    ...(draft ? [draft] : []),
  ];
  const detail = records.find((record) => record.id === detailId),
    detailObject = data?.model.objects.find(
      (object) =>
        object.id === detail?.objectId &&
        !isInternalBackOfficeObject(object.id),
    );
  const request = (path: string, body: unknown, method = "POST") =>
    client.backOffice(path, { method, body, team });
  const refresh = async () => {
    await cache.invalidateQueries({
      queryKey: ["back-office", client.baseUrl],
    });
  };
  const save = async (
    record: BackOfficeRecord,
    values: Record<string, BackOfficeValue>,
    archived?: boolean,
  ) => {
    if (record.revision === 0) {
      const object = data?.model.objects.find(
        (object) => object.id === record.objectId,
      );
      if (!object) return;
      const next = { ...record, values: { ...record.values, ...values } };
      setDraft(next);
      try {
        validateBackOfficeValues(object, next.values);
      } catch {
        return;
      }
      const result = z.object({ record: BackOfficeRecordSchema }).parse(
        await request("/records", {
          objectId: record.objectId,
          revision: 0,
          values: next.values,
        }),
      );
      setDraft(null);
      setDetailId(result.record.id);
      setFocusNameId(result.record.id);
    } else
      await request("/records", {
        id: record.id,
        objectId: record.objectId,
        revision: record.revision,
        values,
        archived,
      });
    await refresh();
  };
  const beginCreate = async (values: Record<string, BackOfficeValue> = {}) => {
    if (!object || !data) return;
    if (object.id === "projectLinks") {
      setError("Link projects from a matter’s record panel.");
      return;
    }
    setError("");
    const now = new Date().toISOString();
    const draft = BackOfficeRecordSchema.parse({
      id: crypto.randomUUID(),
      objectId: object.id,
      values: { name: "Untitled", ...values },
      revision: 0,
      schemaRevision: data.model.revision,
      ownerId: data.permissions.userId,
      access: "org",
      members: [],
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    try {
      validateBackOfficeValues(object, draft.values);
    } catch {
      setDraft(draft);
      setDetailId(draft.id);
      setFocusNameId(draft.id);
      return;
    }
    try {
      const result = z.object({ record: BackOfficeRecordSchema }).parse(
        await request("/records", {
          objectId: object.id,
          revision: 0,
          values: draft.values,
        }),
      );
      await refresh();
      setDetailId(result.record.id);
      setFocusNameId(result.record.id);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Could not create record.",
      );
    }
  };
  const saveView = async (view: BackOfficeView) => {
    await request("/views", view);
    await refresh();
  };
  const exportCsv = () => {
    if (!object) return;
    const columns = object.fields.filter(
      (field) => field.visibility !== "finance" || data?.permissions.finance,
    );
    const escape = (value: unknown) =>
      '"' + String(value ?? "").replaceAll('"', '""') + '"';
    const text = [
      columns
        .map((field) => field.label)
        .map(escape)
        .join(","),
      ...records
        .filter((record) => record.objectId === object.id)
        .map((record) =>
          columns
            .map((field) => {
              const value = record.values[field.id];
              return escape(
                Array.isArray(value)
                  ? value.join("|")
                  : typeof value === "object" && value !== null
                    ? value.amountMinor / 100
                    : value,
              );
            })
            .join(","),
        ),
    ].join("\r\n");
    const url = URL.createObjectURL(
        new Blob([text], { type: "text/csv;charset=utf-8" }),
      ),
      anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = object.id + ".csv";
    anchor.click();
    URL.revokeObjectURL(url);
    setMore(false);
  };
  const show = (id: string) => {
    navigate("/back-office/" + id);
    setMenu(false);
  };
  const tabName = (id: string) => {
    const object = data?.model.objects.find((object) => object.id === id);
    return object
      ? displayBackOfficeObject(object).plural
      : t(`back_office.${id}.plural`);
  };
  const directoryStyle: CSSProperties & { "--bo-detail-width": string } = {
    "--bo-detail-width": `${detailWidth}px`,
  };
  return (
    <ThemeProvider
      colorScheme={dark ? "dark" : "light"}
      applyToRoot={false}
      overrides={directoryTheme}
    >
      <div
        className={`bo ${detail ? "bo-has-detail" : ""}`}
        style={directoryStyle}
        data-theme={dark ? "dark" : "light"}
      >
        <nav className="bo-tabs" aria-label="Back Office">
          {primary.map(({ id, icon: Icon }) => (
            <Button
              key={id}
              size="sm"
              variant={selected === id ? "soft" : "ghost"}
              onClick={() => show(id)}
              startIcon={<Icon size={16} />}
              aria-current={selected === id ? "page" : undefined}
            >
              {tabName(id)}
            </Button>
          ))}
          <DirectoryMenu
            open={menu}
            onOpenChange={setMenu}
            trigger={
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={
                  !primary.some((tab) => tab.id === selected) &&
                  selected !== "data-model"
                }
                endIcon={<ChevronDown size={13} />}
              >
                {!primary.some((tab) => tab.id === selected) &&
                selected !== "data-model"
                  ? (object?.plural ?? t("back_office.more"))
                  : t("back_office.more")}
              </Button>
            }
          >
            {data?.model.objects
              .filter(
                (object) =>
                  !object.archived &&
                  !isInternalBackOfficeObject(object.id) &&
                  !primary.some((tab) => tab.id === object.id),
              )
              .map((object) => (
                <Dropdown.ActionItem
                  key={object.id}
                  onClick={() => show(object.id)}
                  startIcon={<Database size={14} />}
                >
                  {displayBackOfficeObject(object).plural}
                </Dropdown.ActionItem>
              ))}
          </DirectoryMenu>
          <Button
            size="sm"
            variant={selected === "data-model" ? "soft" : "ghost"}
            onClick={() => show("data-model")}
            startIcon={<Database size={16} />}
          >
            {t("back_office.data_model")}
          </Button>
        </nav>
        {!data && (
          <div className="bo-loading">
            {query.error ? (
              <>
                <strong>{query.error.message}</strong>
                <Button size="sm" onClick={() => void query.refetch()}>
                  Try again
                </Button>
              </>
            ) : (
              <>
                <RefreshCw size={18} className="animate-spin" />
                Loading Back Office…
              </>
            )}
          </div>
        )}
        {data && selected === "data-model" && (
          <ModelEditor
            model={data.model}
            editable={data.permissions.model}
            onPreview={async (model) =>
              ModelPreviewSchema.parse(
                await request("/model/preview", {
                  model,
                  revision: data.model.revision,
                }),
              )
            }
            onSave={async (model) => {
              await request(
                "/model",
                { model, revision: data.model.revision },
                "PUT",
              );
              await refresh();
            }}
            onRecords={show}
          />
        )}
        {data && object && (
          <>
            <header className="bo-object-header">
              <h1>
                <BriefcaseBusiness size={16} />
                {object.plural}
              </h1>
              <div className="bo-object-actions">
                <Button
                  size="sm"
                  variant="solid"
                  color="accent"
                  startIcon={<Plus size={14} />}
                  onClick={() => void beginCreate()}
                  disabled={!data.permissions.edit}
                >
                  Create
                </Button>
                <DirectoryMenu
                  open={more}
                  onOpenChange={setMore}
                  trigger={
                    <Button
                      size="sm"
                      aria-label="More actions"
                      startIcon={<MoreHorizontal size={16} />}
                    />
                  }
                >
                  <Dropdown.ActionItem
                    onClick={() => {
                      setImporting(true);
                      setCsv("");
                      setImportPlan(null);
                    }}
                    disabled={!data.permissions.edit}
                    startIcon={<Upload size={14} />}
                  >
                    Import CSV
                  </Dropdown.ActionItem>
                  <Dropdown.ActionItem
                    onClick={exportCsv}
                    startIcon={<ArrowDownToLine size={14} />}
                  >
                    Export CSV
                  </Dropdown.ActionItem>
                  <Dropdown.Separator />
                  <Dropdown.ActionItem
                    onClick={() => setArchived(!archived)}
                    startIcon={<Archive size={14} />}
                  >
                    {archived ? "Show active" : "Show archive"}
                  </Dropdown.ActionItem>
                  <Dropdown.ActionItem
                    onClick={() => show("data-model")}
                    startIcon={<Database size={14} />}
                  >
                    Edit data model
                  </Dropdown.ActionItem>
                  <Dropdown.ActionItem
                    onClick={() => void refresh()}
                    startIcon={<RefreshCw size={14} />}
                  >
                    Refresh
                  </Dropdown.ActionItem>
                </DirectoryMenu>
              </div>
            </header>
            <RecordGrid
              key={object.id + String(team)}
              object={object}
              records={records}
              views={data.views}
              editable={data.permissions.edit}
              finance={data.permissions.finance}
              userId={data.permissions.userId}
              onSave={save}
              onOpen={(record) => setDetailId(record.id)}
              onCreate={(values) => void beginCreate(values)}
              onSaveView={saveView}
              archived={archived}
              onArchivedChange={setArchived}
            />
          </>
        )}
        {data && detail && detailObject && (
          <RecordDetail
            key={detail.id}
            record={detail}
            focusName={focusNameId === detail.id}
            width={detailWidth}
            onWidthChange={setDetailWidth}
            object={displayBackOfficeObject(detailObject)}
            records={records}
            editable={data.permissions.edit}
            finance={data.permissions.finance}
            userId={data.permissions.userId}
            projects={projects.data?.projects ?? []}
            onClose={() => setDetailId(null)}
            onSave={save}
            onOpen={(record) => setDetailId(record.id)}
            onLink={async (projectId, matter) => {
              const project = projects.data?.projects.find(
                (project) => project.id === projectId,
              );
              await request("/records", {
                objectId: "projectLinks",
                revision: 0,
                values: {
                  name: project?.name ?? projectId,
                  projectId,
                  matter: matter.id,
                },
              });
              await refresh();
            }}
            onUnlink={(record) => save(record, {}, true)}
          />
        )}
        {importing && object && (
          <DirectoryDialog
            title={`Import ${object.plural}`}
            wide
            onClose={() => setImporting(false)}
          >
            <div className="bo-form">
              <label>
                CSV file
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file)
                      void file.text().then((text) => {
                        setCsv(text);
                        setImportPlan(null);
                        const headers = text
                          .split(/\r?\n/)[0]
                          .split(",")
                          .map((value) => value.replace(/^"|"$/g, "").trim());
                        setMapping(
                          Object.fromEntries(
                            object.fields.flatMap((field) => {
                              const header = headers.find((header) =>
                                [
                                  field.id.toLowerCase(),
                                  field.label.toLowerCase(),
                                ].includes(header.toLowerCase()),
                              );
                              return header ? [[field.id, header]] : [];
                            }),
                          ),
                        );
                      });
                  }}
                />
              </label>
              {csv && (
                <div className="bo-import-mapping">
                  <label>
                    {t("Source ID (optional)")}
                    <input
                      value={mapping.$sourceId ?? ""}
                      placeholder={t("CSV column name")}
                      onChange={(event) => {
                        setMapping({ ...mapping, $sourceId: event.target.value });
                        setImportPlan(null);
                      }}
                    />
                  </label>
                  {object.fields.map((field) => (
                    <label key={field.id}>
                      {field.label}
                      <input
                        value={mapping[field.id] ?? ""}
                        placeholder="CSV column name"
                        onChange={(event) => {
                          setMapping((current) => ({
                            ...current,
                            [field.id]: event.target.value,
                          }));
                          setImportPlan(null);
                        }}
                      />
                    </label>
                  ))}
                </div>
              )}
              {importPlan && (
                <div className="bo-import-preview">
                  {importPlan.rows.map((row) => (
                    <div key={row.row}>
                      <strong>Row {row.row}</strong>{" "}
                      {String(row.values.name ?? "")}
                      <span className={row.error ? "bo-error" : "bo-muted"}>
                        {row.error ?? row.warning ?? "Create record"}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {error && (
                <p className="bo-error" role="alert">
                  {error}
                </p>
              )}
              <div className="bo-modal-footer">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!csv}
                  onClick={() =>
                    void request("/import/preview", {
                      objectId: object.id,
                      csv,
                      mapping,
                    })
                      .then((response) => {
                        setImportPlan(importSchema.parse(response));
                        setError("");
                      })
                      .catch((error) => setError(error.message))
                  }
                >
                  Preview import
                </Button>
                <Button
                  size="sm"
                  disabled={!importPlan?.valid}
                  onClick={() =>
                    void request("/import/apply", {
                      planId: importPlan?.planId,
                    })
                      .then(() => {
                        setImporting(false);
                        return refresh();
                      })
                      .catch((error) => setError(error.message))
                  }
                >
                  Import {importPlan?.rows.length ?? ""} records
                </Button>
              </div>
            </div>
          </DirectoryDialog>
        )}
        {pendingChanges && (
          <DirectoryDialog
            title="Pending team changes"
            onClose={() => setPendingChanges(null)}
          >
            <div className="bo-form">
              {pendingChanges.map((change) => (
                <div key={change.id} className="bo-pending-change">
                  <strong>{change.summary}</strong>
                  <p className="bo-muted">
                    {change.error ?? "Waiting to sync"}
                  </p>
                  <dl className="bo-conflict-comparison">
                    {change.comparison.map((item) => (
                      <div key={item.field}>
                        <dt>{item.field}</dt>
                        <dd>
                          <span className="bo-muted">
                            Team: {item.current ?? "Unavailable while offline"}
                          </span>
                          <br />
                          Your edit: {item.proposed}
                        </dd>
                      </div>
                    ))}
                  </dl>
                  {change.error && change.currentRevision !== null && (
                    <Button
                      size="sm"
                      variant="solid"
                      color="accent"
                      onClick={() =>
                        void request("/sync/resolve", {
                          id: change.id,
                          revision: change.currentRevision,
                        })
                          .then(() => {
                            setPendingChanges(null);
                            return refresh();
                          })
                          .catch((error) => setError(error.message))
                      }
                    >
                      Apply my changes
                    </Button>
                  )}
                  {change.error && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDiscardChange(change.id)}
                    >
                      Discard queued edit
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </DirectoryDialog>
        )}
        {discardChange && (
          <DirectoryDialog
            title="Discard queued edits?"
            onClose={() => setDiscardChange(null)}
          >
            <div className="bo-form">
              <p>
                This removes your queued edits for this record and reloads the
                team version.
              </p>
              <div className="bo-modal-footer">
                <Button size="sm" onClick={() => setDiscardChange(null)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="solid"
                  color="danger"
                  onClick={() =>
                    void request("/sync/discard", { id: discardChange })
                      .then(() => {
                        setDiscardChange(null);
                        setPendingChanges(null);
                        return refresh();
                      })
                      .catch((error) => setError(error.message))
                  }
                >
                  Discard edits
                </Button>
              </div>
            </div>
          </DirectoryDialog>
        )}
        {error && !importing && (
          <div className="bo-error" role="alert">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={13} />
            </button>
          </div>
        )}
        {data && team && (data.sync.pending > 0 || data.sync.error) && (
          <footer className="bo-footer">
            {team && <Cloud size={13} />}
            {data.sync.pending > 0 && team && (
              <button
                onClick={() =>
                  void client
                    .backOffice("/sync/pending", { team })
                    .then((response) =>
                      setPendingChanges(
                        z
                          .object({
                            changes: z.array(
                              z.object({
                                id: z.string(),
                                summary: z.string(),
                                error: z.string().nullable(),
                                currentRevision: z.number().nullable(),
                                comparison: z.array(
                                  z.object({
                                    field: z.string(),
                                    proposed: z.string(),
                                    current: z.string().nullable(),
                                  }),
                                ),
                              }),
                            ),
                          })
                          .parse(response).changes,
                      ),
                    )
                    .catch((error) => setError(error.message))
                }
              >
                {data.sync.pending} changes pending
              </button>
            )}
            {data.sync.error && (
              <span className="bo-error">{data.sync.error}</span>
            )}
          </footer>
        )}
      </div>
    </ThemeProvider>
  );
}
