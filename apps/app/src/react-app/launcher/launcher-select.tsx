import { useId } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Use the app's accessible dropdown so Enter, Space and arrows open the list. */
export function LauncherSelect({ label, value, options, onChange, placeholder, autoFocus, required, disabled }: {
  label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void;
  placeholder?: string; autoFocus?: boolean; required?: boolean; disabled?: boolean;
}) {
  const id = useId();
  return <label htmlFor={id}>{label}
    <Select value={value === "" && !options.some(option => option.value === "") ? null : value} items={options} onValueChange={next => onChange(next ?? "")} required={required} disabled={disabled}>
      <SelectTrigger id={id} autoFocus={autoFocus} className="w-full min-w-0 rounded-md"><SelectValue placeholder={placeholder} /></SelectTrigger>
      <SelectContent align="start" className="max-h-56 rounded-lg" onKeyDown={event => event.stopPropagation()}>
        {options.map(option => <SelectItem key={option.value} value={option.value} className="rounded-md">{option.label}</SelectItem>)}
      </SelectContent>
    </Select>
  </label>;
}
