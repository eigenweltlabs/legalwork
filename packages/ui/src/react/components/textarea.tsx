import { forwardRef } from "react";
import { cn } from "../utils/cn";

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, invalid, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(
          "w-full resize-none rounded-xl border bg-surface px-3.5 py-2.5 text-base text-ink placeholder:text-placeholder",
          "outline-none transition-[border-color,box-shadow] duration-[var(--lw-duration-fast)] ease-standard",
          "border-line hover:border-strong",
          "focus:border-brand focus:ring-2 focus:ring-[var(--lw-focus-ring)]",
          invalid && "border-danger focus:border-danger",
          "disabled:opacity-55",
          className,
        )}
        {...rest}
      />
    );
  },
);
