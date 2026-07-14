import { forwardRef } from "react";
import { cn } from "../utils/cn";

export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Field label rendered above the control. */
  label?: React.ReactNode;
  /** Associates the label with a control via its `id`. */
  htmlFor?: string;
  /** Helper text shown below the control (hidden when `error` is set). */
  hint?: React.ReactNode;
  /** Error message shown below the control; takes precedence over `hint`. */
  error?: React.ReactNode;
  /** Appends a red asterisk to the label. */
  required?: boolean;
}

/**
 * Field — vertical wrapper for a form control. Renders a label row, the control
 * (children), then a hint or error line. Presentational only; it wraps any
 * control (Input, Select, Textarea, …).
 */
export const Field = forwardRef<HTMLDivElement, FieldProps>(function Field(
  { className, label, htmlFor, hint, error, required, children, ...rest },
  ref,
) {
  return (
    <div ref={ref} className={cn("flex flex-col gap-1.5", className)} {...rest}>
      {label ? (
        <label htmlFor={htmlFor} className="text-base font-medium text-ink">
          {label}
          {required ? <span className="ml-0.5 text-danger">*</span> : null}
        </label>
      ) : null}
      {children}
      {error ? (
        <p className="text-sm leading-[1.35] text-danger">{error}</p>
      ) : hint ? (
        <p className="text-sm leading-[1.35] text-subtext">{hint}</p>
      ) : null}
    </div>
  );
});

export interface FieldRowProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Label on the left. */
  label?: React.ReactNode;
  /** Muted description under the label. */
  description?: React.ReactNode;
  /** Associates the label with a control via its `id`. */
  htmlFor?: string;
}

/**
 * FieldRow — horizontal variant for inline settings forms: label + description
 * on the left, control (children) on the right. Stack these inside a `Card`,
 * separating with `<Divider inset />`, to reproduce grouped settings panels.
 */
export const FieldRow = forwardRef<HTMLDivElement, FieldRowProps>(function FieldRow(
  { className, label, description, htmlFor, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn("flex items-center gap-3", className)}
      {...rest}
    >
      <div className="min-w-0 flex-1">
        {label ? (
          <label htmlFor={htmlFor} className="text-base font-medium text-ink">
            {label}
          </label>
        ) : null}
        {description ? (
          <div className="mt-0.5 text-sm leading-[1.35] text-subtext">{description}</div>
        ) : null}
      </div>
      {children ? <div className="flex shrink-0 items-center">{children}</div> : null}
    </div>
  );
});
