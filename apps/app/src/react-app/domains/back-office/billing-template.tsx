import { BillingWordTemplate, type PreviewTemplate } from "./billing-word-template";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TimeSelect } from "./time-settings-controls";
import { SectionHeading, Surface } from "../../design-system/surface";
import { standardInvoice } from "@legalwork/types/invoice-template";
import { t } from "@/i18n";
import { useBillingAction, type BillingProps } from "./billing-components";

export function BillingTemplate({ state, onCommand, accountScope, previewWord }: BillingProps & {accountScope?:string;previewWord?:PreviewTemplate}) {
  const [template, setTemplate] = useState(state.template ?? standardInvoice);
  const { send, pending, error } = useBillingAction(onCommand);
  return (
    <section className="flex flex-col gap-4">
      <SectionHeading title={t("timesheets.template")} />
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void send({ type: "template", template }).catch(() => {});
        }}
      >
        <Surface className="grid gap-4 p-4 sm:grid-cols-2">
          <label className="grid gap-2 text-sm">
            {t("timesheets.template_title")}
            <Input
              required
              maxLength={100}
              value={template.title}
              onChange={(e) => setTemplate({ ...template, title: e.target.value })}
            />
          </label>
          <label className="grid gap-2 text-sm">
            {t("timesheets.document_language")}
            <TimeSelect label={t("timesheets.document_language")} value={template.locale}
              options={[{ id: "de-AT", name: "Deutsch" }, { id: "en-GB", name: "English" }]}
              onChange={value => setTemplate({ ...template, locale: value === "de-AT" ? "de-AT" : "en-GB" })} />
          </label>
          <label className="grid gap-2 text-sm">
            {t("timesheets.letterhead")}
            <Textarea
              maxLength={1800}
              value={template.letterhead}
              onChange={(e) => setTemplate({ ...template, letterhead: e.target.value })}
            />
          </label>
          <label className="grid gap-2 text-sm">
            {t("timesheets.footer")}
            <Textarea
              maxLength={3000}
              value={template.footer}
              onChange={(e) => setTemplate({ ...template, footer: e.target.value })}
            />
          </label>
        </Surface>
        {state.supportsInvoiceDrafts && <Surface className="p-4"><BillingWordTemplate previewWord={previewWord} template={template} onChange={setTemplate} account={accountScope ?? (state.scope+"/"+state.userId)} /></Surface>}
        {error && <p role="alert">{error}</p>}
        <Button type="submit" size="sm" className="self-end" disabled={pending}>
          {t("timesheets.template_save")}
        </Button>
      </form>
    </section>
  );
}
