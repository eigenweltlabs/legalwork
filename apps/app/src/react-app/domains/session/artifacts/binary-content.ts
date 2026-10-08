/** Polling returns fresh ArrayBuffers even when the original has not changed.
 * Keep the buffer identity so previews keep their URL, scroll and playback. */
export function retainBinaryContent(previous: ArrayBuffer | undefined, incoming: ArrayBuffer): ArrayBuffer {
  if (!previous || previous.byteLength !== incoming.byteLength) return incoming;
  const before = new Uint8Array(previous), after = new Uint8Array(incoming);
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) return incoming;
  return previous;
}

/** Only a timestamp from the downloaded response can validate cached bytes.
 * A tab's discovery timestamp may predate the download and is not a baseline. */
export function binaryMatchesStat(previous: { data: ArrayBuffer; downloadedUpdatedAt?: number | null }, stat: { exists: boolean; kind?: string; size?: number; updatedAt?: number }) {
  return stat.exists && stat.kind === "file" &&
    typeof previous.downloadedUpdatedAt === "number" && Number.isFinite(previous.downloadedUpdatedAt) &&
    typeof stat.updatedAt === "number" && Number.isFinite(stat.updatedAt) &&
    stat.updatedAt === previous.downloadedUpdatedAt && stat.size === previous.data.byteLength;
}
