import { test } from "node:test";
import assert from "node:assert/strict";
import { CloudSpeakerPass, dominantSpeaker, mergeSpeakerTurns } from "./audio/cloud-speakers.mjs";
import { splitCloudTranscript } from "./audio/cloud-transcript.mjs";
import fs from "node:fs";
import { DeferredCloudSpeakerPass } from "./audio/deferred-cloud-speakers.mjs";

const audio = (voice, ms) => {
  const buffer = Buffer.alloc(ms * 32);
  for (let i = 0; i < buffer.length; i += 2) buffer.writeInt16LE(voice, i);
  return buffer;
};
// Simulate a provider that distinguishes voices correctly but arbitrarily
// renumbers its labels on EVERY request, including the prepended references.
function provider() {
  let count = 0;
  const requests = [];
  const recognize = async bytes => {
    requests.push(bytes);
    count++;
    const words = [];
    let start = 0;
    for (let i = 2; i <= bytes.length; i += 2) {
      if (i !== bytes.length && bytes.readInt16LE(i) === bytes.readInt16LE(start)) continue;
      const voice = bytes.readInt16LE(start);
      if (voice && i - start >= 3200) words.push({ startMs: start / 32, endMs: i / 32, speaker: `${voice + count * 11}` });
      start = i;
    }
    return words;
  };
  return { recognize, requests };
}

test("saved speaker audio is analyzed only at Stop, in bounded batches, then removed", async () => {
  const { recognize, requests } = provider();
  const results = [];
  const pass = new DeferredCloudSpeakerPass({ recognize, onTurns: value => results.push(value), onError: assert.fail });
  try {
    for (let i = 0; i < 10; i++) {
      pass.feed(audio(100, 20000));
      // Each synthetic chunk contains twenty seconds of audio; let its disk
      // write finish before feeding the next chunk at faster-than-real time.
      await new Promise((resolve, reject) => {
        pass.writer.write(Buffer.alloc(0), error => error ? reject(error) : resolve());
      });
    }
    assert.equal(requests.length, 0);
    assert.equal(results.length, 0);
    await pass.finish();
    assert.equal(requests.length, 5);
    assert.equal(requests[0].length, 45000 * 32);
    assert.ok(requests.every(request => request.length <= 58000 * 32));
    assert.deepEqual(results.map(result => result.endMs), [45000, 90000, 135000, 180000, 200000]);
    assert.equal(fs.existsSync(pass.folder), false);
  } finally { await pass.stop(); }
});

test("cancelling before Stop removes saved speaker audio without a provider request", async () => {
  const pass = new DeferredCloudSpeakerPass({ recognize: async () => { assert.fail("unexpected request"); }, onTurns: assert.fail, onError: assert.fail });
  pass.feed(audio(100, 5000));
  await pass.stop();
  await pass.finish();
  assert.equal(fs.existsSync(pass.folder), false);
});

test("two cloud calls keep returning voices stable despite provider label swaps, silence and an absent speaker", async () => {
  const { recognize, requests } = provider();
  const results = [];
  const pass = new CloudSpeakerPass({ recognize, onTurns: value => results.push(value), onError: assert.fail });
  pass.feed(Buffer.concat([audio(100, 8000), audio(0, 2000), audio(200, 8000), audio(0, 1000)]));
  await pass.pending;
  assert.equal(requests.length, 0, "wait for a full twenty-second sequence before detecting speakers");
  pass.feed(audio(0, 1000));
  await pass.pending;
  pass.feed(Buffer.concat([audio(200, 8000), audio(0, 12000)]));
  await pass.pending;
  pass.feed(Buffer.concat([audio(100, 8000), audio(200, 8000)]));
  await pass.finish();
  assert.equal(requests.length, 3);
  assert.deepEqual(results.map(result => [...new Set(result.turns.map(turn => turn.speaker))]), [[0, 1], [1], [0, 1]]);
  assert.deepEqual(results.map(result => result.endMs), [20000, 40000, 56000]);
  assert.ok(requests.every(request => request.length < 59 * 32000));
  assert.equal(pass.audio.length, 0);
  assert.equal(pass.anchors.length, 0);
});

