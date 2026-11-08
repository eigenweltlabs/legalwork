import { useRef, useState, useSyncExternalStore, type CSSProperties, type ReactElement, type ReactNode, type RefObject } from "react";
import { ThemeProvider } from "twenty-ui/theme";
import { getResolvedThemeMode, subscribeToTheme } from "@/app/theme";
import { ChevronDown, X } from "lucide-react";
import { Dropdown } from "twenty-ui/components/navigation";
import { Button, Select } from "twenty-ui/primitives/input";
import { Dialog, Popover } from "twenty-ui/primitives/surfaces";
import { t } from "@/i18n";

// Twenty uses a 13px root. Scope its rem-based typography to this feature,
// including the library's portalled menus, without changing LegalWork's root.
export const directoryTheme = {
  "--t-corner-shape": "superellipse(2.2)",
  "--t-font-size-xxs": "10px",
  "--t-font-size-xs": "11px",
  "--t-font-size-sm": "12px",
  "--t-font-size-md": "13px",
  "--t-font-size-lg": "16px",
  "--t-font-size-xl": "20px",
  "--t-font-size-xxl": "24px",
};

export function BackOfficeTheme({ children }: { children: ReactNode }) {
  const colorScheme = useSyncExternalStore(
    subscribeToTheme,
    getResolvedThemeMode,
    getResolvedThemeMode,
  );
  return (
    <ThemeProvider
      colorScheme={colorScheme}
      applyToRoot={false}
      overrides={directoryTheme}
      className="bo-theme"
    >
      {children}
    </ThemeProvider>
  );
}

export function DirectoryEditorPopup({ children, className = "", style, finalFocus, id }: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  finalFocus?: RefObject<HTMLElement | null>;
  id?: string;
}) {
  const popup = useRef<HTMLDivElement>(null);
  return <Popover.Popup ref={popup} id={id} finalFocus={finalFocus} initialFocus={() => {
    popup.current?.querySelector<HTMLElement>("input, button:not(:disabled), [tabindex='0']")?.focus({ preventScroll: true });
    return false;
  }} className={`bo-editor-popup ${className}`} style={{ width: 260, maxHeight: "var(--available-height)", overflowY: "auto", ...style }}>{children}</Popover.Popup>;
}

export function DirectorySelect({
  value,
  onChange,
  options,
  label,
  disabled,
  required,
  searchable = false,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  label: string;
  disabled?: boolean;
  required?: boolean;
  searchable?: boolean;
}) {
  if (searchable) return <DirectorySearchSelect value={value} onChange={onChange} options={options} label={label} disabled={disabled} />;
  return (
    <Select.Root
      value={value}
      onValueChange={(value) => {
        if (value !== null) onChange(value);
      }}
      items={options}
      disabled={disabled}
      required={required}
    >
      <Select.Trigger size="sm" aria-label={label}>
        <Select.Value />
        <Select.Icon />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={4} alignItemWithTrigger={false}>
          <Select.Popup>
            <Select.List>
              {options.map((option) => (
                <Select.Item key={option.value} value={option.value}>
                  <Select.ItemText>{option.label}</Select.ItemText>
                  <Select.ItemIndicator />
                </Select.Item>
              ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

function DirectorySearchSelect({ value, onChange, options, label, disabled }: {
  value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; label: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const matches = options.filter(option => option.label.normalize("NFC").toLocaleLowerCase().includes(query.normalize("NFC").trim().toLocaleLowerCase()));
  return <DirectoryMenu type="picker" align="start" open={open} onOpenChange={next => { setOpen(next); if (!next) setQuery(""); }} className="bo-search-select" trigger={
    <Button type="button" size="sm" variant="outline" color="neutral" aria-label={label} disabled={disabled} endIcon={<ChevronDown size={12} />} className="bo-search-select-trigger"><span>{options.find(option => option.value === value)?.label}</span></Button>
  }>
    <Dropdown.Search aria-label={t("project_filters.search_fields")} placeholder={t("project_filters.search_fields")} value={query} onValueChange={setQuery} />
    <div className="bo-search-select-options">
      {matches.map(option => <Dropdown.OptionItem key={option.value} value={option.value} selected={option.value === value} indicator="check" onClick={() => { onChange(option.value); setOpen(false); setQuery(""); }}>{option.label}</Dropdown.OptionItem>)}
      {!matches.length && <p className="bo-muted" role="status">{t("content_search.no_results")}</p>}
    </div>
  </DirectoryMenu>;
}

export function DirectoryMenu({
  trigger,
  children,
  type = "menu",
  className,
  align = "end",
  open,
  onOpenChange,
}: {
  trigger: ReactElement;
  children: ReactNode;
  type?: "menu" | "panel" | "picker";
  className?: string;
  align?: "start" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Dropdown.Root type={type} open={open} onOpenChange={onOpenChange}>
      <Dropdown.Trigger render={trigger} />
      <Dropdown.Content className={className} align={align} sideOffset={4}>
        {children}
      </Dropdown.Content>
    </Dropdown.Root>
  );
}

export function DirectoryDialog({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Viewport>
          <Dialog.Popup size={wide ? "lg" : "sm"} className="bo-dialog">
            <Dialog.Close
              className="bo-dialog-close"
              render={
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Close dialog"
                  startIcon={<X size={16} />}
                />
              }
            />
            <Dialog.Header>
              <Dialog.Title>{title}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>{children}</Dialog.Body>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
