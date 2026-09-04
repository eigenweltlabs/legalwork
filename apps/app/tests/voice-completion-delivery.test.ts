import { describe, expect, test } from "bun:test";

import {
  updateVoiceCompletionDelivery,
  type VoiceCompletionDeliveryAttempt,
} from "../src/react-app/domains/session/voice/voice-completion-delivery";

function pendingAttempt(): VoiceCompletionDeliveryAttempt {
  return {
    jobId: "job-1",
    responseDone: false,
    audioStarted: false,
    audioStopped: false,
  };
}

describe("voice completion delivery", () => {
  test("counts a completion only after a completed response finishes playback", () => {
    const started = updateVoiceCompletionDelivery(pendingAttempt(), { type: "audio_started" });
    expect(started.deliveredJobId).toBeNull();

    const generated = updateVoiceCompletionDelivery(started.attempt, {
      type: "response_done",
      completed: true,
    });
    expect(generated.deliveredJobId).toBeNull();

    const played = updateVoiceCompletionDelivery(generated.attempt, { type: "audio_stopped" });
    expect(played).toEqual({ attempt: null, deliveredJobId: "job-1" });
  });

  test("supports playback finishing before response.done arrives", () => {
    const started = updateVoiceCompletionDelivery(pendingAttempt(), { type: "audio_started" });
    const played = updateVoiceCompletionDelivery(started.attempt, { type: "audio_stopped" });
    const generated = updateVoiceCompletionDelivery(played.attempt, {
      type: "response_done",
      completed: true,
    });

    expect(generated).toEqual({ attempt: null, deliveredJobId: "job-1" });
  });

  test("does not count a token-limited response as delivered", () => {
    const started = updateVoiceCompletionDelivery(pendingAttempt(), { type: "audio_started" });
    const incomplete = updateVoiceCompletionDelivery(started.attempt, {
      type: "response_done",
      completed: false,
    });

    expect(incomplete).toEqual({ attempt: null, deliveredJobId: null });
  });

  test("does not count interrupted or silent output as delivered", () => {
    const started = updateVoiceCompletionDelivery(pendingAttempt(), { type: "audio_started" });
    expect(updateVoiceCompletionDelivery(started.attempt, { type: "audio_cleared" }))
      .toEqual({ attempt: null, deliveredJobId: null });
    expect(updateVoiceCompletionDelivery(pendingAttempt(), { type: "response_done", completed: true }))
      .toEqual({ attempt: null, deliveredJobId: null });
  });
});
