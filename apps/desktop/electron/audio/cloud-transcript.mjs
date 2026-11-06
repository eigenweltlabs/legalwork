import { dominantSpeaker } from "./cloud-speakers.mjs";

const normalized = text => text.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Split the live model's original wording using matching, timed Chirp words.
 * Never distribute words across speakers just by dividing a segment's duration:
 * live model timestamps include buffering and silence, not word boundaries.
 * @param {import("@legalwork/types/audio").AudioTranscriptSegment} segment
 * @param {{text?: string, startMs: number, endMs: number, speaker: number | null}[]} words
 * @param {{startMs: number, endMs: number, speaker: number | null}[]} turns
 * @param {number} coveredEnd
 * @param {import("@legalwork/types/audio").AudioTranscriptSegment[]} previousParts
 * @returns {import("@legalwork/types/audio").AudioTranscriptSegment[]}
 */
export function splitCloudTranscript(segment, words, turns, coveredEnd, previousParts = []) {
  const tokens = [...segment.text.matchAll(/\S+/gu)].map(match => ({ text: match[0], index: match.index, key: normalized(match[0]) }));
  const candidates = words.filter(word => word.text && word.endMs > segment.startMs - 4000 && word.startMs < segment.endMs + 1000)
    .flatMap(word => (word.text.match(/\S+/gu) ?? []).map(text => ({ ...word, key: normalized(text) })));
  if (!candidates.length || tokens.length > 1024 || candidates.length > 2048) {
    if (!words.some(word => word.text) && segment.endMs <= coveredEnd) {
      const speaker = dominantSpeaker(segment, turns);
      if (speaker != null) return [{ ...segment, speaker }];
    }
    if (previousParts.some(part => part.speaker != null)) return previousParts;
    return [{ ...segment, speaker: segment.speaker ?? null }];
  }
  // Order-preserving word alignment tolerates punctuation, casing and small
  // recognition differences while keeping the live model's text untouched.
  const lengths = Array.from({ length: tokens.length + 1 }, () => new Uint16Array(candidates.length + 1));
  for (let i = tokens.length - 1; i >= 0; i--) for (let j = candidates.length - 1; j >= 0; j--) {
    lengths[i][j] = tokens[i].key && tokens[i].key === candidates[j].key
      ? 1 + lengths[i + 1][j + 1] : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  }
  const matched = new Map();
  let i = 0, j = 0;
  while (i < tokens.length && j < candidates.length) {
    if (tokens[i].key && tokens[i].key === candidates[j].key) { matched.set(i++, candidates[j++]); }
    else if (lengths[i + 1][j] > lengths[i][j + 1]) i++;
    else j++;
  }
  // Common words in an older sentence are not evidence for a new caption.
  // Weight coverage by characters so matching only "das" and "ja" cannot
  // label an otherwise unmatched live phrase as the previous speaker.
  const matchedCharacters = [...matched.keys()].reduce((sum, index) => sum + tokens[index].key.length, 0);
  const totalCharacters = tokens.reduce((sum, token) => sum + token.key.length, 0);
  if (matched.size < Math.min(2, tokens.length) || matchedCharacters < totalCharacters * .6) {
    return previousParts.length ? previousParts : [{ ...segment, speaker: segment.speaker ?? null }];
  }
  const inferred = new Map();
  const assigned = tokens.map((_, index) => matched.get(index)?.speaker ?? null);
  // Fill only short omissions enclosed by the same voice, or at a recognized
  // sentence edge. An unmatched gap between different people stays unassigned.
  for (let index = 0; index < tokens.length; index++) {
    if (matched.has(index)) continue;
    const before = [...matched.keys()].filter(key => key < index).at(-1);
    const after = [...matched.keys()].find(key => key > index);
    if (before != null && after != null && after - before <= 4) {
      const gap = candidates.filter(word => word.startMs >= matched.get(before).endMs && word.endMs <= matched.get(after).startMs);
      if (gap.length && gap.every(word => word.speaker != null && word.speaker === gap[0].speaker)) {
        assigned[index] = gap[0].speaker;
        inferred.set(index, { startMs: gap[0].startMs, endMs: gap.at(-1).endMs });
      } else if (assigned[before] === assigned[after]) assigned[index] = assigned[before];
    }
    else if (before == null && after != null && after <= 2) assigned[index] = assigned[after];
    else if (after == null && before != null && tokens.length - before <= 3 && segment.endMs <= coveredEnd) assigned[index] = assigned[before];
  }
  // A cropped or differently recognized overlap must not erase a word's
  // established label. New positive detections can still correct it.
  let previousIndex = 0;
  for (const part of previousParts) for (const _ of part.text.match(/\S+/gu) ?? []) {
    if (assigned[previousIndex] == null && part.speaker != null) assigned[previousIndex] = part.speaker;
    previousIndex++;
  }
  const parts = [];
  for (let begin = 0; begin < tokens.length;) {
    let end = begin + 1;
    let firstTimed = matched.get(begin) ?? inferred.get(begin);
    let lastTimed = firstTimed;
    while (end < tokens.length && assigned[end] === assigned[begin]) {
      const word = matched.get(end) ?? inferred.get(end);
      if (tokens[end].index + tokens[end].text.length - tokens[begin].index > 600
        || (word && firstTimed && word.endMs - firstTimed.startMs > 30000)
        || (word && lastTimed && word.startMs - lastTimed.endMs > 3000)) break;
      firstTimed ??= word;
      lastTimed = word ?? lastTimed;
      end++;
    }
    const timed = [...matched, ...inferred].filter(([index]) => index >= begin && index < end)
      .sort((a, b) => a[0] - b[0]).map(([, word]) => word);
    const before = [...matched].filter(([index]) => index < begin).at(-1)?.[1];
    const after = [...matched].find(([index]) => index >= end)?.[1];
    const from = tokens[begin].index;
    const to = end < tokens.length ? tokens[end].index : segment.text.length;
    parts.push({ ...segment, id: `${segment.id}:w${begin}`, text: segment.text.slice(from, to).trim(),
      startMs: timed[0]?.startMs ?? before?.endMs ?? segment.startMs,
      endMs: timed.at(-1)?.endMs ?? after?.startMs ?? segment.endMs,
      speaker: assigned[begin] ?? segment.speaker ?? null });
    begin = end;
  }
  return previousParts.length === parts.length && parts.every((part, index) => part.text === previousParts[index].text && part.speaker === previousParts[index].speaker
    && part.startMs === previousParts[index].startMs && part.endMs === previousParts[index].endMs)
    ? previousParts : parts;
}

export function mergeSpeakerWords(previous, update) {
  return [...previous.filter(word => word.startMs < update.startMs || word.startMs >= update.endMs),
    ...update.words.map(word => {
      if (word.speaker != null) return word;
      const known = previous.find(old => old.speaker != null && normalized(old.text ?? "") === normalized(word.text ?? "") && Math.abs(old.startMs - word.startMs) < 500);
      return known ? { ...word, speaker: known.speaker } : word;
    })].filter(word => word.endMs >= update.endMs - 240_000).sort((a, b) => a.startMs - b.startMs);
}