test("missing or merged voice references cannot create another identity for the same person", () => {
  const pass = new CloudSpeakerPass({ recognize: async () => [], onTurns() {}, onError: assert.fail });
  pass.anchors = [{ speaker: 0, audio: audio(100, 3000) }, { speaker: 1, audio: audio(200, 3000) }];
  const refs = [{ speaker: 0, startMs: 0, endMs: 3000 }, { speaker: 1, startMs: 3250, endMs: 6250 }];
  const words = [{ startMs: 0, endMs: 3000, speaker: "merged" }, { startMs: 3250, endMs: 6250, speaker: "merged" },
    { startMs: 6500, endMs: 9500, speaker: "new" }];
  assert.equal(pass.match(words, refs, audio(100, 3000), 6500, 10000)[0].speaker, null);
  assert.equal(pass.anchors.length, 2);
});

test("the same speech in the overlap cannot become a new person when Chirp splits a reference label", () => {
  const pass = new CloudSpeakerPass({ recognize: async () => [], onTurns() {}, onError: assert.fail });
  pass.anchors = [{ speaker: 0, audio: audio(100, 3000) }, { speaker: 1, audio: audio(200, 3000) }];
  pass.timeline = [{ startMs: 0, endMs: 3000, speaker: 0 }, { startMs: 3000, endMs: 5000, speaker: 1 }];
  const refs = [{ speaker: 0, startMs: 0, endMs: 3000 }, { speaker: 1, startMs: 3250, endMs: 6250 }];
  const turns = pass.match([{ startMs: 0, endMs: 3000, speaker: "a" }, { startMs: 3250, endMs: 6250, speaker: "b" },
    { startMs: 6500, endMs: 10500, speaker: "c" }], refs, audio(200, 7000), 6500, 3000);
  assert.equal(turns[0].speaker, 1);
  assert.equal(pass.anchors.length, 2);
});

test("word alignment separates people within one delayed live segment without rewriting its text", () => {
  const segment = { id: "live", text: "Ich prüfe den Vertrag. Danke, ich übernehme.", startMs: 0, endMs: 14000, final: true, speaker: null };
  const words = ["ich", "prüfe", "den", "Vertrag", "danke", "ich", "übernehme"].map((text, i) =>
    ({ text, startMs: 1000 + i * 500, endMs: 1400 + i * 500, speaker: i < 4 ? 0 : 1 }));
  const parts = splitCloudTranscript(segment, words, [], 14000);
  assert.deepEqual(parts.map(part => [part.speaker, part.text]), [[0, "Ich prüfe den Vertrag."], [1, "Danke, ich übernehme."]]);
  assert.equal(parts.map(part => part.text).join(" "), segment.text);
  assert.equal(parts[1].startMs, 3000, "use word time, not a proportional split of the delayed live interval");
  assert.deepEqual(parts.map(part => part.id), ["live:w0", "live:w4"]);
  assert.equal(splitCloudTranscript({ ...segment, text: "Unrelated recognition words" }, words, [], 14000)[0].speaker, null);
});

test("brief uncertain speech remains unassigned and speaker references are bounded", () => {
  const pass = new CloudSpeakerPass({ recognize: async () => [], onTurns() {}, onError: assert.fail });
  assert.equal(pass.match([{ startMs: 0, endMs: 500, speaker: "x" }], [], audio(100, 1000), 0, 0)[0].speaker, null);
  const words = Array.from({ length: 12 }, (_, index) => ({ startMs: index * 3000, endMs: index * 3000 + 2500, speaker: String(index) }));
  const turns = pass.match(words, [], audio(100, 36000), 0, 0);
  assert.equal(pass.anchors.length, 8);
  assert.equal(turns.filter(turn => turn.speaker == null).length, 4);
});

test("slow or failed speaker requests have bounded PCM and cannot stop transcription", async () => {
  const errors = [];
  const pass = new CloudSpeakerPass({ recognize: async () => { throw new Error("provider unavailable"); }, onTurns: assert.fail, onError: value => errors.push(value) });
  pass.feed(audio(100, 20000));
  await pass.pending;
  assert.deepEqual(errors, ["provider unavailable"]);
  assert.equal(pass.audio.length, 0);
  pass.feed(audio(100, 20000));
  assert.equal(pass.audio.length, 0);
  const backlog = new CloudSpeakerPass({ recognize: async () => [], onTurns: assert.fail, onError: value => errors.push(value) });
  backlog.feed(audio(100, 91000));
  assert.equal(backlog.audio.length, 0);
  assert.match(errors[1], /could not keep up/);
});

