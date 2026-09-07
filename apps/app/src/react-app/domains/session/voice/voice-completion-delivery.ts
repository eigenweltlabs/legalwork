export type VoiceCompletionDeliveryAttempt = {
  jobId: string;
  responseDone: boolean;
  audioStarted: boolean;
  audioStopped: boolean;
};

export type VoiceCompletionDeliveryEvent =
  | { type: "audio_started" }
  | { type: "audio_stopped" }
  | { type: "audio_cleared" }
  | { type: "response_done"; completed: boolean };

export type VoiceCompletionDeliveryUpdate = {
  attempt: VoiceCompletionDeliveryAttempt | null;
  deliveredJobId: string | null;
};

export function updateVoiceCompletionDelivery(
  attempt: VoiceCompletionDeliveryAttempt | null,
  event: VoiceCompletionDeliveryEvent,
): VoiceCompletionDeliveryUpdate {
  if (!attempt) return { attempt: null, deliveredJobId: null };

  if (event.type === "audio_started") {
    return {
      attempt: { ...attempt, audioStarted: true },
      deliveredJobId: null,
    };
  }

  if (event.type === "audio_cleared") {
    return { attempt: null, deliveredJobId: null };
  }

  if (event.type === "audio_stopped") {
    const next = { ...attempt, audioStopped: true };
    return next.responseDone && next.audioStarted
      ? { attempt: null, deliveredJobId: next.jobId }
      : { attempt: next, deliveredJobId: null };
  }

  if (!event.completed || !attempt.audioStarted) {
    return { attempt: null, deliveredJobId: null };
  }

  const next = { ...attempt, responseDone: true };
  return next.audioStopped
    ? { attempt: null, deliveredJobId: next.jobId }
    : { attempt: next, deliveredJobId: null };
}
