import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Bot,
  ChevronDown,
  Download,
  ShieldCheck,
} from "lucide-react";
import { Button } from "twenty-ui/primitives/input";
import { Avatar } from "twenty-ui/primitives/data-display";
import { Popover } from "twenty-ui/primitives/surfaces";
import {
  BackOfficeHistoryPageSchema,
  BackOfficeHistoryExportSchema,
  BackOfficeStoredRecordSchema,
  BackOfficeFilesSchema,
  canonicalBackOfficeAudit,
  BACK_OFFICE_AUDIT_EMPTY_STATE,
  type BackOfficeHistoryItem,
  type BackOfficeHistoryTarget,
  type BackOfficeField,
  type BackOfficeRecord,
  type BackOfficeValue,
  type BackOfficeFile,
} from "@legalwork/types/back-office";
import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import { useLocale } from "@/i18n/use-locale";
import { ValueDisplay } from "./record-values";

function HistoryValue({
  value,
  field,
  records,
  onOpen,
  hidden = false,
  onDownload,
}: {
  value: BackOfficeValue | undefined;
  field: BackOfficeField;
  records: BackOfficeRecord[];
  onOpen: (record: BackOfficeRecord) => void;
  hidden?: boolean;
  onDownload?: (file: BackOfficeFile) => void;
}) {
  if (hidden)
    return (
      <span className="bo-muted">{t("back_office.history.hidden_value")}</span>
    );
  if (value === undefined || value === null || value === "")
    return (
      <span className="bo-muted">{t("back_office.history.empty_value")}</span>
    );
  if (field.type === "file") {
    const files = BackOfficeFilesSchema.safeParse(value);
    if (files.success && files.data.length === 0)
      return <span className="bo-muted">{t("back_office.history.empty_value")}</span>;
    return files.success ? (
      <span>{files.data.map(file => onDownload ? <Button key={file.id} size="sm" variant="ghost" startIcon={<Download size={12} />} onClick={() => onDownload(file)}>{file.name}</Button> : <span key={file.id}>{file.name}</span>)}</span>
    ) : null;
  }
  return (
    <ValueDisplay
      field={field}
      value={value}
      records={records}
      onOpen={onOpen}
    />
  );
}

function historyAction(
  item: BackOfficeHistoryItem,
  before: { archivedAt: string | null } | null,
  after: { archivedAt: string | null } | null,
  projectLink: boolean,
) {
  if (item.action.startsWith("baseline."))
    return t("back_office.history.baseline");
  if (projectLink) {
    if (!after || after.archivedAt)
      return t("back_office.history.project_unlinked");
    if (
      item.proof.beforeHash === BACK_OFFICE_AUDIT_EMPTY_STATE ||
      before?.archivedAt
    )
      return t("back_office.history.project_linked");
    return t("back_office.history.project_changed");
  }
  if (
    item.proof.entityType === "record" &&
    item.proof.beforeHash === BACK_OFFICE_AUDIT_EMPTY_STATE
  )
    return t("back_office.history.created");
  if (before && after && !before.archivedAt && after.archivedAt)
    return t("back_office.history.archived");
  if (before && after && before.archivedAt && !after.archivedAt)
    return t("back_office.history.restored");
  return t("back_office.history.changed");
}