test("cancellation aborts the second call and suppresses late labels", async () => {
  const signals = [];
  const completions = [];
  const pass = new CloudSpeakerPass({ recognize: (_, value) => { signals.push(value); return new Promise(done => { completions.push(done); }); }, onTurns: assert.fail, onError: assert.fail });
  pass.feed(audio(100, 20000));
  pass.stop();
  assert.equal(signals[0].aborted, true);
  completions[0]([{ startMs: 0, endMs: 3000, speaker: "0" }]);
  await pass.pending;
});

test("speaker assignment uses speech overlap rather than silence or physical input identity", () => {
  const segment = { startMs: 0, endMs: 20000 };
  assert.equal(dominantSpeaker(segment, [{ startMs: 15000, endMs: 19000, speaker: 3 }]), 3);
  assert.equal(dominantSpeaker(segment, [{ startMs: 1000, endMs: 4000, speaker: 1 }, { startMs: 6000, endMs: 9000, speaker: 2 }]), null);
});

test("uncertain overlap keeps earlier labels and clear corrections replace only their own interval", () => {
  const previous = [{ startMs: 0, endMs: 8000, speaker: 0 }];
  const merged = mergeSpeakerTurns(previous, { startMs: 3000, endMs: 15000, turns: [
    { startMs: 3000, endMs: 10000, speaker: null }, { startMs: 11000, endMs: 14000, speaker: 1 },
  ] });
  assert.deepEqual(merged, [...previous, { startMs: 8000, endMs: 10000, speaker: null },
    { startMs: 11000, endMs: 14000, speaker: 1 }]);
  const corrected = mergeSpeakerTurns(merged, { startMs: 4000, endMs: 16000,
    turns: [{ startMs: 5000, endMs: 9000, speaker: 2 }] });
  assert.deepEqual(corrected, [{ startMs: 0, endMs: 5000, speaker: 0 },
    { startMs: 5000, endMs: 9000, speaker: 2 }, { startMs: 11000, endMs: 14000, speaker: 1 }]);
});


test("a newly arriving voice is confirmed in a second chunk and its earlier labels are backfilled", async () => {
  const { recognize } = provider();
  const results = [];
  const pass = new CloudSpeakerPass({ recognize, onTurns: value => results.push(value), onError: assert.fail, chunkMs: 20000 });
  pass.feed(audio(100, 20000));
  await pass.pending;
  pass.feed(Buffer.concat([audio(100, 5000), audio(0, 1000), audio(200, 8000), audio(0, 6000)]));
  await pass.pending;
  assert.equal(results.at(-1).turns.at(-1).speaker, null, "one detection must not create another person");
  pass.feed(Buffer.concat([audio(200, 8000), audio(0, 12000)]));
  await pass.finish();
  const corrected = results.filter(result => result.endMs === 40000).at(-1);
  assert.equal(corrected.turns.at(-1).speaker, 1);
  assert.equal(results.at(-1).turns.at(-1).speaker, 1);
});

test("five-second updates preserve returning voices, confirm new voices and drain a short final batch", async () => {
  const { recognize, requests } = provider();
  const results = [];
  const pass = new CloudSpeakerPass({ recognize, onTurns: value => results.push(value), onError: assert.fail, chunkMs: 5000 });
  pass.feed(audio(100, 4999));
  await pass.pending;
  assert.equal(requests.length, 0);
  pass.feed(audio(100, 1));
  await pass.pending;
  assert.equal(results.at(-1).endMs, 5000);
  pass.feed(audio(100, 5000));
  await pass.pending;
  assert.equal(pass.anchors[0].audio.length, 8000 * 32, "retain the longer first sentence for future voice comparisons");
  pass.feed(audio(200, 5000));
  await pass.pending;
  assert.equal(results.at(-1).turns.at(-1).speaker, null);
  pass.feed(audio(200, 5000));
  await pass.pending;
  assert.equal(results.filter(result => result.endMs === 15000).at(-1).turns.at(-1).speaker, 1);
  assert.equal(results.at(-1).endMs - results.at(-1).startMs, 20000);
  pass.feed(audio(100, 2500));
  await pass.finish();
  assert.equal(requests.length, 5);
  assert.equal(results.at(-1).endMs, 22500);
  assert.equal(results.at(-1).turns.at(-1).speaker, 0);
  assert.ok(requests.every(request => request.length < 59 * 32000));
});

