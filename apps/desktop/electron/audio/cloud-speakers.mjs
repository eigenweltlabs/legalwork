// Chirp speaker labels belong to one request. Prepending the same short voice
// references lets Chirp compare returning voices acoustically inside each call.
// References survive live socket renewals, but never survive the recording.
const RATE = 16000;
const BYTES_PER_MS = RATE * 2 / 1000;
const MAX_SPEAKERS = 8;
const ANCHOR_MS = 8000;
const MIN_WINDOW_MS = 30000;
const REQUEST_BUDGET_MS = 58000;
const GAP = Buffer.alloc(RATE / 2); // 250 ms between references
const overlap = (a, b) => Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));

export class CloudSpeakerPass {
  constructor({ recognize, onTurns, onError, verifyVoices = null, chunkMs = 20000 }) {
    this.recognize = recognize;
    this.verifyVoices = verifyVoices;
    this.onTurns = onTurns;
    this.onError = onError;
    this.chunkMs = chunkMs;
    // Keep enough context to build a full voice reference even when updates
    // arrive faster than a speaker finishes their first sentence.
    this.overlapMs = Math.max(2000, MIN_WINDOW_MS - chunkMs);
    this.anchors = [];
    this.nextSpeaker = 0;
    this.recent = [];
    this.timeline = [];
    this.audio = Buffer.alloc(0);
    this.baseMs = 0;
    this.processedMs = 0;
    this.ending = false;
    this.stopped = false;
    this.pending = null;
    this.consecutiveFailures = 0;
    this.controller = new AbortController();
  }

  feed(bytes) {
    if (this.stopped || this.ending) return;
    this.audio = Buffer.concat([this.audio, bytes]);
    // A slow provider must never accumulate the whole meeting in memory.
    if (this.audio.length > 90_000 * BYTES_PER_MS) {
      this.fail(new Error("Cloud speaker detection could not keep up. The transcript will be kept."));
      return;
    }
    this.start();
  }

  start() {
    if (this.pending || this.stopped) return;
    this.pending = this.drain().catch(error => {
      if (!this.stopped) this.fail(error);
    }).finally(() => { this.pending = null; });
  }

  async finish() {
    this.ending = true;
    await this.pending;
    if (!this.stopped) {
      this.start();
      await this.pending;
    }
    this.stop();
  }

  stop() {
    this.stopped = true;
    this.controller.abort();
    this.audio = Buffer.alloc(0);
    this.anchors = [];
    this.recent = [];
    this.timeline = [];
  }

  fail(error) {
    this.stop();
    this.onError(error instanceof Error ? error.message : "Cloud speaker detection is unavailable. The transcript will be kept.");
  }

  async drain() {
    while (!this.stopped) {
      const availableEnd = this.baseMs + this.audio.length / BYTES_PER_MS;
      const remaining = availableEnd - this.processedMs;
      if (remaining <= 0 || (!this.ending && remaining < this.chunkMs)) return;
      const startMs = Math.max(this.baseMs, this.processedMs - this.overlapMs);
      const endMs = Math.min(availableEnd, this.processedMs + this.chunkMs);
      const clip = this.audio.subarray(Math.round((startMs - this.baseMs) * BYTES_PER_MS), Math.round((endMs - this.baseMs) * BYTES_PER_MS));
      // Skip exact silence without sending a paid request. Quiet speech is kept.
      if (clip.some(value => value !== 0)) {
        const references = [];
        const parts = [];
        let prefixMs = 0;
        // Prefer continuous conversation over replaying a voice already in it.
        // Duplicating the same speech in a prefix can make Chirp split or merge
        // identities. Keep references only for people absent from this window.
        const present = this.anchors.filter(anchor => anchor.startMs >= startMs && anchor.endMs <= endMs);
        const absent = this.anchors.filter(anchor => !present.includes(anchor));
        for (const anchor of absent) {
          const maxDuration = (REQUEST_BUDGET_MS - clip.length / BYTES_PER_MS) / absent.length - GAP.length / BYTES_PER_MS;
          const referenceAudio = anchor.audio.subarray(0, Math.floor(Math.min(anchor.audio.length / BYTES_PER_MS, maxDuration)) * BYTES_PER_MS);
          const duration = referenceAudio.length / BYTES_PER_MS;
          references.push({ speaker: anchor.speaker, startMs: prefixMs, endMs: prefixMs + duration });
          parts.push(referenceAudio, GAP);
          prefixMs += duration + GAP.length / BYTES_PER_MS;
        }
        parts.push(clip);
        for (const anchor of present) references.push({ speaker: anchor.speaker,
          startMs: prefixMs + anchor.startMs - startMs, endMs: prefixMs + anchor.endMs - startMs, inWindow: true });
        let words;
        try {
          words = await this.recognize(Buffer.concat(parts), this.controller.signal);
          this.consecutiveFailures = 0;
        } catch (error) {
          if (this.stopped) return;
          if (!error.recoverable || ++this.consecutiveFailures >= 3) throw error;
          // Keep source labels for this window and continue with later audio.
          // Never replay a paid request whose response may have been lost.
          this.onError("Speaker detection missed part of the recording. Those words keep their input labels.", true);
          words = [];
        }
        if (this.stopped) return;
        const turns = this.match(words, references, clip, prefixMs, startMs);
        const alignedWords = words.filter(word => word.startMs >= prefixMs && word.endMs <= prefixMs + clip.length / BYTES_PER_MS + 1)
          .map(word => ({ ...word, startMs: word.startMs - prefixMs + startMs, endMs: word.endMs - prefixMs + startMs }))
          .map(word => ({ ...word, speaker: dominantSpeaker(word, turns) }));
        const verification = this.verifyVoices ? await this.verifyVoices(clip, startMs, turns) : null;
        const verifiedTurns = verification?.turns ?? null;
        if (this.stopped) return;
        // A newly encountered voice needs confirmation in another chunk. Once
        // confirmed, backfill its earlier labels without changing any words.
        for (const previous of this.recent) {
          if (previous.verifiedTurns && verification?.corrections.length) {
            previous.verifiedTurns = previous.verifiedTurns.map(turn => verification.corrections.find(correction =>
              correction.startMs === turn.startMs && correction.endMs === turn.endMs) ?? turn);
          }
          this.publish(previous);
        }
        const current = { startMs, endMs, turns, verifiedTurns, words: alignedWords, published: null };
        this.publish(current);
        this.recent = [...this.recent, current].slice(-2);
      }
      this.processedMs = endMs;
      this.timeline = this.timeline.filter(turn => turn.endMs >= endMs - 60_000);
      const discardTo = Math.max(this.baseMs, endMs - this.overlapMs);
      this.audio = Buffer.from(this.audio.subarray(Math.round((discardTo - this.baseMs) * BYTES_PER_MS)));
      this.baseMs = discardTo;
    }
  }

