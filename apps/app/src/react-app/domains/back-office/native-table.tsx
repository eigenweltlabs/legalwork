import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button, Input } from "twenty-ui/primitives/input";
import { Plus } from "lucide-react";
import {
  z,
  BackOfficeViewSchema,
  type BackOfficeRecord,
  type BackOfficeValue,
  type BackOfficeView,
} from "@legalwork/types/back-office";
import { LegalworkServerError, type LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { toast } from "@/components/ui/sonner";
import { onSyncPoke } from "../../kernel/sync-events";
import { useProjectBackOffice } from "../workspace/project-record-field";
import { RecordCreationProvider } from "./record-creation-context";
import { BackOfficeTheme, DirectoryDialog, DirectorySelect } from "./twenty-controls";
import { linkRecords } from "./api";
import type { BackOfficeState } from "./api";
import {
  choices,
  nativeModel,
  nativeResponse,
  stringIds,
  type NativeKind,
  type NativeRow,
} from "./native-model";
import { RecordGrid } from "./record-grid";
import { RecordDetail } from "./record-detail";
import "./back-office.css";

type Client = LegalworkServerClient;
const linkedKey = (client: Client, state: BackOfficeState) => [
  "native-directory",
  client.baseUrl,
  state.directoryId,
  state.permissions.userId,
  state.permissions.replicaId,
];
export function useNativeRows(
  client: Client,
  state: BackOfficeState,
  kind: NativeKind,
  project: string,
  archived = false,
  enabled = true,
) {
  const cache = useQueryClient();
  useEffect(
    () =>
      onSyncPoke((p) => {
        if (p.tasks || p.projects || p.backOffice || p.resync)
          void cache.invalidateQueries(
            { queryKey: ["native-directory", client.baseUrl] },
            { cancelRefetch: false },
          );
      }),
    [cache, client.baseUrl],
  );
  return useQuery({
    queryKey: [...linkedKey(client, state), kind, project, archived],
    enabled,
    meta: { liveBackOffice: true },
    queryFn: async () =>
      nativeResponse.parse(
        await client.backOffice(
          `/native/${kind}?project=${encodeURIComponent(project)}&archived=${archived}`,
        ),
      ),
    refetchInterval: 30_000,
  });
}
function readViews(key: string): BackOfficeView[] {
  try {
    return z.array(BackOfficeViewSchema).parse(JSON.parse(localStorage.getItem(key) ?? "[]"));
  } catch {
    return [];
  }
}
export function NativeWorkspace({
  client,
  kind,
  project = "",
  children,
}: {
  client: Client;
  kind: NativeKind;
  project?: string;
  children?: ReactNode;
}) {
  const directory = useProjectBackOffice(client);
  if (!directory.data)
    return (
      <div className="bo-loading" role="status">
        {directory.error?.message ?? t("native.loading")} {children}
      </div>
    );
  return (
    <BackOfficeTheme>
      <RecordCreationProvider client={client} state={directory.data}>
        <NativeTable
          key={JSON.stringify([
            client.baseUrl,
            directory.data.directoryId,
            directory.data.permissions.userId,
            kind,
            project,
          ])}
          client={client}
          state={directory.data}
          kind={kind}
          project={project}
        >
          {children}
        </NativeTable>
      </RecordCreationProvider>
    </BackOfficeTheme>
  );
}
function NativeHistory({
  client,
  kind,
  row,
  workspace,
}: {
  client: Client;
  kind: NativeKind;
  row: NativeRow;
  workspace: string;
}) {
  const q = useQuery({
    queryKey: ["native-history", client.baseUrl, workspace, kind, row.sourceId, row.record.revision],
    meta: { liveBackOffice: true },
    gcTime: 0,
    queryFn: async () =>
      kind === "deadline"
        ? z
            .object({
              history: z.array(
                z.object({
                  revision: z.number(),
                  updatedAt: z.string(),
                  title: z.string(),
                  start: z.string().nullable(),
                  provenance: z.object({ kind: z.string(), reason: z.string().optional() }),
                }),
              ),
            })
            .parse(await client.calendarWrite(workspace, `/${row.sourceId}/history`, undefined, "GET"))
            .history.map((r) => ({
              key: String(r.revision),
              date: r.updatedAt,
              text: [r.title, r.start, r.provenance.reason].filter(Boolean).join(" · "),
            }))
        : (await client.getTask(workspace, row.sourceId)).notes.map((n) => ({
            key: n.id,
            date: n.createdAt,
            text: n.body,
          })),
  });
  return (
    <div className="bo-detail-fields">
      {q.error?.message ??
        (q.isPending
          ? t("calendar.loading")
          : q.data?.length
            ? q.data.map((r) => (
                <p key={r.key}>
                  <small>{new Date(r.date).toLocaleString()}</small>
                  <br />
                  {r.text}
                </p>
              ))
            : t("native.no_history"))}
    </div>
  );
}
export function NativeTable({
  client,
  state,
  kind,
  project = "",
  children,
}: {
  client: Client;
  state: BackOfficeState;
  kind: NativeKind;
  project?: string;
  children?: ReactNode;
}) {
  const cache = useQueryClient(),
    navigate = useNavigate(),
    [params] = useSearchParams(),
    locale = useLocale();
  const object = useMemo(() => nativeModel(kind), [kind, locale]),
    options = useMemo(() => choices(kind), [kind, locale]);
  const [archived, setArchived] = useState(false),
    [detail, setDetail] = useState<string | null>(params.get("record")),
    [width, setWidth] = useState(400);
  const [createdId, setCreatedId] = useState<string | null>(null);
  useEffect(() => setDetail(params.get("record")), [params.get("record")]);
  const q = useNativeRows(client, state, kind, project, archived);
  const refresh = () => cache.invalidateQueries({ queryKey: ["native-directory", client.baseUrl] });
  const [creating, setCreating] = useState(false),
    [projectId, setProject] = useState(project),
    [title, setTitle] = useState(""),
    [due, setDue] = useState(""),
    [creatingBusy, setCreatingBusy] = useState(false);
  const [reason, setReason] = useState(""),
    [decision, setDecision] = useState<{ title: string; reason: boolean; detail?: string } | null>(null);
  const resolver = useRef<((result: string | null) => void) | null>(null);
  useEffect(() => () => resolver.current?.(null), []);
  function finish(value: string | null) {
    resolver.current?.(value);
    resolver.current = null;
    setDecision(null);
  }
  function ask(title: string, reason: boolean, detail?: string) {
    resolver.current?.(null);
    setReason("");
    setDecision({ title, reason, detail });
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve;
    });
  }
  const viewKey = JSON.stringify([
    "native-views",
    client.baseUrl,
    state.directoryId,
    state.permissions.userId,
    kind,
  ]);
  const [views, setViews] = useState(() => readViews(viewKey).map((v) => ({ ...v, objectId: object.id })));
  const onSaveView = async (v: BackOfficeView) => {
    const list = [...readViews(viewKey).filter((entry) => entry.id !== v.id), { ...v, objectId: kind }];
    localStorage.setItem(viewKey, JSON.stringify(list));
    setViews(list.map((entry) => ({ ...entry, objectId: object.id })));
    return v;
  };
  const rows = q.isError ? [] : (q.data?.records ?? []);
  const toDisplay = (id: string, value: BackOfficeValue | undefined): BackOfficeValue => {
    if (id === "status" || id === "priority")
      return options[id].find((p) => p[0] === value)?.[1] ?? value ?? null;
    if (id === "assignee") return value ? "member:" + value : null;
    return value ?? null;
  };
  const toWire = (id: string, value: BackOfficeValue): BackOfficeValue => {
    if (id === "status" || id === "priority") return options[id].find((p) => p[1] === value)?.[0] ?? value;
    if (id === "assignee") return typeof value === "string" ? value.slice(7) : null;
    return value;
  };
  const displayed = rows.map(({ record }) => ({
    ...record,
    sourceId: record.sourceId,
    values: Object.fromEntries(Object.entries(record.values).map(([id, v]) => [id, toDisplay(id, v)])),
  }));
  const members = (q.data?.members ?? []).map((m) => ({
    id: "member:" + m.id,
    objectId: "@member",
    revision: 1,
    schemaRevision: 1,
    ownerId: "",
    members: [],
    access: "org" as const,
    createdAt: "",
    updatedAt: "",
    archivedAt: null,
    sourceId: undefined,
    values: { name: m.label },
  }));
  const records = [...displayed, ...members, ...state.records];
  const selected = displayed.find((r) => r.id === detail),
    selectedRow = rows.find((r) => r.record.id === detail);
  const post = (body: Record<string, unknown>) =>
    client.backOffice("/native/" + kind, {
      method: "POST",
      body: { ...body, directoryId: state.directoryId, userId: state.permissions.userId },
    });
  const [initialFields, setInitialFields] = useState<Record<string, BackOfficeValue>>({});
  const create = async (workspaceId: string, name: string, fields: Record<string, BackOfficeValue> = {}) => {
    const { id } = z.object({ id: z.string() }).parse(
      await post({
        action: "create",
        id: crypto.randomUUID(),
        workspaceId,
        fields: { ...fields, name },
      }),
    );
    setArchived(false);
    const key = kind + JSON.stringify([kind === "task" ? "" : workspaceId, id]);
    setCreatedId(key);
    setDetail(key);
    await refresh();
    setCreating(false);
  };
  const begin = (values?: Record<string, BackOfficeValue>) => {
    const fields = Object.fromEntries(
      Object.entries(values ?? {})
        .filter(([k]) => ["status", "priority", "assignee", "due"].includes(k))
        .map(([k, v]) => [k, toWire(k, v)]),
    );
    if (kind === "task") {
      void create(project, t("back_office.untitled"), fields).catch((e) => toast.error(e.message));
      return;
    }
    setInitialFields(fields);
    setProject(project || q.data?.projects[0]?.id || "");
    setDue(typeof values?.due === "string" ? values.due.slice(0, 10) : "");
    setTitle("");
    setCreating(true);
  };
  const save = async (
    record: BackOfficeRecord,
    patch: Record<string, BackOfficeValue>,
    archive?: boolean,
  ) => {
    const row = rows.find((r) => r.record.id === record.id);
    if (!row) throw Error(t("projects.reference.unavailable"));
    const id = row.sourceId,
      workspaceId = row.workspaceId;
    if (archive !== undefined) await post({ action: archive ? "archive" : "restore", id, workspaceId });
    else if ("linked" in patch) {
      const next = stringIds(patch.linked),
        prev = stringIds(record.values.linked);
      await linkRecords(
        client,
        state,
        kind,
        id,
        workspaceId,
        next.filter((i) => !prev.includes(i)),
        prev.filter((i) => !next.includes(i)),
      );
    } else {
      const fields = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, toWire(k, v)]));
      const expected = Object.fromEntries(
        Object.keys(fields).map((k) => [k, toWire(k, record.values[k] ?? null)]),
      );
      let override: string | null | undefined;
      if (row.calculated && ("due" in fields || "zone" in fields)) {
        override = await ask(t("native.override"), true);
        if (override === null) return;
      }
      const edit = () => post({ action: "edit", id, workspaceId, fields, expected, reason: override });
      try {
        await edit();
      } catch (e) {
        if (e instanceof LegalworkServerError && e.code === "override_reason_required") {
          // Another window may have attached a calculation after this editor opened.
          override = await ask(t("native.override"), true);
          if (override !== null) {
            await edit();
            await refresh();
          }
          return;
        }
        if (!(e instanceof LegalworkServerError) || e.code !== "native_field_conflict") throw e;
        const current = z.object({ value: z.unknown() }).parse(e.details);
        if (
          (await ask(
            t("back_office.conflict.title"),
            false,
            t("back_office.conflict.saved") +
              " · " +
              String(current.value ?? "∅") +
              "   " +
              t("back_office.conflict.yours") +
              " · " +
              Object.values(fields).join(", "),
          )) !== null
        ) {
          const field = Object.keys(fields)[0];
          expected[field] = Array.isArray(current.value)
            ? stringIds(current.value)
            : current.value == null
              ? null
              : String(current.value);
          await edit();
        }
      }
    }
    await refresh();
  };
  const open = (r: BackOfficeRecord) => {
    if (r.objectId === object.id) setDetail(r.id);
    else if (r.objectId !== "@member")
      navigate(`/back-office/${encodeURIComponent(r.objectId)}?record=${encodeURIComponent(r.id)}`);
  };
  return (
    <div
      className={`bo bo-native ${selected ? "bo-has-detail" : ""}`}
      style={{ "--bo-detail-width": width + "px" } as CSSProperties}
    >
      <header className="bo-object-header">
        <h1>{object.plural}</h1>
        <div className="bo-object-actions">
          {children}
          <Button
            size="sm"
            variant="solid"
            color="accent"
            startIcon={<Plus size={14} />}
            disabled={!q.data || (kind === "deadline" && !q.data.projects.length)}
            onClick={() => begin()}
          >
            {t("back_office.create.save")}
          </Button>
        </div>
      </header>
      {q.error ? (
        <p role="alert">{q.error.message}</p>
      ) : !q.data ? (
        <p className="bo-loading">{t("native.loading")}</p>
      ) : (
        <RecordGrid
          readOnlyFields={state.permissions.edit ? undefined : ["linked"]}
          key={object.id}
          object={object}
          records={records}
          views={views}
          editable
          finance
          userId={state.permissions.userId}
          onSave={save}
          onOpen={open}
          onCreate={begin}
          onSaveView={onSaveView}
          archived={archived}
          onArchivedChange={(v) => {
            setArchived(v);
            setDetail(null);
          }}
          lockedSchema
        />
      )}
      {selected && selectedRow && (
        <RecordDetail
          key={selected.id}
          client={client}
          team={state.scope !== "local"}
          historyAccessKey={state.directoryId ?? ""}
          object={object}
          record={selected}
          readOnlyFields={state.permissions.edit ? undefined : ["linked"]}
          records={records}
          editable
          finance
          userId={state.permissions.userId}
          width={width}
          onWidthChange={setWidth}
          onClose={() => setDetail(null)}
          onSave={save}
          onOpen={open}
          focusName={selected.id === createdId}
          nativeHistory={
            <NativeHistory
              client={client}
              kind={kind}
              row={selectedRow}
              workspace={selectedRow.workspaceId || q.data?.workspaceId || ""}
            />
          }
        />
      )}
      {creating && (
        <DirectoryDialog title={t("native.add_deadline")} onClose={() => setCreating(false)}>
          <form
            className="bo-form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (creatingBusy) return;
              setCreatingBusy(true);
              try {
                await create(projectId, title, {
                  ...initialFields,
                  due,
                  zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                });
              } catch (err) {
                toast.error(err instanceof Error ? err.message : t("back_office.create.failed"));
              } finally {
                setCreatingBusy(false);
              }
            }}
          >
            <label>
              {t("native.title")}
              <Input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <label>
              {t("native.project")}
              <DirectorySelect
                value={projectId}
                onChange={setProject}
                label={t("native.project")}
                disabled={!!project}
                options={(q.data?.projects ?? []).map((p) => ({ value: p.id, label: p.name }))}
              />
            </label>
            <label>
              {t("native.due")}
              <Input required type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </label>
            <Button type="submit" disabled={creatingBusy || !projectId || !title.trim() || !due}>
              {t("back_office.create.save")}
            </Button>
          </form>
        </DirectoryDialog>
      )}
      {decision && (
        <DirectoryDialog title={decision.title} onClose={() => finish(null)}>
          <form
            className="bo-form"
            onSubmit={(e) => {
              e.preventDefault();
              finish(reason.trim());
            }}
          >
            {decision.reason ? (
              <label>
                {t("calendar.override_reason")}
                <Input autoFocus required value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
            ) : (
              <p>{decision.detail}</p>
            )}
            <div className="bo-modal-footer">
              <Button type="button" size="sm" onClick={() => finish(null)}>
                {t("projects.cancel")}
              </Button>
              <Button type="submit" size="sm" disabled={decision.reason && !reason.trim()}>
                {t("common.save")}
              </Button>
            </div>
          </form>
        </DirectoryDialog>
      )}
    </div>
  );
}
