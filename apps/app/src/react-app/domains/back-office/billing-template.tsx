import { useState } from "react";
import { Button } from "twenty-ui/primitives/input";
import { standardInvoice } from "@legalwork/types/invoice-template";
import { t } from "@/i18n";
import { useBillingAction, type BillingProps } from "./billing-components";

export function BillingTemplate({ state, onCommand }: BillingProps) {
  const [template, setTemplate] = useState(state.template ?? standardInvoice);
  const { send, pending, error } = useBillingAction(onCommand);
  return (
    <details className="bo-invoice-template">
      <summary>{t("timesheets.template")}</summary>
      <form
        className="bo-billing-rules"
        onSubmit={(e) => {
          e.preventDefault();
          void send({ type: "template", template }).catch(() => {});
        }}
      >
        <label>
          {t("timesheets.template_title")}{" "}
          <input
            required
            maxLength={100}
            value={template.title}
            onChange={(e) => setTemplate({ ...template, title: e.target.value })}
          />
        </label>
        <label>
          {t("timesheets.document_language")}{" "}
          <select
            value={template.locale}
            onChange={(e) =>
              setTemplate({ ...template, locale: e.target.value === "de-AT" ? "de-AT" : "en-GB" })
            }
          >
            <option value="de-AT">Deutsch</option>
            <option value="en-GB">English</option>
          </select>
        </label>
        <label>
          {t("timesheets.letterhead")}{" "}
          <textarea
            maxLength={1800}
            value={template.letterhead}
            onChange={(e) => setTemplate({ ...template, letterhead: e.target.value })}
          />
        </label>
        <label>
          {t("timesheets.footer")}{" "}
          <textarea
            maxLength={3000}
            value={template.footer}
            onChange={(e) => setTemplate({ ...template, footer: e.target.value })}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <Button type="submit" size="sm" disabled={pending}>
          {t("timesheets.template_save")}
        </Button>
      </form>
    </details>
  );
}
