import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";
import { CloudSpeakerPass } from "./cloud-speakers.mjs";

export const SPEAKER_BATCH_MS = 30000;

/** Save PCM locally during capture. Speaker requests begin only after Stop. */
export class DeferredCloudSpeakerPass {
  constructor({ recognize, onTurns, onError, onMerge = (_aliases) => {}, createVoiceVerifier = null }) {
    this.folder = fs.mkdtempSync(path.join(os.tmpdir(), "legalwork-speakers-"));
    this.file = path.join(this.folder, "audio.pcm");
    this.writer = fs.createWriteStream(this.file, { mode: 0o600 });
    this.reader = null;
    this.stopped = false;
    this.ending = false;
    this.cleanup = null;
    this.onError = onError;
    this.onMerge = onMerge;
    this.verifier = null;
    this.verifierFailed = false;
    this.pass = new CloudSpeakerPass({ recognize, onTurns,
      verifyVoices: createVoiceVerifier ? async (audio, offsetMs, turns) => {
        if (this.verifierFailed) return null;
        try {
          this.verifier ??= await createVoiceVerifier();
          if (this.stopped) { this.verifier.stop(); return null; }
          return await this.verifier.verify(audio, offsetMs, turns);
        } catch {
          if (!this.stopped) this.onError("Voice matching is unavailable. The transcript keeps its audio input labels.");
          this.verifierFailed = true;
          this.verifier?.stop();
          return null;
        }
      } : null,
      onError: (error, recoverable) => recoverable ? this.onError(error) : this.fail(error), chunkMs: SPEAKER_BATCH_MS });
    this.writer.on("error", error => this.fail(error));
  }

  feed(bytes) {
    if (this.stopped || this.ending) return;
    this.writer.write(bytes);
    if (this.writer.writableLength > 90_000 * 32) this.fail("Could not save audio for speaker detection. Your transcript is still being saved.");
  }

  async finish() {
    if (this.stopped || this.ending) return;
    this.ending = true;
    try {
      const drained = finished(this.writer);
      this.writer.end();
      await drained;
      if (this.stopped) return;
      this.reader = fs.createReadStream(this.file, { highWaterMark: SPEAKER_BATCH_MS * 32 });
      for await (const bytes of this.reader) {
        if (this.stopped) break;
        this.pass.feed(bytes);
        await this.pass.pending;
      }
      if (!this.stopped) await this.pass.finish();
      if (!this.stopped && this.verifier && !this.verifierFailed) {
        const aliases = await this.verifier.finish();
        if (!this.stopped) this.onMerge(aliases);
      }
    } catch (error) {
      this.fail(error);
    } finally {
      await this.stop();
    }
  }

  fail(error) {
    if (this.stopped) return;
    this.stop();
    this.onError(error instanceof Error ? error.message : String(error));
  }

  stop() {
    if (!this.stopped) {
      this.stopped = true;
      this.writer.destroy();
      this.reader?.destroy();
      this.pass.stop();
      this.verifier?.stop();
      this.cleanup = fsp.rm(this.folder, { recursive: true, force: true }).catch(() => {});
    }
    return this.cleanup;
  }
}
