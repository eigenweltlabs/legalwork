import type { AudioTranscriptSegment } from "@legalwork/types/audio";

export type TranscriptTurn = {
  id: string;
  startMs: number;
  speaker: number | null;
  segments: AudioTranscriptSegment[];
};

/** Keep consecutive speech together; a live partial replaces its previous text. */
export function transcriptTurns(segments: AudioTranscriptSegment[], partials: AudioTranscriptSegment[] | AudioTranscriptSegment | null): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const live = Array.isArray(partials) ? partials : partials ? [partials] : [];
  for (const segment of [...segments, ...live].sort((a, b) => a.startMs - b.startMs)) {
    if (!segment.text.trim()) continue;
    const speaker = segment.speaker ?? null;
    const previous = turns.at(-1);
    const last = previous?.segments.at(-1);
    if (previous && last && speaker !== null && previous.speaker === speaker
      && last.final === segment.final && last.source === segment.source
      && segment.startMs - last.endMs <= 3000 && segment.endMs - previous.startMs <= 30000
      && previous.segments.reduce((length, part) => length + part.text.length, 0) + segment.text.length <= 600) previous.segments.push(segment);
    else turns.push({ id: segment.id, startMs: segment.startMs, speaker, segments: [segment] });
  }
  return turns;
}

export function recordingTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const tail = String(seconds % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${tail}` : `${minutes}:${tail}`;
}
