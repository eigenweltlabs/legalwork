export function createHomeMessage() {
  const created = Date.now();
  // OpenCode sorts message IDs by their 48-bit millisecond/counter prefix.
  const time = BigInt.asUintN(48, BigInt(created) * 4096n).toString(16).padStart(12, "0");
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 14);
  const id = `${time}${suffix}`;
  return {
    id: `msg_${id}`,
    partId: `prt_${id}`,
    created,
  };
}

export type HomeMessage = ReturnType<typeof createHomeMessage>;
