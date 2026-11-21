import { Fragment, useState } from "react";
import { t } from "@/i18n";
import type { TimeEntry } from "@legalwork/types/timesheet";
import { feeSummary, type BillingProps } from "./billing-components";
import { adjustedTimeEntry } from "@legalwork/types/timesheet";
import { BillingProductDetails } from "./billing-product-details";
import { BillingEditCell } from "./billing-edit-cell";

type Group = "workProductId" | "clientId" | "matterId" | "workerId";
export function BillingCosts({ rows, state, onCommand }: BillingProps & { rows: TimeEntry[] }) {
  const [group, setGroup] = useState<Group>("workProductId");
  const [expand, setExpand] = useState("");
  const labels = {
    workProductId: "back_office.billing.work_product",
    clientId: "back_office.billing.client",
    matterId: "back_office.billing.matter",
    workerId: "back_office.billing.worker",
  };
  const grouped = new Map<string, TimeEntry[]>();
  const entityNames = new Map(
    {
      workProductId: state.products,
      clientId: state.clients,
      matterId: state.matters,
      workerId: state.people,
    }[group].map((v) => [v.id, v.name]),
  );
  for (const row of rows.filter((r) => !["declined", "pending"].includes(r.status))) {
    const id = row[group] || "";
    const list = grouped.get(id);
    if (list) list.push(row);
    else grouped.set(id, [row]);
  }
  return (
    <>
      <div className="bo-view-toolbar">
        <label>
          {t("back_office.billing.group_by")}
          <select
            value={group}
            onChange={(e) => {
              const key = (["workProductId", "clientId", "matterId", "workerId"] as const).find(
                (g) => g === e.target.value,
              );
              if (key) {
                setGroup(key);
                setExpand("");
              }
            }}
          >
            {Object.entries(labels).map(([key, name]) => (
              <option key={key} value={key}>
                {t(name)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="bo-billing-body">
        <table>
          <thead>
            <tr>
              {[labels[group], "back_office.billing.worked", "back_office.billing.charge", "back_office.billing.fees", "back_office.billing.approved", "back_office.billing.invoiced"].map((key) => (
                <th key={key}>{t(key)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...grouped].map(([key, list]) => {
              const net = list.map((line) => adjustedTimeEntry(line, state.adjustments));
              const approved = net.filter((r) => r.status === "approved" || r.status === "invoiced");
              const billed = net.filter((r) => r.status === "invoiced");
              const name = entityNames.get(key) || key || t("back_office.billing.unassigned");
              const label = key || "_none";
              const product =
                group === "workProductId" ? state.products.find((p) => p.id === key) : undefined;
              return (
                <Fragment key={label}>
                  <tr>
                    <td>
                      <button
                        type="button"
                        aria-expanded={expand === label}
                        onClick={() => setExpand(expand === label ? "" : label)}
                      >
                        {name}
                      </button>
                      {group === "workProductId" && key && (
                        <small className="bo-billing-muted">
                          {" "}
                          · {state.matters.find((m) => m.id === list[0].matterId)?.name}
                        </small>
                      )}
                    </td>
                    <td>{list.reduce((n, r) => n + r.workedMinutes, 0)}</td>
                    <td>{net.reduce((n, r) => n + r.billableMinutes, 0)}</td>
                    <td>{feeSummary(net)}</td>
                    <td>{feeSummary(approved)}</td>
                    <td>{feeSummary(billed)}</td>
                  </tr>
                  {expand === label && product && (
                    <tr>
                      <td colSpan={6}>
                        {state.canManage && (
                          <div className="bo-billing-subrow">
                            <small>{t("back_office.billing.rename_product")}</small>
                            <BillingEditCell
                              label={t("back_office.billing.rename_product")}
                              value={name}
                              onSave={(next) =>
                                onCommand({
                                  type: "renameProduct",
                                  id: key,
                                  expectedName: name,
                                  name: next,
                                }).then(() => undefined)
                              }
                            />
                          </div>
                        )}
                        <BillingProductDetails
                          key={JSON.stringify([product.id, product.productType, product.reference])}
                          product={product}
                          state={state}
                          onCommand={onCommand}
                        />
                      </td>
                    </tr>
                  )}
                  {expand === label &&
                    net.map((e) => (
                      <tr key={e.id}>
                        <td>
                          {e.date} · {state.people.find((p) => p.id === e.workerId)?.name ?? e.workerId}
                        </td>
                        <td>{e.workedMinutes}</td>
                        <td>{e.billableMinutes}</td>
                        <td>{feeSummary([e])}</td>
                        <td colSpan={2}>
                          {e.activity} · {e.narrative}
                        </td>
                      </tr>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {!grouped.size && <p className="bo-billing-notice">{t("back_office.billing.no_entries")}</p>}
      </div>
    </>
  );
}