  publish(result) {
    const turns = result.turns.map(turn => ({ ...turn, speaker: this.anchors.some(anchor =>
      anchor.speaker === turn.speaker && anchor.confirmed !== false) ? turn.speaker : null }));
    const published = JSON.stringify([turns, result.verifiedTurns]);
    if (published !== result.published) {
      result.published = published;
      this.timeline = mergeSpeakerTurns(this.timeline, { ...result, turns });
      const output = result.verifiedTurns ?? turns;
      const words = result.words.map(word => ({ ...word, speaker: dominantSpeaker(word, result.verifiedTurns ?? this.timeline) }));
      this.onTurns({ startMs: result.startMs, endMs: result.endMs, turns: output, words, voicesVerified: result.verifiedTurns != null });
    }
  }

  match(words, references, clip, prefixMs, offsetMs) {
    const known = new Map();
    const conflicts = new Set();
    const inWindow = new Set();
    for (const reference of references) {
      const votes = new Map();
      for (const word of words) {
        const duration = overlap(word, reference);
        if (duration) votes.set(word.speaker, (votes.get(word.speaker) ?? 0) + duration);
      }
      const ranked = [...votes].sort((a, b) => b[1] - a[1]);
      const total = ranked.reduce((sum, vote) => sum + vote[1], 0);
      if (!ranked.length || ranked[0][1] < 500 || ranked[0][1] / total < .8) continue;
      const label = ranked[0][0];
      if (known.has(label)) conflicts.add(label);
      else known.set(label, reference.speaker);
      if (reference.inWindow) inWindow.add(label);
    }
    for (const label of conflicts) known.delete(label);
    // Missing/merged reference labels are uncertainty, not new people.
    const current = words.filter(word => word.startMs >= prefixMs && word.endMs <= prefixMs + clip.length / BYTES_PER_MS + 1);
    // Identical speech in the overlap is stronger evidence than a short voice
    // reference. Chirp can split the reference and the same person's current
    // speech into different request-local labels, so allow those aliases.
    const continuity = new Map();
    for (const word of current) {
      const interval = { startMs: word.startMs - prefixMs + offsetMs, endMs: word.endMs - prefixMs + offsetMs };
      for (const previous of this.timeline) {
        const duration = overlap(interval, previous);
        if (!duration || previous.speaker == null) continue;
        if (!continuity.has(word.speaker)) continuity.set(word.speaker, new Map());
        const votes = continuity.get(word.speaker);
        votes.set(previous.speaker, (votes.get(previous.speaker) ?? 0) + duration);
      }
    }
    // A provider's two distinct conversation labels must not both collapse
    // onto one old identity when a later, longer window splits an early guess.
    // Match the strongest overlap first, then reserve that identity.
    const matches = [...continuity].flatMap(([label, votes]) => {
      const ranked = [...votes].sort((a, b) => b[1] - a[1]);
      const total = ranked.reduce((sum, vote) => sum + vote[1], 0);
      return ranked[0][1] >= 750 && ranked[0][1] / total >= .85
        ? [{ label, speaker: ranked[0][0], duration: ranked[0][1] }] : [];
    }).sort((a, b) => b.duration - a.duration);
    const fixed = new Set([...inWindow].filter(label => known.has(label)));
    const assigned = new Set([...fixed].map(label => known.get(label)));
    const labels = new Set(current.map(word => word.speaker));
    for (const match of matches) {
      if (fixed.has(match.label)) continue;
      if (assigned.has(match.speaker)) { known.delete(match.label); continue; }
      for (const [label, speaker] of known) if (labels.has(label) && label !== match.label && speaker === match.speaker) known.delete(label);
      known.set(match.label, match.speaker);
      assigned.add(match.speaker);
      conflicts.delete(match.label);
    }
    const identified = new Set(known.values());
    // A replayed reference can be labelled differently from the same person's
    // current speech. A new identity needs a known voice in the actual window,
    // not just in the prepended references, so that difference is observable.
    const canEnroll = references.every(reference => identified.has(reference.speaker))
      && (!this.anchors.length || current.some(word => known.has(word.speaker)));
    const runs = [];
    for (const word of current) {
      const previous = runs.at(-1);
      if (previous && previous.label === word.speaker && word.startMs - previous.endMs < 600) previous.endMs = word.endMs;
      else runs.push({ label: word.speaker, startMs: word.startMs, endMs: word.endMs });
    }
    for (const anchor of this.anchors) {
      if (anchor.confirmed !== false) continue;
      if (runs.some(run => known.get(run.label) === anchor.speaker && run.endMs - run.startMs >= 1500)) anchor.confirmed = true;
      else anchor.remaining--;
    }
    this.anchors = this.anchors.filter(anchor => anchor.confirmed !== false || anchor.remaining > 0);
    // An initial update may contain only part of a sentence. Grow
    // that reference from a longer, confidently matched turn as it arrives.
    for (const run of runs) {
      const anchor = this.anchors.find(item => item.speaker === known.get(run.label));
      const length = Math.min(ANCHOR_MS, run.endMs - run.startMs);
      if (!anchor || anchor.confirmed === false || length * BYTES_PER_MS <= anchor.audio.length) continue;
      const begin = run.startMs - prefixMs;
      anchor.audio = Buffer.from(clip.subarray(Math.round(begin * BYTES_PER_MS), Math.round((begin + length) * BYTES_PER_MS)));
      anchor.startMs = begin + offsetMs;
      anchor.endMs = anchor.startMs + length;
    }
    const firstVoices = this.anchors.length === 0;
    for (const run of [...runs].sort((a, b) => (b.endMs - b.startMs) - (a.endMs - a.startMs))) {
      if (known.has(run.label) || conflicts.has(run.label) || !canEnroll || this.anchors.length >= MAX_SPEAKERS) continue;
      if (run.endMs - run.startMs < 1500) continue;
      const speaker = this.nextSpeaker++;
      const begin = run.startMs - prefixMs;
      const length = Math.min(ANCHOR_MS, run.endMs - run.startMs);
      const audio = Buffer.from(clip.subarray(Math.round(begin * BYTES_PER_MS), Math.round((begin + length) * BYTES_PER_MS)));
      this.anchors.push({ speaker, audio, startMs: begin + offsetMs, endMs: begin + offsetMs + length,
        confirmed: firstVoices, remaining: 2 });
      known.set(run.label, speaker);
    }
    return runs.map(run => ({ startMs: run.startMs - prefixMs + offsetMs,
      endMs: run.endMs - prefixMs + offsetMs, speaker: known.get(run.label) ?? null }));
  }
}

