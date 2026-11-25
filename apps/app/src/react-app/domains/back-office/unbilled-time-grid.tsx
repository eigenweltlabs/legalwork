import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { History } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { t } from "@/i18n";
import { BackOfficeFieldSchema, backOfficeMoneyFromMinor, type BackOfficeRecord } from "@legalwork/types/back-office";
import { currencyScale, timeFeeMinor } from "@legalwork/types/invoice-template";
import { hasTimeEntryPrice, type TimeEntry } from "@legalwork/types/timesheet";
import type { BackOfficeState } from "./api";
import { displayBackOfficeObject } from "./labels";
import { RecordGrid, type SaveBackOfficeView } from "./record-grid";
import { timeRoutes } from "./time-routes";
import { TimeSelect } from "./time-settings-controls";

type BillingRow = {
  entry: TimeEntry;
  priced: TimeEntry;
  invoiceable: boolean;
  canReview: boolean;
  fixed: boolean;
  status: string;
  matter: string;
  timekeeper: string;
  clients: { id: string; name: string }[];
};

export function UnbilledTimeGrid({ directory, rows, columnScope, onInvoice, onHistory, onSaveView, onAssignClient, pending, selectionActions }: {
  directory: BackOfficeState;
  rows: BillingRow[];
  columnScope: string;
  onInvoice: (entry: TimeEntry) => void;
  onHistory: (entry: TimeEntry) => void;
  onSaveView: SaveBackOfficeView;
  onAssignClient: (entry: TimeEntry, clientId: string) => void;
  pending: boolean;
  selectionActions: (records: BackOfficeRecord[], clear: () => void) => ReactNode;
}) {
  const model = directory.model.objects.find(object => object.id === "timeEntries" && !object.archived);
  if (!model) return <p className="bo-billing-notice" role="status">{t("timesheets.unavailable")}</p>;

  const columns = ["name", "status", "billingAction", "matter", "billableMinutes", "fees"];
  const title = t("invoiceReview.unbilled_time");
  const object = {
    ...displayBackOfficeObject(model), label: title, plural: title,
    fields: [
      BackOfficeFieldSchema.parse({ id: "name", type: "text", label: t("native.description") }),
      BackOfficeFieldSchema.parse({ id: "matter", type: "text", label: t("back_office.billing.matter") }),
      BackOfficeFieldSchema.parse({ id: "timekeeper", type: "text", label: t("timesheets.ledger.workers") }),
      BackOfficeFieldSchema.parse({ id: "startedAt", type: "date", label: t("timesheets.ledger.date") }),
      BackOfficeFieldSchema.parse({ id: "status", type: "text", label: t("invoiceReview.status") }),
      BackOfficeFieldSchema.parse({ id: "billableMinutes", type: "number", label: t("timesheets.ledger.billable") }),
      BackOfficeFieldSchema.parse({ id: "fees", type: "currency", label: t("back_office.billing.fees") }),
      BackOfficeFieldSchema.parse({ id: "billingAction", type: "text", label: t("settings.environment.table_actions") }),
    ],
  };
  const byId = new Map(rows.map(row => [row.entry.id, row]));
  const cached = new Map(directory.records.filter(record => record.objectId === model.id).map(record => [record.id, record]));
  const records: BackOfficeRecord[] = rows.map(({ entry, priced, invoiceable, fixed, status, matter, timekeeper }) => {
    const original = cached.get(entry.id);
    let fees = null;
    if (invoiceable && !fixed && hasTimeEntryPrice(priced)) {
      const scale = currencyScale(priced.currency);
      fees = backOfficeMoneyFromMinor(timeFeeMinor(priced.billableMinutes, priced.hourlyRate, scale), priced.currency, scale);
    }
    return {
      id: entry.id, objectId: model.id, ownerId: entry.workerId, revision: entry.revision,
      schemaRevision: directory.model.revision, access: "members", members: [], sourceId: original?.sourceId,
      createdAt: original?.createdAt ?? entry.date + "T00:00:00Z",
      updatedAt: original?.updatedAt ?? entry.date + "T00:00:00Z", archivedAt: null,
      values: {
        name: entry.narrative, startedAt: entry.date, matter, timekeeper, status, billableMinutes: priced.billableMinutes, fees,
      },
    };
  });
  return <RecordGrid object={object} records={records} views={[]} finance userId={directory.permissions.userId}
    editable={false} archived={false} lockedSchema columnScope={columnScope}
    sheet={{ blankId: "", columns, widths: { name: 205, matter: 150, timekeeper: 116, status: 174, billableMinutes: 76, fees: 86, billingAction: 150 } }}
    onCreate={() => {}} onSave={async () => {}} onSaveView={onSaveView}
    selectionActions={selectionActions}
    onOpen={record => { const row = byId.get(record.id); if (row) onHistory(row.entry); }}
    renderCell={(record, field) => {
      const row = byId.get(record.id);
      if (!row) return;
      if (field.id === "fees" && row.invoiceable && row.fixed) return t("invoiceReview.fixed_agreement");
      if (field.id !== "billingAction") return;
      const { entry } = row;
      return <div className="flex items-center gap-1">
        {row.clients.length ? <TimeSelect label={t("timesheets.sheet.bill_to")} value="" disabled={pending}
          placeholder={t("timesheets.sheet.bill_to")} options={row.clients} onChange={clientId => onAssignClient(entry, clientId)} />
          : row.canReview ? <Link className={buttonVariants({ size: "xs", variant: "outline" })}
          to={timeRoutes["billing-review"] + "?date=" + entry.date}>{t("back_office.billing.detail")}</Link>
          : row.invoiceable ? <Button size="xs" variant="outline" onClick={() => onInvoice(entry)}>
            {t("invoiceReview.invoice_entry")}</Button>
          : entry.status === "confirmed" && entry.workerId === directory.permissions.userId &&
            <Link className={buttonVariants({ size: "xs", variant: "outline" })} state={{ timeWorkspaceTab: "entries" }}
              to={timeRoutes.timesheets + "?date=" + entry.date}>{t("back_office.timeEntries.plural")}</Link>}
        <Button size="icon-xs" variant="ghost" aria-label={t("timesheets.ledger.history")}
          title={t("timesheets.ledger.history")} onClick={() => onHistory(entry)}><History /></Button>
      </div>;
    }}
  />;
}
