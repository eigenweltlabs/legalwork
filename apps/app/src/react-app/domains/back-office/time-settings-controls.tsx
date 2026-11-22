import { useId, type ReactNode, type Ref } from "react";
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
  placeholder,
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  id?: string;
  triggerRef?: Ref<HTMLButtonElement>;
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
      items={choices}
      value={value || (placeholder ? null : value)}
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger ref={triggerRef} id={id} aria-label={label} className="max-w-full">
        <SelectValue placeholder={placeholder} className="min-w-0 truncate" />
      </SelectTrigger>
      <SelectContent>
        {choices.map((choice) => (
          <SelectItem key={choice.value} value={choice.value}>
            {choice.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
