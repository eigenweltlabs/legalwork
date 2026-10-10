import { Ban, ChevronDown, Globe, Hand } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { t } from "@/i18n";

export type NetworkMode = "allow" | "block" | "approve";
const options = [
  { value: "allow", label: "sandbox.network_allow", description: "sandbox.menu_allow", icon: Globe },
  { value: "block", label: "sandbox.network_block", description: "sandbox.menu_block", icon: Ban },
  { value: "approve", label: "sandbox.network_approve", description: "sandbox.menu_approve", icon: Hand },
];
export function networkLabel(value: NetworkMode) {
  return t(value === "allow" ? "sandbox.network_allow" : value === "block" ? "sandbox.network_block" : "sandbox.network_approve");
}
export function networkDescription(value: NetworkMode) {
  return t(value === "allow" ? "sandbox.network_allow_desc" : value === "block" ? "sandbox.network_block_desc" : "sandbox.network_approve_desc");
}
type Props = { value: NetworkMode; disabled: boolean; onChange: (mode: NetworkMode) => void };
export function SandboxNetworkItems({ value, disabled, onChange }: Props) {
  return <DropdownMenuGroup>
    <DropdownMenuLabel>{t("sandbox.network_title")}</DropdownMenuLabel>
    <DropdownMenuRadioGroup value={value} onValueChange={mode => {
      if (mode === "allow" || mode === "block" || mode === "approve") onChange(mode);
    }}>
      {options.map(({ value, label, description, icon: Icon }) => <DropdownMenuRadioItem key={value} value={value} disabled={disabled} className="items-start py-3">
        <Icon className="mt-0.5 size-4" aria-hidden />
        <span className="min-w-0"><span className="block">{t(label)}</span><span className="mt-1 block text-xs font-normal leading-relaxed text-muted-foreground">{t(description)}</span></span>
      </DropdownMenuRadioItem>)}
    </DropdownMenuRadioGroup>
  </DropdownMenuGroup>;
}
export function SandboxNetworkControl(props: Props) {
  return <DropdownMenu>
    <DropdownMenuTrigger disabled={props.disabled} aria-label={t("sandbox.network_title")} className="inline-flex min-h-9 items-center gap-2 rounded-full border border-border px-3 text-[13px] disabled:opacity-50">
      <Globe className="size-3.5" aria-hidden />{networkLabel(props.value)}<ChevronDown className="size-3.5" aria-hidden />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-88 max-w-[calc(100vw-2rem)]"><SandboxNetworkItems {...props} /></DropdownMenuContent>
  </DropdownMenu>;
}