export function dominantSpeaker(segment, turns) {
  const durationBySpeaker = new Map();
  let total = 0;
  for (const turn of turns) {
    const duration = overlap(segment, turn);
    total += duration;
    if (turn.speaker != null) durationBySpeaker.set(turn.speaker, (durationBySpeaker.get(turn.speaker) ?? 0) + duration);
  }
  const best = [...durationBySpeaker].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] / total >= .65 ? best[0] : null;
}

// A shorter overlapping request can be uncertain where an earlier request was
// clear. Keep that earlier evidence, while allowing positive corrections.
export function mergeSpeakerTurns(previous, update) {
  const subtract = (turn, ranges) => ranges.reduce((parts, range) => parts.flatMap(part => {
    if (!overlap(part, range)) return [part];
    const remaining = [];
    if (part.startMs < range.startMs) remaining.push({ ...part, endMs: range.startMs });
    if (part.endMs > range.endMs) remaining.push({ ...part, startMs: range.endMs });
    return remaining;
  }), [turn]);
  const knownBefore = previous.filter(turn => turn.speaker != null);
  const knownAfter = update.turns.filter(turn => turn.speaker != null);
  return [
    ...previous.flatMap(turn => subtract(turn, turn.speaker == null ? [update] : knownAfter)),
    ...update.turns.flatMap(turn => turn.speaker == null ? subtract(turn, knownBefore) : [turn]),
  ].sort((a, b) => a.startMs - b.startMs);
}
