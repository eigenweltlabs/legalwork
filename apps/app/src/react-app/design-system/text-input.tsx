/** @jsxImportSource react */
import { useId, type ComponentProps } from "react";
import { Input } from "@/components/ui/input";

export type TextInputProps = ComponentProps<"input"> & {
  label?: string;
  hint?: string;
};

export function TextInput({ label, hint, className, ref, "aria-describedby": describedBy, ...rest }: TextInputProps) {
  const hintId = useId();

  return (
    <label className="block">
      {label ? (
        <div className="mb-1.5 text-xs font-medium text-dls-text">
          {label}
        </div>
      ) : null}
      <Input
        ref={ref}
        className={className}
        aria-describedby={[describedBy, hint ? hintId : undefined].filter(Boolean).join(" ") || undefined}
        {...rest}
      />
      {hint ? (
        <div id={hintId} className="mt-1.5 text-xs leading-relaxed text-dls-secondary">{hint}</div>
      ) : null}
    </label>
  );
}
