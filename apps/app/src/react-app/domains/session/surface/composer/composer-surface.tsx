import type { ComponentProps } from "react";
import { ArrowUp } from "lucide-react";
import "@/components/chat/session-surfaces.css";

export function ComposerSurface({ className = "", ...props }: ComponentProps<"div">) {
  return <div className={"lw-composer relative overflow-visible rounded-[22px] border " + className} {...props} />;
}

export function ComposerSendButton({
  label, title = label, iconOnly, queued, highlighted, type = "button", disabled, onClick,
}: Pick<ComponentProps<"button">, "type" | "disabled" | "onClick"> & {
  label: string;
  title?: string;
  iconOnly?: boolean;
  queued?: boolean;
  highlighted?: boolean;
}) {
  const active = highlighted ?? !disabled;
  return <button
    type={type}
    onClick={onClick}
    disabled={disabled}
    className={`lw-composer-send inline-flex h-9 ${queued ? "" : "max-h-9"} items-center justify-center gap-2 ${iconOnly ? "w-9 rounded-full" : "rounded-xl px-4"} text-[13px] font-medium ${
      active ? "bg-[var(--dls-accent)] text-[var(--dls-accent-fg)] hover:bg-[var(--dls-accent-hover)]" : "bg-gray-4 text-gray-10"
    }`}
    title={title}
    aria-label={label}
  >
    <ArrowUp size={15} aria-hidden="true" />
    {!iconOnly && <span>{label}</span>}
  </button>;
}
