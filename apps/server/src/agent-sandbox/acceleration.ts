/** Select hardware acceleration only for a compatible physical CPU. Nested
 * Intel HVF can corrupt or hang the guest even when hv_support reports 1. */
export function canUseMacHypervisor(architecture: "aarch64" | "x86_64", systemFlags: string): boolean {
  const flags = new Map<string, string>();
  for (const line of systemFlags.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) flags.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  if (flags.get("kern.hv_support") !== "1") return false;
  const arm = flags.get("hw.optional.arm64");
  if (architecture === "aarch64") return arm === "1";
  // hw.optional.arm64 may be absent on Intel. It remains 1 under Rosetta.
  return (arm === undefined || arm === "0") && flags.get("kern.hv_vmm_present") === "0";
}
