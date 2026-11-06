import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { t } from "@/i18n";

export function ConnectionMethodPicker({ name, onCustom, disabled }: { name: string; onCustom: () => void; disabled?: boolean }) {
  return <Field>
    <FieldLabel htmlFor="provider-connection-method">{t("connectors.method")}</FieldLabel>
    <Select value="legalwork" disabled={disabled} onValueChange={value => { if (value === "custom") onCustom(); }}>
      <SelectTrigger id="provider-connection-method" className="w-full"><SelectValue>{t("catalog.connect_with_app")}</SelectValue></SelectTrigger>
      <SelectContent><SelectItem value="legalwork">{t("catalog.connect_with_app")}</SelectItem><SelectItem value="custom">{t("catalog.custom_provider", { name })}</SelectItem></SelectContent>
    </Select>
  </Field>;
}
