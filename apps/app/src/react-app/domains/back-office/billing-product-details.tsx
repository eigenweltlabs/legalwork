import { productTypeKeys } from "./timesheet-labels";
import { useState } from "react";
import { workProductTypes, type TimesheetState } from "@legalwork/types/timesheet";
import { currentLocale, t } from "@/i18n";
import { useBillingAction, type BillingProps } from "./billing-components";

type Product = TimesheetState["products"][number];
export function BillingProductDetails({
  product,
  state,
  onCommand,
}: BillingProps & { product: Product }) {
  const [kind, setKind] = useState<Product["productType"]>(product.productType);
  const [reference, setReference] = useState(product.reference ?? "");
  const { send, pending, error } = useBillingAction(onCommand);
  const changed = kind !== product.productType || reference.trim() !== (product.reference ?? "");
  const author = state.people.find((person) => person.id === product.authorId)?.name ?? product.authorId;
  return (
    <div className="bo-billing-subrow">
      {product.createdAt && (
        <small>
          {t("back_office.billing.product_created", {
            date: new Date(product.createdAt).toLocaleDateString(currentLocale()),
            author: author ?? "",
          })}
        </small>
      )}
      <label>
        {t("back_office.billing.product_type")}
        <select
          disabled={!state.canManage || pending}
          value={kind ?? "document"}
          onChange={(e) => {
            const next = workProductTypes.find((value) => value === e.target.value);
            if (next) setKind(next);
          }}
        >
          {workProductTypes.map((value) => (
            <option key={value} value={value}>
              {t(productTypeKeys[value])}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("back_office.billing.product_reference")}
        <input
          value={reference}
          readOnly={!state.canManage || pending}
          maxLength={1000}
          onChange={(e) => setReference(e.target.value)}
        />
      </label>
      {changed && state.canManage && (
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            void send({
              type: "productDetails",
              id: product.id,
              expectedType: product.productType,
              expectedReference: product.reference,
              productType: kind ?? "document",
              reference,
            }).catch(() => {})
          }
        >
          {t("back_office.billing.save_product")}
        </button>
      )}
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
