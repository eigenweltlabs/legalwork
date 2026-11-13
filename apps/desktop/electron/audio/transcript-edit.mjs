/** Resolve legacy summary IDs only when a personal name is already known. */
export function resolveSummarySpeakerNames(text, names) {
  return text?.replace(/\[speaker:(\d+)\]|\b(?:speaker|sprecher)\s*[:#]?\s*(\d+)\b/gi, (label, bracketId, plainId) => {
    const name = names?.[bracketId ?? plainId];
    return name && !/^(?:(?:Microphone|System audio|App audio)(?: \d+)?|(?:Speaker|Sprecher) \d+)$/i.test(name) ? name : label;
  });
}

/** Apply speaker corrections without changing transcript text or timestamps. */
export function editTranscriptSpeakers(detail, edit) {
  if (!edit || typeof edit !== "object") throw new Error("Invalid transcript edit.");
  const meta = { ...detail.meta, speakerNames: { ...detail.meta.speakerNames } };
  const segments = detail.segments.map(segment => ({ ...segment }));
  const speakers = new Set([
    ...segments.flatMap(segment => segment.speaker == null ? [] : [segment.speaker]),
    ...Object.keys(meta.speakerNames).map(Number),
  ]);
  const validSpeaker = value => Number.isSafeInteger(value) && value >= 0;
  const existingSpeaker = value => validSpeaker(value) && speakers.has(value);
  const name = value => {
    if (typeof value !== "string") throw new Error("Enter a speaker name.");
    const trimmed = value.trim().replace(/\s+/g, " ");
    if (!trimmed || trimmed.length > 120 || /[\x00-\x1f]/.test(trimmed)) throw new Error("Speaker names must contain 1 to 120 characters.");
    return trimmed;
  };
  if (edit.type === "add-speaker") {
    const next = Math.max(-1, ...speakers) + 1;
    if (!validSpeaker(next)) throw new Error("Cannot add another speaker.");
    meta.speakerNames[next] = name(edit.name);
  } else if (edit.type === "rename-speaker") {
    if (!existingSpeaker(edit.speaker)) throw new Error("Speaker not found.");
    meta.speakerNames[edit.speaker] = name(edit.name);
  } else if (edit.type === "remove-speaker") {
    if (!existingSpeaker(edit.speaker)) throw new Error("Speaker not found.");
    if (edit.reassignTo === edit.speaker || (edit.reassignTo !== null && !existingSpeaker(edit.reassignTo))) throw new Error("Choose another speaker or leave the segments unassigned.");
    for (const segment of segments) if (segment.speaker === edit.speaker) segment.speaker = edit.reassignTo;
    delete meta.speakerNames[edit.speaker];
    speakers.delete(edit.speaker);
  } else if (edit.type === "assign-segments") {
    if (edit.speaker !== null && !existingSpeaker(edit.speaker)) throw new Error("Speaker not found.");
    if (!Array.isArray(edit.segmentIds) || !edit.segmentIds.length || edit.segmentIds.some(id => typeof id !== "string")) throw new Error("Select transcript segments.");
    const selected = new Set(edit.segmentIds);
    const available = new Set(segments.map(segment => segment.id));
    if ([...selected].some(id => !available.has(id))) throw new Error("Transcript segment not found.");
    for (const segment of segments) if (selected.has(segment.id)) segment.speaker = edit.speaker;
  } else if (edit.type === "reassign-speaker") {
    if (!existingSpeaker(edit.from) || (edit.to !== null && !existingSpeaker(edit.to))) throw new Error("Speaker not found.");
    for (const segment of segments) if (segment.speaker === edit.from) segment.speaker = edit.to;
  } else {
    throw new Error("Unknown transcript edit.");
  }
  // Keep unused speakers available for later assignments, including their names.
  for (const speaker of speakers) meta.speakerNames[speaker] ??= `Speaker ${speaker + 1}`;
  meta.speakerCount = new Set(segments.flatMap(segment => segment.speaker == null ? [] : [segment.speaker])).size;
  return { meta, segments };
}
