import { toast } from "@/components/ui/sonner";
import { RecordCreationProvider } from "./record-creation-context";
import { RecordFilesProvider } from "./record-files";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "@legalwork/types/back-office";
import {
  Archive,
  ArrowDownToLine,
  ChevronDown,
  Cloud,
  Database,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import { Dropdown } from "twenty-ui/components/navigation";
import { Button } from "twenty-ui/primitives/input";
import type {
  BackOfficeRecord,
  BackOfficeValue,
  BackOfficeView,
} from "@legalwork/types/back-office";
import {
  BackOfficeRecordSchema,
  BackOfficeViewSchema,
  defaultBackOfficeValues,
  validateBackOfficeValues,
  isInternalBackOfficeObject,
} from "@legalwork/types/back-office";
import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { onSyncPoke } from "@/react-app/kernel/sync-events";
import { applySavedRecord, BackOfficeStateSchema, loadBackOfficeState, writeBackOfficeRecord, type BackOfficeState, ModelPreviewSchema } from "./api";
import { ObjectIcon, primaryObjectIcons } from "./object-icon";
import { RecordGrid } from "./record-grid";
import { ValueDisplay } from "./record-values";
import { RecordDetail } from "./record-detail";
import { creatableRecordObject } from "./record-creation-values";
import { ModelEditor } from "./model-editor";
import {
  DirectoryDialog,
  DirectoryMenu,
  DirectorySelect,
  BackOfficeTheme,
} from "./twenty-controls";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { displayBackOfficeObject, backOfficeObjectLabel } from "./labels";
import "./back-office.css";

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

const pendingChangesSchema = z.object({
  changes: z.array(z.object({
    id: z.string(),
    summary: z.string(),
    error: z.string().nullable(),
    currentRevision: z.number().nullable(),
    comparison: z.array(z.object({
      field: z.string(),
      proposed: z.string(),
      current: z.string().nullable(),
    })),
  })),
});

export function BackOfficePage({ client }: { client: LegalworkServerClient }) {
  const locale = useLocale();
  const location = useLocation(),
    navigate = useNavigate(),
    cache = useQueryClient();
  const selected = location.pathname.split("/")[2] ?? "matters";
  const moreSelected = !primaryObjectIcons.has(selected) && selected !== "data-model";
  const [detailId, setDetailId] = useState<string | null>(
      new URLSearchParams(location.search).get("record"),
    ),
    [error, setError] = useState("");
  const openRecord = useCallback((record: BackOfficeRecord) => setDetailId(record.id), []);
  const [draft, setDraft] = useState<BackOfficeRecord | null>(null);
  const [focusNameId, setFocusNameId] = useState<string | null>(null);
  const creations = useRef(new Map<string, Promise<BackOfficeRecord>>());
  const [collision, setCollision] = useState<{
    current: BackOfficeRecord; fields: string[]; proposed: Record<string, BackOfficeValue>;
    decide: (useMine: boolean) => void;
  } | null>(null);
  const [viewConflict, setViewConflict] = useState<{ name: string; decide: (mine: boolean) => void } | null>(null);
  const conflictDecision = useRef<((mine: boolean) => void) | undefined>(undefined);
  const [detailWidth, setDetailWidth] = useState(400);
  const [syncDetailsOpen, setSyncDetailsOpen] = useState(false);
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
  const key = ["back-office", client.baseUrl, "auto", selected];
  const query = useQuery({
    queryKey: key,
    queryFn: ({signal}) => loadBackOfficeState(client, cache.getQueryData<BackOfficeState>(key), signal, undefined, selected),
    refetchInterval: 30_000,
  });
  const data = query.isError ? undefined : query.data;
  useEffect(() => () => { conflictDecision.current?.(false); }, [selected, data?.directoryId, data?.permissions.principalKey, data?.permissions.replicaId, data?.permissions.finance, data?.permissions.model]);
  const team = Boolean(data && data.scope !== "local");
  const pendingChanges = useQuery({
    queryKey: [...key, "pending", data?.directoryId, data?.permissions.principalKey, data?.permissions.replicaId, data?.sync.pending, data?.sync.cursor],
    enabled: syncDetailsOpen && team && !!data?.sync.pending,
    queryFn: async () => pendingChangesSchema.parse(await client.backOffice("/sync/pending", { team: true })).changes,
  });
  const projects = useQuery({
    queryKey: ["back-office-projects", client.baseUrl],
    queryFn: async () =>
      projectsSchema.parse(await client.backOffice("/projects")),
  });
  useEffect(
    () =>
      onSyncPoke((poke) => {
        if (poke.policy || poke.reload) {
          setDraft(null);
          setSyncDetailsOpen(false);
          setDiscardChange(null);
          setCsv("");
          setImportPlan(null);
          setImporting(false);
          setError("");
        }
        if (poke.policy || poke.reload || poke.backOffice || poke.resync)
          void cache.invalidateQueries({
            queryKey: ["back-office", client.baseUrl],
          }, { cancelRefetch: false });
      }),
    [cache, client.baseUrl],
  );
  useEffect(() => {
    setDraft(null);
    setFocusNameId(null);
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
  const object = useMemo(() => rawObject && displayBackOfficeObject(rawObject), [rawObject, locale]);
  const archiveKey = [...key, "archive", selected, data?.scope, data?.permissions.principalKey, data?.permissions.replicaId, data?.permissions.finance, data?.permissions.model];
  const archivedRecords = useQuery({
    queryKey: archiveKey,
    enabled: archived && Boolean(object),
    queryFn: ({signal}) => loadBackOfficeState(client, cache.getQueryData<BackOfficeState>(archiveKey), signal, selected, selected),
  });
  const records = useMemo(() => [
    ...(data?.records ?? []),
    ...(archived && data && !archivedRecords.isError && archivedRecords.data?.directoryId === data.directoryId ? archivedRecords.data?.records ?? [] : []),
  ], [data?.records, data?.directoryId, archived, archivedRecords.data, archivedRecords.isError]);
  const localDirectory = archived && archivedRecords.data?.directoryId === data?.directoryId ? archivedRecords.data : data;
  const pendingDetail = team ? localDirectory?.localRows?.find(record => record.id === detailId && !records.some(shared => shared.id === detailId)) : undefined;
  const detail = draft && draft.id === detailId ? draft : records.find((record) => record.id === detailId) ?? pendingDetail,
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
  const createRow = (record: BackOfficeRecord) => {
    const existing = creations.current.get(record.id);
    if (existing) return existing;
    if (!data) throw new Error(t("back_office.create.unavailable"));
    const pending = writeBackOfficeRecord(client, data, {
      id: record.id, create: true, objectId: record.objectId, revision: 0, values: record.values,
    }).then(async response => {
      const { record: saved } = z.object({ record: BackOfficeRecordSchema }).parse(response);
      await applySavedRecord(cache, client.baseUrl, data, saved);
      setDraft(current => current?.id === saved.id ? null : current);
      return saved;
    }).finally(() => creations.current.delete(record.id));
    creations.current.set(record.id, pending);
    return pending;
  };
  const save = async (
    record: BackOfficeRecord,
    values: Record<string, BackOfficeValue>,
    archived?: boolean,
  ) => {
    if (!data) return;
    const localCopy = localDirectory?.localRows?.some(row => row.id === record.id) && !data.records.some(row => row.id === record.id);
    let base = record;
    if (record.revision === 0) {
      const creating = creations.current.get(record.id);
      const saved = creating ? await creating : cache.getQueryData<BackOfficeState>(key)?.records.find(row => row.id === record.id);
      if (saved) base = saved;
      else {
        const next = { ...(draft?.id === record.id ? draft : record), values: { ...(draft?.id === record.id ? draft.values : record.values), ...values } };
        setDraft(next);
        const definition = data.model.objects.find(item => item.id === record.objectId);
        if (!definition) return;
        validateBackOfficeValues(definition, next.values);
        await createRow(next);
        return;
      }
    }
    for (;;) {
      const expectedValues = Object.fromEntries(Object.keys(values).map(id => [id, base.values[id] ?? null]));
      try {
        const result = z.object({ record: BackOfficeRecordSchema, localCopy: z.boolean().optional() }).parse(await writeBackOfficeRecord(client, data, {
          id: record.id, objectId: record.objectId, revision: base.revision, values, archived, expectedValues, localCopy,
        }));
        await applySavedRecord(cache, client.baseUrl, data, result.record, result.localCopy);
        return;
      } catch (error) {
        if (!(error instanceof LegalworkServerError) || error.code !== "back_office_field_conflict") throw error;
        const conflict = z.object({ record: BackOfficeRecordSchema, fields: z.array(z.string()) }).parse(error.details);
        const mine = await new Promise<boolean>(resolve => {
          conflictDecision.current?.(false);
          const decide = (apply: boolean) => { conflictDecision.current = undefined; setCollision(null); resolve(apply); };
          conflictDecision.current = decide;
          setCollision({ current: conflict.record, fields: conflict.fields, proposed: values, decide });
        });
        if (!mine) { void refresh(); return; }
        base = conflict.record;
      }
    }
  };
  const beginCreate = (values: Record<string, BackOfficeValue> = {}) => {
    if (!object || !data || !creatableRecordObject(data, object.id)) return;
    setError("");
    const now = new Date().toISOString();
    const newRecord = BackOfficeRecordSchema.parse({
      id: crypto.randomUUID(),
      objectId: object.id,
      values: { ...defaultBackOfficeValues(object), name: t("back_office.untitled"), ...values },
      revision: 0,
      schemaRevision: data.model.revision,
      ownerId: data.permissions.userId,
      access: "org",
      members: [],
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    setDraft(newRecord);
    setDetailId(newRecord.id);
    setFocusNameId(newRecord.id);
    setArchived(false);
    try { validateBackOfficeValues(object, newRecord.values); } catch { return; }
    void createRow(newRecord).catch(error => toast.error(error instanceof Error ? error.message : t("back_office.create.failed")));

  };
  const saveView = async (view: BackOfficeView, expected: BackOfficeView | null) => {
    let base = expected, candidate = view;
    for (let attempt = 0; ; attempt++) {
      try {
        const result = z.object({ view: BackOfficeViewSchema }).parse(await request("/views", { ...candidate, expected: base }));
        await refresh();
        return result.view;
      } catch (reason) {
        if (!(reason instanceof LegalworkServerError) || reason.code !== "back_office_view_conflict" || !base || attempt >= 3) throw reason;
        const state = BackOfficeStateSchema.pick({ directoryId: true, permissions: true, views: true }).parse(await client.backOffice("?schema=1"));
        if (!data || state.directoryId !== data.directoryId || state.permissions.userId !== data.permissions.userId ||
            state.permissions.principalKey !== data.permissions.principalKey || !state.permissions.edit)
          throw new Error(t("back_office.write.account_unavailable"));
        const latest = state.views.find(item => item.id === view.id && !item.archived);
        if (!latest) throw reason;
        const original = base;
        const edits = Object.entries(candidate).filter(([key, value]) => JSON.stringify(Reflect.get(original, key)) !== JSON.stringify(value));
        const overlaps = edits.some(([key, value]) => JSON.stringify(Reflect.get(latest, key)) !== JSON.stringify(Reflect.get(original, key)) &&
          JSON.stringify(Reflect.get(latest, key)) !== JSON.stringify(value));
        if (overlaps) {
          const mine = await new Promise<boolean>(resolve => {
            conflictDecision.current?.(false);
            const decide = (keep: boolean) => { conflictDecision.current = undefined; setViewConflict(null); resolve(keep); };
            conflictDecision.current = decide;
            setViewConflict({ name: latest.name, decide });
          });
          if (!mine) { await refresh(); return latest; }
        }
        base = latest;
        candidate = BackOfficeViewSchema.parse({ ...latest, ...Object.fromEntries(edits) });
      }
    }
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
                  ? value
                      .map((item) =>
                        typeof item === "string" ? item : item.name,
                      )
                      .join("|")
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
      : backOfficeObjectLabel(id);
  };
  const directoryStyle: CSSProperties & { "--bo-detail-width": string } = {
    "--bo-detail-width": `${detailWidth}px`,
  };
  return (
    <BackOfficeTheme>
      <RecordCreationProvider client={client} state={data}>
      <RecordFilesProvider
        key={data?.scope}
        records={draft ? [...records, draft] : records}
        client={client}
        projects={projects.data?.projects ?? []}
      >
        <div
          className={`bo ${detail ? "bo-has-detail" : ""}`}
          style={directoryStyle}
        >
          <nav className="bo-tabs" aria-label="Back Office">
            {Array.from(primaryObjectIcons.keys(), id => (
              <Button
                key={id}
                size="sm"
                variant={selected === id ? "soft" : "ghost"}
                onClick={() => show(id)}
                startIcon={<ObjectIcon id={id} size={16} />}
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
                  aria-pressed={moreSelected}
                  endIcon={<ChevronDown size={13} />}
                >
                  {moreSelected
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
                    !primaryObjectIcons.has(object.id),
                )
                .map((object) => (
                  <Dropdown.ActionItem
                    key={object.id}
                    onClick={() => show(object.id)}
                    startIcon={<ObjectIcon id={object.id} size={14} />}
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
                    revision: model.revision,
                  }),
                )
              }
              onSave={async (model) => {
                await request(
                  "/model",
                  { model, revision: model.revision },
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
                  <ObjectIcon id={object.id} size={16} />
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
                    {team && (
                      <Dropdown.ActionItem startIcon={<Cloud size={14} />} onClick={() => {
                        setError("");
                        setSyncDetailsOpen(true);
                      }}>
                        {t("back_office.team_sync")}
                      </Dropdown.ActionItem>
                    )}
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
                  </DirectoryMenu>
                </div>
              </header>
              <RecordGrid
                key={object.id + String(team)}
                object={object}
                records={records}
                draft={draft} localChoices={localDirectory?.localChoices}
                localRows={team ? localDirectory?.localRows : undefined}
                views={data.views}
                editable={data.permissions.edit}
                finance={data.permissions.finance}
                userId={data.permissions.userId}
                onSave={save}
                onOpen={openRecord}
                onCreate={(values) => void beginCreate(values)}
                onSaveView={saveView}
                archived={archived}
                onArchivedChange={setArchived}
              />
            </>
          )}
          {viewConflict && <DirectoryDialog title={t("back_office.conflict.title")} onClose={() => viewConflict.decide(false)}>
            <p>{t("back_office.conflict.view", { name: viewConflict.name })}</p>
            <div className="bo-modal-footer">
              <Button size="sm" onClick={() => viewConflict.decide(false)}>{t("back_office.conflict.keep")}</Button>
              <Button size="sm" variant="solid" onClick={() => viewConflict.decide(true)}>{t("back_office.conflict.apply")}</Button>
            </div>
          </DirectoryDialog>}
          {collision && data && (
            <DirectoryDialog title={t("back_office.conflict.title")} onClose={() => collision.decide(false)}>
              <div className="bo-form">
                {collision.fields.map(id => {
                  const field = data.model.objects.find(o => o.id === collision.current.objectId)?.fields.find(f => f.id === id);
                  if (!field) return null;
                  const display = (value: BackOfficeValue | undefined) => value == null || value === "" ? "∅" :
                    <ValueDisplay field={field} value={value} records={records} onOpen={openRecord} />;
                  return <section key={id}><strong>{field.label}</strong><dl>
                    <dt>{t("back_office.conflict.saved")}</dt><dd>{display(collision.current.values[id])}</dd>
                    <dt>{t("back_office.conflict.yours")}</dt><dd>{display(collision.proposed[id])}</dd>
                  </dl></section>;
                })}
                <div className="bo-modal-footer">
                  <Button size="sm" onClick={() => collision.decide(false)}>{t("back_office.conflict.keep")}</Button>
                  <Button size="sm" variant="solid" onClick={() => collision.decide(true)}>{t("back_office.conflict.apply")}</Button>
                </div>
              </div>
            </DirectoryDialog>
          )}
          {data && detail && detailObject && (
            <RecordDetail
              client={client}
              team={team}
              historyAccessKey={`${data.permissions.principalKey ?? data.permissions.userId}:${data.permissions.replicaId ?? "local"}:${data.permissions.model}:${data.permissions.finance}`}
              key={detail.id}
              record={detail}
              focusName={focusNameId === detail.id}
              width={detailWidth}
              onWidthChange={setDetailWidth}
              object={displayBackOfficeObject(detailObject)}
              records={pendingDetail ? localDirectory?.localChoices ?? [] : records}
              editable={data.permissions.edit}
              onReviewLocal={pendingDetail ? () => { setError(""); setSyncDetailsOpen(true); } : undefined}
              finance={data.permissions.finance}
              userId={data.permissions.userId}
              onClose={() => { setDetailId(null); setDraft(null); setFocusNameId(null); }}
              onSave={save}
              onOpen={openRecord}

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
                              object.fields
                                .filter((field) => field.type !== "file")
                                .flatMap((field) => {
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
                          setMapping({
                            ...mapping,
                            $sourceId: event.target.value,
                          });
                          setImportPlan(null);
                        }}
                      />
                    </label>
                    {object.fields
                      .filter((field) => field.type !== "file")
                      .map((field) => (
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
          {syncDetailsOpen && data && team && (
            <DirectoryDialog title={t("back_office.team_sync")} onClose={() => { setSyncDetailsOpen(false); setError(""); }}>
              <div className="bo-form">
                {data.firstSync && data.firstSync.unassigned > 0 && data.permissions.edit && (
                  <div>
                    <p>{t("back_office.assign_local", { count: data.firstSync.unassigned, firm: data.firstSync.firm })}</p>
                    <Button size="sm" onClick={() => void request("/sync/assign-local", {
                      directoryId: data.directoryId, selection: data.firstSync?.selection,
                    }).then(refresh).catch(err => setError(err.message))}>{t("back_office.share_with", { firm: data.firstSync.firm })}</Button>
                  </div>
                )}
                {!!data.firstSync?.waiting && <p>{t("back_office.first_sync_waiting", { count: data.firstSync.waiting, firm: data.firstSync.firm })}</p>}
                {error && <p role="alert">{error}</p>}
                {data.sync.error && <div>
                  <p>{t("back_office.sync_retry_hint")}</p>
                </div>}
                {!data.sync.error && !data.sync.pending && !data.firstSync?.unassigned && !data.firstSync?.waiting &&
                  <p>{t("back_office.sync_current")}</p>}
                {pendingChanges.isError && !!data.sync.pending && <p role="alert">{t("back_office.sync_retry_hint")}</p>}
                {(data.sync.pending ? pendingChanges.data ?? [] : []).map((change) => (
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
                              Team:{" "}
                              {item.current ?? "Unavailable while offline"}
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
                              setSyncDetailsOpen(false);
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
                          setSyncDetailsOpen(false);
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

        </div>
      </RecordFilesProvider>
      </RecordCreationProvider>
    </BackOfficeTheme>
  );
}