function HistoryEntry({
  item,
  records,
  userId,
  onOpen,
  onDownload,
}: {
  item: BackOfficeHistoryItem;
  records: BackOfficeRecord[];
  userId: string;
  onOpen: (record: BackOfficeRecord) => void;
  onDownload?: (file: BackOfficeFile, eventId: string) => void;
}) {
  const [details, setDetails] = useState(false);
  const old = BackOfficeStoredRecordSchema.safeParse(item.before),
    next = BackOfficeStoredRecordSchema.safeParse(item.after);
  const before = old.success ? old.data : null,
    after = next.success ? next.data : null;
  const projectLink =
    before?.objectId === "projectLinks" || after?.objectId === "projectLinks";
  const fields = new Map(
    [...item.beforeFields, ...item.afterFields].map((field) => [
      field.id,
      field,
    ]),
  );
  const changed = [...fields.values()].filter(
    (field) =>
      canonicalBackOfficeAudit(before?.values[field.id] ?? null) !==
      canonicalBackOfficeAudit(after?.values[field.id] ?? null),
  );
  const actor =
    item.actor.kind === "system"
      ? t("back_office.history.system")
      : item.actor.id === userId ||
          (userId === "local" &&
            item.actor.identitySource === "operating-system")
        ? t("back_office.history.you")
        : (item.actor.name ?? item.actor.id);
  const baseline = item.action.startsWith("baseline.");
  const action = historyAction(item, before, after, projectLink);
  return (
    <article className="bo-history-entry">
      <div className="bo-history-entry-heading">
        <Avatar size="sm" name={actor} colorSeed={item.actor.id} />
        <div>
          <div>
            <strong>{actor}</strong> <span className="bo-muted">{action}</span>
            {item.actor.kind === "agent" && (
              <Bot size={13} aria-label={t("back_office.history.agent")} />
            )}
          </div>
          <time dateTime={item.recordedAt}>
            {new Date(item.recordedAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </time>
        </div>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("back_office.history.entry_details")}
          aria-expanded={details}
          onClick={() => setDetails(!details)}
          startIcon={
            <ChevronDown
              size={13}
              style={{ transform: details ? "rotate(180deg)" : undefined }}
            />
          }
        />
      </div>
      {baseline && (
        <p className="bo-history-note">
          {t("back_office.history.baseline_hint")}
        </p>
      )}
      <div className="bo-history-changes">
        {projectLink && (
          <p className="bo-history-note">
            {String(after?.values.name ?? before?.values.name ?? "")}
          </p>
        )}
        {!projectLink &&
          changed.map((field) => (
            <div className="bo-history-change" key={field.id}>
              <span className="bo-history-field">{field.label}</span>
              <div className="bo-history-values">
                <div
                  className="bo-history-old"
                  aria-label={t("back_office.history.before")}
                >
                  <HistoryValue
                    onDownload={onDownload ? file => onDownload(file, item.eventId) : undefined}
                    field={
                      item.beforeFields.find((old) => old.id === field.id) ??
                      field
                    }
                    value={before?.values[field.id]}
                    hidden={
                      item.redacted &&
                      !item.beforeFields.some((old) => old.id === field.id)
                    }
                    records={records}
                    onOpen={onOpen}
                  />
                </div>
                <ArrowRight size={12} />
                <div aria-label={t("back_office.history.after")}>
                  <HistoryValue
                    onDownload={onDownload ? file => onDownload(file, item.eventId) : undefined}
                    field={field}
                    value={after?.values[field.id]}
                    hidden={
                      item.redacted &&
                      !item.afterFields.some((next) => next.id === field.id)
                    }
                    records={records}
                    onOpen={onOpen}
                  />
                </div>
              </div>
            </div>
          ))}
        {before &&
          after &&
          (before.access !== after.access ||
            JSON.stringify(before.members) !==
              JSON.stringify(after.members)) && (
            <p className="bo-history-note">
              {t("back_office.history.access_changed")}
            </p>
          )}
        {!projectLink && !changed.length && !baseline && (
          <p className="bo-history-note">
            {t("back_office.history.details_recorded")}
          </p>
        )}
      </div>
      {item.redacted && (
        <p className="bo-history-note">{t("back_office.history.redacted")}</p>
      )}
      {details && (
        <dl className="bo-history-proof">
          <dt>{t("back_office.history.entry")}</dt>
          <dd>{item.proof.sequence}</dd>
          <dt>{t("back_office.history.schema")}</dt>
          <dd>{item.modelRevision}</dd>
          <dt>{t("back_office.history.author_source")}</dt>
          <dd>
            {item.actor.identitySource === "platform"
              ? t("back_office.history.authenticated")
              : item.actor.identitySource === "account-cache"
                ? t("back_office.history.cached_account")
                : item.actor.identitySource === "migration"
                  ? t("back_office.history.migration")
                  : t("back_office.history.device_account")}
          </dd>
          {item.actor.agentId && (
            <>
              <dt>{t("back_office.history.agent")}</dt>
              <dd>{item.actor.agentId}</dd>
            </>
          )}
          <dt>{t("back_office.history.fingerprint")}</dt>
          <dd title={item.proof.hash}>{item.proof.hash}</dd>
        </dl>
      )}
    </article>
  );
}

export function HistoryEntries({
  items,
  records,
  userId,
  onOpen,
  onDownload,
}: {
  items: BackOfficeHistoryItem[];
  records: BackOfficeRecord[];
  userId: string;
  onOpen: (record: BackOfficeRecord) => void;
  onDownload?: (file: BackOfficeFile, eventId: string) => void;
}) {
  useLocale();
  return (
    <div className="bo-history-entries">
      {items.map((item) => (
        <HistoryEntry
          key={item.eventId}
          item={item}
          records={records}
          userId={userId}
          onOpen={onOpen}
          onDownload={onDownload}
        />
      ))}
    </div>
  );
}

export function HistoryPanel({
  client,
  team,
  target,
  revision,
  accessKey,
  records,
  userId,
  onOpen,
}: {
  client: Pick<LegalworkServerClient, "baseUrl" | "backOffice"> & Partial<Pick<LegalworkServerClient, "downloadBackOfficeFile">>;
  team: boolean;
  target: BackOfficeHistoryTarget;
  revision: number;
  accessKey: string;
  records: BackOfficeRecord[];
  userId: string;
  onOpen: (record: BackOfficeRecord) => void;
}) {
  useLocale();
  const [exporting, setExporting] = useState(false),
    [error, setError] = useState("");
  const path = `/history/${target.type}/${encodeURIComponent(target.id)}`;
  const query = useInfiniteQuery({
    queryKey: [
      "back-office-history",
      client.baseUrl,
      team,
      target.type,
      target.id,
      revision,
      accessKey,
    ],
    initialPageParam: null,
    queryFn: async ({ pageParam }: { pageParam: string | null }) =>
      BackOfficeHistoryPageSchema.parse(
        await client.backOffice(
          `${path}?limit=30${pageParam ? `&cursor=${pageParam}` : ""}`,
          { team },
        ),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    gcTime: 0,
    staleTime: 0,
    refetchInterval: 30_000,
    retry: false,
  });
  const page = query.isError ? undefined : query.data?.pages[0];
  const exportHistory = async () => {
    setExporting(true);
    setError("");
    try {
      const exported = BackOfficeHistoryExportSchema.parse(
        await client.backOffice(`${path}/export`, { team }),
      );
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(exported, null, 2)], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `legalwork-${target.type}-${target.id}-history.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : t("back_office.history.export_failed"),
      );
    } finally {
      setExporting(false);
    }
  };
  return (
    <section className="bo-history" aria-label={t("back_office.history.tab")}>
      <div className="bo-history-toolbar">
        <Popover.Root>
          <Popover.Trigger
            render={
              <Button
                size="sm"
                variant="ghost"
                startIcon={<ShieldCheck size={14} />}
                disabled={!page}
              />
            }
          >
            {t("back_office.history.verification")}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner align="start" sideOffset={5}>
              <Popover.Popup className="bo-history-verification">
                <strong>
                  {page?.source === "platform"
                    ? t("back_office.history.platform_verified")
                    : t("back_office.history.local_verified")}
                </strong>
                <p>
                  {page?.independentlyAcknowledged
                    ? t("back_office.history.acknowledged")
                    : t("back_office.history.not_acknowledged")}
                </p>
                <p>{t("back_office.history.verification_hint")}</p>
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
        <Button
          size="sm"
          variant="outline"
          disabled={!page || exporting}
          onClick={() => void exportHistory()}
          startIcon={<Download size={13} />}
        >
          {exporting
            ? t("back_office.history.exporting")
            : t("back_office.history.export")}
        </Button>
      </div>
      {(query.isError || error) && (
        <div className="bo-history-empty" role="alert">
          <p>
            {error ||
              (query.error instanceof Error
                ? query.error.message
                : t("back_office.history.unavailable"))}
          </p>
        </div>
      )}
      {query.isPending && (
        <p className="bo-history-empty">{t("back_office.history.loading")}</p>
      )}
      {page && (
        <>
          <HistoryEntries
            items={query.data?.pages.flatMap((page) => page.items) ?? []}
            records={records}
            userId={userId}
            onOpen={onOpen}
            onDownload={client.downloadBackOfficeFile ? async (file, eventId) => {
              try {
                const result = await client.downloadBackOfficeFile!(file.recordId, file.fieldId, file.id, { team, eventId });
                const url = URL.createObjectURL(new Blob([result.data], { type: file.contentType }));
                const link = document.createElement("a");
                link.href = url; link.download = file.name; link.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              } catch (error) { setError(error instanceof Error ? error.message : t("back_office.files.failed")); }
            } : undefined}
          />
          {!page.items.length && (
            <p className="bo-history-empty">{t("back_office.history.empty")}</p>
          )}
          {query.hasNextPage && (
            <Button
              size="sm"
              variant="ghost"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {t("back_office.history.more")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
