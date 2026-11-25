import { useId, useState, type ReactNode, type Ref } from "react";
import { Autocomplete, AutocompleteEmpty, AutocompleteInput, AutocompleteItem, AutocompleteList, AutocompletePopup } from "@/components/ui/autocomplete";
import { t } from "@/i18n";
import { Switch } from "@/components/ui/switch";
import { Select, SelectTrigger, SelectContent, SelectValue, SelectItem } from "@/components/ui/select";
import { Surface } from "../../design-system/surface";
import {
  LayoutSection,
  LayoutSectionHeader,
  LayoutSectionItem,
  LayoutSectionItemDescription,
  LayoutSectionItemHeader,
  LayoutSectionItemHeaderActions,
  LayoutSectionItemTitle,
  LayoutSectionTitle,
} from "../settings/settings-layout";

export function TimeSettingsGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <LayoutSection>
      {title && (
        <LayoutSectionHeader>
          <LayoutSectionTitle>{title}</LayoutSectionTitle>
        </LayoutSectionHeader>
      )}
      <Surface className="divide-y divide-border/70 overflow-hidden">{children}</Surface>
    </LayoutSection>
  );
}

export function TimeSetting({
  title,
  description,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <LayoutSectionItem>
      <LayoutSectionItemHeader>
        <LayoutSectionItemTitle>{title}</LayoutSectionItemTitle>
        {description && <LayoutSectionItemDescription>{description}</LayoutSectionItemDescription>}
        <LayoutSectionItemHeaderActions>{children}</LayoutSectionItemHeaderActions>
      </LayoutSectionItemHeader>
    </LayoutSectionItem>
  );
}

export function TimeSwitch({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <TimeSetting title={<label htmlFor={id}>{label}</label>} description={description}>
      <Switch id={id} aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </TimeSetting>
  );
}

export function TimeSelect({
  id,
  triggerRef,
  errorId,
  modal,
  placeholder,
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  id?: string;
  triggerRef?: Ref<HTMLButtonElement>;
  errorId?: string;
  modal?: boolean;
  placeholder?: string;
  label: string;
  value: string;
  options: { id: string; name: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const choices = options.map(({ id, name }) => ({ value: id, label: name }));
  return (
    <Select
      modal={modal}
      items={choices}
      value={value || (placeholder ? null : value)}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger ref={triggerRef} aria-invalid={errorId ? true : undefined} aria-describedby={errorId} id={id} aria-label={label} className="min-w-0 max-w-full">
        <SelectValue placeholder={placeholder} className="min-w-0 truncate" />
      </SelectTrigger>
      <SelectContent align="start" className="w-max min-w-(--anchor-width) max-w-[min(32rem,var(--available-width))] max-h-[min(20rem,var(--available-height))]">
        {choices.map((choice) => (
          <SelectItem key={choice.value} value={choice.value} textClassName="block min-w-0 shrink whitespace-normal [overflow-wrap:anywhere]">
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Search names and references while keeping record IDs as the only committed values. */
export function TimeRecordPicker({ id, errorId, label, value, options, placeholder, disabled, onChange, inputRef }: {
  id?: string;
  errorId?: string;
  label: string;
  value: string;
  options: { id: string; name: string; reference?: string | null }[];
  placeholder: string;
  disabled?: boolean;
  onChange: (id: string) => void;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const [query, setQuery] = useState<string | null>(null);
  const optionsById = new Map(options.map(option => [option.id, option]));
  const selected = optionsById.get(value);
  const search = query?.trim().toLocaleLowerCase() ?? "";
  const matches = options.filter(option => (option.name + " " + (option.reference ?? "")).toLocaleLowerCase().includes(search));
  return <Autocomplete items={matches.map(option => option.id)} openOnInputClick autoHighlight disabled={disabled} filter={null}
    value={query ?? selected?.name ?? ""} onOpenChange={open => { if (!open) setQuery(null); }}
    onValueChange={(next, details) => {
      if (details.reason === "item-press") { onChange(next); setQuery(null); }
      else if (details.reason === "input-change" || details.reason === "input-clear") setQuery(next);
    }}>
    <AutocompleteInput id={id} ref={inputRef} aria-label={label} aria-invalid={errorId ? true : undefined} aria-describedby={errorId} placeholder={placeholder} showTrigger
      triggerProps={{ "aria-label": label }} onFocus={event => event.currentTarget.select()} />
    <AutocompletePopup className="w-(--anchor-width)">
      <AutocompleteEmpty>{t("content_search.no_results")}</AutocompleteEmpty>
      <AutocompleteList className="max-h-60 overflow-y-auto">
        {(id: string) => {
          const option = optionsById.get(id);
          return option && <AutocompleteItem key={id} value={id} className="flex-col items-start">
            <span className="break-words">{option.name}</span>
            {option.reference && <span className="text-xs text-muted-foreground">{option.reference}</span>}
          </AutocompleteItem>;
        }}
      </AutocompleteList>
    </AutocompletePopup>
  </Autocomplete>;
}
