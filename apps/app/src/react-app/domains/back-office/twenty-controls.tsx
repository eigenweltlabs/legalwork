import type { ReactElement, ReactNode } from "react";
import { X } from "lucide-react";
import { Dropdown } from "twenty-ui/components/navigation";
import { Button, Select } from "twenty-ui/primitives/input";
import { Dialog } from "twenty-ui/primitives/surfaces";

// Twenty uses a 13px root. Scope its rem-based typography to this feature,
// including the library's portalled menus, without changing LegalWork's root.
export const directoryTheme = {
  "--t-font-size-xxs": "10px",
  "--t-font-size-xs": "11px",
  "--t-font-size-sm": "12px",
  "--t-font-size-md": "13px",
  "--t-font-size-lg": "16px",
  "--t-font-size-xl": "20px",
  "--t-font-size-xxl": "24px",
};

export function DirectorySelect({
  value,
  onChange,
  options,
  label,
  disabled,
  required,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  label: string;
  disabled?: boolean;
  required?: boolean;
}) {
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
        <Select.Positioner sideOffset={4}>
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

export function DirectoryMenu({
  trigger,
  children,
  type = "menu",
  align = "end",
  open,
  onOpenChange,
}: {
  trigger: ReactElement;
  children: ReactNode;
  type?: "menu" | "panel" | "picker";
  align?: "start" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Dropdown.Root type={type} open={open} onOpenChange={onOpenChange}>
      <Dropdown.Trigger render={trigger} />
      <Dropdown.Content align={align} sideOffset={4}>
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
