import { AlertTriangle, Loader2, Trash2, type LucideIcon } from "lucide-react";
import { cn } from "../utils/cn";
import { Modal } from "./modal";
import { Button } from "./button";

/**
 * ConfirmModal — a thin, ergonomic preset over Modal + Button for
 * yes/no confirmations. Renders a small dialog with a Cancel + confirm
 * action pair. Set `tone="danger"` for destructive confirmations (red
 * confirm button + warning icon) and `loading` while the action is in
 * flight (spinner + disabled buttons).
 */
export interface ConfirmModalProps {
  open: boolean;
  /** Dismiss / cancel handler. Also fired by the Cancel button, scrim and Escape. */
  onClose: () => void;
  /** Fired when the confirm button is pressed. */
  onConfirm: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: React.ReactNode;
  cancelLabel?: React.ReactNode;
  /** Visual emphasis of the confirm action. */
  tone?: "default" | "danger" | "warning";
  /** Show a spinner and disable both buttons while the action runs. */
  loading?: boolean;
  /** Extra content rendered in the body, above the footer. */
  children?: React.ReactNode;
}

const toneIcon: Record<"danger" | "warning", { Icon: LucideIcon; className: string }> = {
  danger: { Icon: Trash2, className: "bg-danger-soft text-danger" },
  warning: { Icon: AlertTriangle, className: "bg-warning-soft text-warning" },
};

export function ConfirmModal({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  loading = false,
  children,
}: ConfirmModalProps) {
  const accent = tone === "default" ? null : toneIcon[tone];

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={
        accent ? (
          <span className="flex items-center gap-2.5">
            <span
              className={cn(
                "flex size-7 shrink-0 items-center justify-center rounded-full [&_svg]:size-4",
                accent.className,
              )}
            >
              <accent.Icon />
            </span>
            {title}
          </span>
        ) : (
          title
        )
      }
      description={description}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            size="sm"
            onClick={onConfirm}
            disabled={loading}
            leading={loading ? <Loader2 className="animate-spin" /> : undefined}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