test("a longer window can split an early merged voice without mapping both people to the old identity", () => {
  const pass = new CloudSpeakerPass({ recognize: async () => [], onTurns() {}, onError: assert.fail });
  pass.anchors = [{ speaker: 0, audio: audio(100, 3000), startMs: 0, endMs: 3000, confirmed: true }];
  pass.nextSpeaker = 1;
  pass.timeline = [{ startMs: 0, endMs: 10000, speaker: 0 }];
  const words = [{ startMs: 0, endMs: 3000, speaker: "first" },
    { startMs: 3000, endMs: 9000, speaker: "second" }, { startMs: 9000, endMs: 10000, speaker: "first" }];
  const turns = pass.match(words, [{ speaker: 0, startMs: 0, endMs: 3000, inWindow: true }], audio(100, 10000), 0, 0);
  assert.deepEqual(turns.map(turn => turn.speaker), [0, 1, 0]);
  assert.equal(pass.anchors[1].confirmed, false, "confirm the new voice on another pass before publishing it");
});

test("five-second updates use continuous context and retain absent voices after five minutes", async () => {
  const { recognize, requests } = provider();
  const results = [];
  const pass = new CloudSpeakerPass({ recognize, onTurns: result => results.push(result), onError: assert.fail, chunkMs: 5000 });
  for (let i = 0; i < 6; i++) { pass.feed(audio(i < 2 ? 100 : 200, 5000)); await pass.pending; }
  assert.deepEqual(requests.map(request => request.length / 32), [5000, 10000, 15000, 20000, 25000, 30000], "no duplicate reference audio while the voice is still in the window");
  for (let i = 0; i < 60; i++) { pass.feed(audio(0, 5000)); await pass.pending; }
  pass.feed(audio(100, 5000)); await pass.pending;
  assert.equal(results.at(-1).turns.at(-1).speaker, 0, "the returning person keeps their original identity");
  assert.ok(requests.every(request => request.length <= 58000 * 32));
  assert.ok(pass.audio.length <= 30000 * 32);
  await pass.finish();
});

test("a differently recognized interjection uses the timed voice between matching words", () => {
  const segment = { id: "answer", text: "Zeit? Ja, eigentlich schon.", startMs: 4000, endMs: 16000, final: true, speaker: null };
  const words = [{ text: "Zeit?", startMs: 8300, endMs: 8840, speaker: 1 },
    { text: "Mhm", startMs: 9040, endMs: 9520, speaker: 0 },
    { text: "eigentlich", startMs: 9640, endMs: 9920, speaker: 0 },
    { text: "schon", startMs: 9920, endMs: 10200, speaker: 0 }];
  const parts = splitCloudTranscript(segment, words, [], 16000);
  assert.deepEqual(parts.map(part => [part.text, part.speaker]), [["Zeit?", 1], ["Ja, eigentlich schon.", 0]]);
  assert.equal(parts[1].startMs, 9040);
  assert.equal(parts.map(part => part.text).join(" "), segment.text);
});

test("a new live phrase cannot inherit the old speaker from a few common words", () => {
  const segment = { id: "partial", text: "Das funktioniert ja überhaupt nicht.", startMs: 20000, endMs: 24000, final: false, speaker: null };
  const words = [{ text: "Das", startMs: 17000, endMs: 17200, speaker: 0 },
    { text: "ist", startMs: 17200, endMs: 17400, speaker: 0 },
    { text: "ja", startMs: 17400, endMs: 17600, speaker: 0 },
    { text: "toll", startMs: 17600, endMs: 18000, speaker: 0 }];
  const parts = splitCloudTranscript(segment, words, [{ startMs: 17000, endMs: 18000, speaker: 0 }], 20000);
  assert.deepEqual(parts.map(part => [part.text, part.speaker]), [[segment.text, null]]);
});
