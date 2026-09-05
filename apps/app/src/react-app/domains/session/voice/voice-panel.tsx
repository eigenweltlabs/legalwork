/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Mic2, MicOff, Volume2, VolumeX } from "lucide-react";
import { VoiceWaveform, type VoiceStatus } from "./voice-waveform";
import { createVoiceAudioMeter, SILENT_VOICE_AUDIO } from "./voice-audio-meter";

import type { LegalworkServerClient } from "@/app/lib/legalwork-server";
import { cn } from "@/lib/utils";
import { useControlAction, type LegalworkControlAction } from "../../../shell/control/control-provider";
import type { VoiceActivityItem } from "./voice-activity";
import {
  updateVoiceCompletionDelivery,
  type VoiceCompletionDeliveryAttempt,
} from "./voice-completion-delivery";

export type VoiceOpenCodeJobStatus =
  | "queued"
  | "thinking"
  | "tool_use"
  | "waiting_approval"
  | "completed"
  | "cancelled"
  | "error";

export type VoiceOpenCodeJobSnapshot = {
  id: string;
  status: VoiceOpenCodeJobStatus;
  result?: string;
  error?: string;
};

type VoicePanelProps = {
  client: LegalworkServerClient;
  workspaceId: string;
  sessionId: string;
  sessionContext: string;
  job: VoiceOpenCodeJobSnapshot | null;
  activity: VoiceActivityItem[];
  onStartJob: (request: string) => Promise<{ jobId: string }>;
  onClose: () => void;
};

type RealtimeEvent = Record<string, unknown> & { type?: string };

type VoiceRuntime = {
  peer: RTCPeerConnection | null;
  channel: RTCDataChannel | null;
  stream: MediaStream | null;
  remoteAudio: HTMLAudioElement | null;
};

type VoiceResponsePurpose = "completion" | "progress" | null;

const ACTIVE_JOB_STATUSES = new Set<VoiceOpenCodeJobStatus>([
  "queued",
  "thinking",
  "tool_use",
  "waiting_approval",
]);

const VOICE_PROGRESS_UPDATE_INTERVAL_MS = 30_000;
const VOICE_FIRST_PROGRESS_DELAY_MS = 30_000;
const VOICE_PROGRESS_POLL_INTERVAL_MS = 750;
const VOICE_MAX_PROGRESS_UPDATES_PER_JOB = 1;
const VOICE_COMPLETION_MAX_ATTEMPTS = 3;
const VOICE_INPUT_RESPONSE_GRACE_MS = 2_500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, key: string) {
  if (!isRecord(value)) return "";
  const field = value[key];
  return typeof field === "string" ? field : "";
}

function parseJsonRecord(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function activityEventKey(activity: VoiceActivityItem) {
  return `${activity.id}:${activity.state}`;
}

function activitySpeechKey(activity: VoiceActivityItem) {
  return activity.label.toLocaleLowerCase().replaceAll(/\d+/g, "#").replaceAll(/\s+/g, " ").trim();
}

function voiceTextArgument(value: unknown) {
  return readString(value, "text").trim();
}

function describeError(error: unknown) {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Microphone access was denied. Allow microphone access for LegalWork, then try again.";
  }
  return error instanceof Error ? error.message : String(error);
}

async function requestMacMicrophoneAccess() {
  const ask = window.__LEGALWORK_ELECTRON__?.system?.askMicrophoneAccess;
  if (!ask) return true;
  return await ask();
}

function statusFromJob(job: VoiceOpenCodeJobSnapshot | null): VoiceStatus {
  if (!job) return "listening";
  if (job.status === "queued" || job.status === "thinking") return "thinking";
  if (job.status === "tool_use") return "tool_use";
  if (job.status === "waiting_approval") return "waiting_approval";
  if (job.status === "error") return "error";
  return "listening";
}

function statusCopy(
  status: VoiceStatus,
  error: string | null,
  microphoneMuted: boolean,
  latestActivity: VoiceActivityItem | undefined,
) {
  if (status === "connecting") return "Connecting securely…";
  if (status === "listening") return microphoneMuted ? "Microphone muted" : "Listening";
  if (status === "thinking" || status === "tool_use") return latestActivity?.label || "Working on it…";
  if (status === "waiting_approval") return "I need your approval in the app";
  if (status === "speaking") return "Speaking";
  return error || "Voice mode encountered an error";
}

export function VoicePanel(props: VoicePanelProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<VoiceRuntime>({ peer: null, channel: null, stream: null, remoteAudio: null });
  const audioMeterRef = useRef<ReturnType<typeof createVoiceAudioMeter>>(null);
  const jobRef = useRef(props.job);
  const startJobRef = useRef(props.onStartJob);
  const announcedCompletionsRef = useRef(new Set<string>());
  const completionAttemptsRef = useRef(new Map<string, number>());
  const completionDeliveryRef = useRef<VoiceCompletionDeliveryAttempt | null>(null);
  const announcedActivityLabelsRef = useRef(new Set<string>());
  const syncedActivityIdsRef = useRef(new Set<string>());
  const latestActivityRef = useRef<VoiceActivityItem | undefined>(props.activity.at(-1));
  const handledCallIdsRef = useRef(new Set<string>());
  const pendingFunctionResponseRef = useRef<string | null>(null);
  const progressJobIdRef = useRef<string | null>(null);
  const spokenProgressCountRef = useRef(0);
  const lastProgressUpdateAtRef = useRef(0);
  const responseActiveRef = useRef(false);
  const responsePurposeRef = useRef<VoiceResponsePurpose>(null);
  const inputResponsePendingRef = useRef(false);
  const inputResponseGraceTimerRef = useRef<number | null>(null);
  const inputActiveRef = useRef(false);
  const outputAudioActiveRef = useRef(false);
  const microphoneMutedRef = useRef(false);
  const outputMutedRef = useRef(false);
  const didStartRef = useRef(false);
  const statusRef = useRef<VoiceStatus>("connecting");
  const [status, setStatus] = useState<VoiceStatus>("connecting");
  const [connected, setConnected] = useState(false);
  const [microphoneMuted, setMicrophoneMuted] = useState(false);
  const [outputMuted, setOutputMuted] = useState(false);
  const [responseSettledRevision, setResponseSettledRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    jobRef.current = props.job;
    startJobRef.current = props.onStartJob;
  }, [props.job, props.onStartJob]);

  const updateStatus = useCallback((next: VoiceStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const sendEvent = useCallback((event: Record<string, unknown>) => {
    const channel = runtimeRef.current.channel;
    if (!channel || channel.readyState !== "open") return false;
    channel.send(JSON.stringify(event));
    return true;
  }, []);

  const requestResponse = useCallback((response?: Record<string, unknown>, purpose: VoiceResponsePurpose = null) => {
    const sent = sendEvent({ type: "response.create", ...(response ? { response } : {}) });
    if (sent) {
      responseActiveRef.current = true;
      responsePurposeRef.current = purpose;
    }
    return sent;
  }, [sendEvent]);

  const stopRuntime = useCallback(() => {
    audioMeterRef.current?.dispose();
    audioMeterRef.current = null;
    const runtime = runtimeRef.current;
    runtime.channel?.close();
    runtime.peer?.close();
    runtime.stream?.getTracks().forEach((track) => track.stop());
    if (runtime.remoteAudio) {
      runtime.remoteAudio.pause();
      runtime.remoteAudio.srcObject = null;
    }
    runtimeRef.current = { peer: null, channel: null, stream: null, remoteAudio: null };
    responseActiveRef.current = false;
    responsePurposeRef.current = null;
    inputResponsePendingRef.current = false;
    if (inputResponseGraceTimerRef.current !== null) {
      window.clearTimeout(inputResponseGraceTimerRef.current);
      inputResponseGraceTimerRef.current = null;
    }
    completionDeliveryRef.current = null;
    pendingFunctionResponseRef.current = null;
    inputActiveRef.current = false;
    outputAudioActiveRef.current = false;
    setConnected(false);
  }, []);

  const sendFunctionOutput = useCallback((
    callId: string,
    output: Record<string, unknown>,
    responseInstructions: string,
  ) => {
    if (!sendEvent({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      },
    })) return false;
    if (responseActiveRef.current) {
      pendingFunctionResponseRef.current = responseInstructions;
      return true;
    }
    return requestResponse({
      instructions: responseInstructions,
      tool_choice: "none",
      tools: [],
    });
  }, [requestResponse, sendEvent]);

  const handleFunctionCall = useCallback(async (event: RealtimeEvent) => {
    const callId = readString(event, "call_id").trim();
    const name = readString(event, "name").trim();
    if (
      !callId
      || (name !== "continue_work" && name !== "answer_in_voice")
      || handledCallIdsRef.current.has(callId)
    ) return;
    handledCallIdsRef.current.add(callId);

    if (name === "answer_in_voice") {
      const args = parseJsonRecord(readString(event, "arguments"));
      const intent = readString(args, "intent");
      sendFunctionOutput(
        callId,
        { ready: true },
        intent === "clarify"
          ? "Ask exactly one concise question for the essential missing detail. Do not answer the request yet, do not start work, and do not mention routing, functions, tools, or another assistant."
          : "Answer the user's last turn naturally using only the session and live context you already have. Do not mention routing, functions, tools, or another assistant.",
      );
      return;
    }

    const args = parseJsonRecord(readString(event, "arguments"));
    const request = readString(args, "request").trim();
    if (!request) {
      sendFunctionOutput(
        callId,
        { accepted: false, error: "A work request is required." },
        "Ask the user in one short sentence to repeat what they want you to do. Do not mention a function or tool.",
      );
      return;
    }

    updateStatus("thinking");
    try {
      await startJobRef.current(request);
      sendFunctionOutput(
        callId,
        { accepted: true },
        "Say exactly: ‘I’m on it.’ Do not say anything else.",
      );
    } catch (submitError) {
      const message = describeError(submitError);
      setError(message);
      sendFunctionOutput(
        callId,
        { accepted: false, error: message },
        "Briefly tell the user in the first person that you could not start the requested work and state the supplied error. Do not mention routing, a function, a tool, or another assistant.",
      );
      updateStatus("error");
    }
  }, [sendFunctionOutput, updateStatus]);

  const handleRealtimeEvent = useCallback((event: RealtimeEvent) => {
    const type = readString(event, "type");
    if (type === "input_audio_buffer.speech_started") {
      // Semantic VAD owns interruption. Barge-in never cancels the task agent.
      inputActiveRef.current = true;
      inputResponsePendingRef.current = false;
      if (inputResponseGraceTimerRef.current !== null) {
        window.clearTimeout(inputResponseGraceTimerRef.current);
        inputResponseGraceTimerRef.current = null;
      }
      completionDeliveryRef.current = null;
      updateStatus("listening");
      return;
    }
    if (type === "input_audio_buffer.speech_stopped") {
      inputActiveRef.current = false;
      // Keep proactive speech out of the brief gap before response.created,
      // but do not claim an active response indefinitely when VAD discards
      // ambient audio without creating a turn.
      inputResponsePendingRef.current = true;
      if (inputResponseGraceTimerRef.current !== null) window.clearTimeout(inputResponseGraceTimerRef.current);
      inputResponseGraceTimerRef.current = window.setTimeout(() => {
        inputResponsePendingRef.current = false;
        inputResponseGraceTimerRef.current = null;
        setResponseSettledRevision((revision) => revision + 1);
      }, VOICE_INPUT_RESPONSE_GRACE_MS);
      setResponseSettledRevision((revision) => revision + 1);
      updateStatus("thinking");
      return;
    }
    if (type === "response.function_call_arguments.done") {
      void handleFunctionCall(event);
      return;
    }
    if (type === "response.created") {
      inputResponsePendingRef.current = false;
      if (inputResponseGraceTimerRef.current !== null) {
        window.clearTimeout(inputResponseGraceTimerRef.current);
        inputResponseGraceTimerRef.current = null;
      }
      responseActiveRef.current = true;
      return;
    }
    if (type === "output_audio_buffer.started") {
      outputAudioActiveRef.current = true;
      const delivery = updateVoiceCompletionDelivery(completionDeliveryRef.current, { type: "audio_started" });
      completionDeliveryRef.current = delivery.attempt;
      updateStatus("speaking");
      return;
    }
    if (type === "response.audio.delta" || type === "response.output_audio.delta") {
      outputAudioActiveRef.current = true;
      const delivery = updateVoiceCompletionDelivery(completionDeliveryRef.current, { type: "audio_started" });
      completionDeliveryRef.current = delivery.attempt;
      updateStatus("speaking");
      return;
    }
    if (type === "output_audio_buffer.stopped" || type === "output_audio_buffer.cleared") {
      outputAudioActiveRef.current = false;
      const delivery = updateVoiceCompletionDelivery(
        completionDeliveryRef.current,
        { type: type === "output_audio_buffer.cleared" ? "audio_cleared" : "audio_stopped" },
      );
      completionDeliveryRef.current = delivery.attempt;
      if (delivery.deliveredJobId) announcedCompletionsRef.current.add(delivery.deliveredJobId);
      setResponseSettledRevision((revision) => revision + 1);
      updateStatus(statusFromJob(jobRef.current));
      return;
    }
    if (type === "response.done") {
      const purpose = responsePurposeRef.current;
      const response = isRecord(event.response) ? event.response : null;
      const responseStatus = response ? readString(response, "status") : "";
      responseActiveRef.current = false;
      responsePurposeRef.current = null;
      inputResponsePendingRef.current = false;
      if (inputResponseGraceTimerRef.current !== null) {
        window.clearTimeout(inputResponseGraceTimerRef.current);
        inputResponseGraceTimerRef.current = null;
      }
      if (purpose === "completion") {
        const delivery = updateVoiceCompletionDelivery(completionDeliveryRef.current, {
          type: "response_done",
          completed: !responseStatus || responseStatus === "completed",
        });
        completionDeliveryRef.current = delivery.attempt;
        if (delivery.deliveredJobId) announcedCompletionsRef.current.add(delivery.deliveredJobId);
      }
      const pendingFunctionResponse = pendingFunctionResponseRef.current;
      if (pendingFunctionResponse) {
        pendingFunctionResponseRef.current = null;
        requestResponse({
          instructions: pendingFunctionResponse,
          tool_choice: "none",
          tools: [],
        });
      }
      setResponseSettledRevision((revision) => revision + 1);
      if (!outputAudioActiveRef.current) updateStatus(statusFromJob(jobRef.current));
      return;
    }
    if (type === "error") {
      const eventError = isRecord(event.error) ? event.error : null;
      const message = eventError && typeof eventError.message === "string" ? eventError.message : "The voice service reported an error.";
      responseActiveRef.current = false;
      responsePurposeRef.current = null;
      inputResponsePendingRef.current = false;
      if (inputResponseGraceTimerRef.current !== null) {
        window.clearTimeout(inputResponseGraceTimerRef.current);
        inputResponseGraceTimerRef.current = null;
      }
      completionDeliveryRef.current = null;
      setError(message);
      updateStatus("error");
    }
  }, [handleFunctionCall, requestResponse, updateStatus]);

  const startVoice = useCallback(async () => {
    if (runtimeRef.current.peer) return { connected: true };
    setError(null);
    updateStatus("connecting");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture is unavailable in this runtime.");
      if (!(await requestMacMicrophoneAccess())) {
        throw new Error("macOS denied microphone access. Enable LegalWork in System Settings > Privacy & Security > Microphone.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      const peer = new RTCPeerConnection();
      const remoteAudio = new Audio();
      audioMeterRef.current = createVoiceAudioMeter();
      audioMeterRef.current?.setInputStream(stream);
      remoteAudio.autoplay = true;
      remoteAudio.muted = outputMutedRef.current;
      peer.ontrack = (event) => {
        const remoteStream = event.streams[0] ?? new MediaStream([event.track]);
        remoteAudio.srcObject = remoteStream;
        audioMeterRef.current?.setOutputStream(remoteStream);
        void remoteAudio.play().catch(() => undefined);
      };
      stream.getAudioTracks().forEach((track) => { track.enabled = !microphoneMutedRef.current; });
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));

      const channel = peer.createDataChannel("oai-events");
      channel.onopen = () => {
        setConnected(true);
        updateStatus(statusFromJob(jobRef.current));
      };
      channel.onmessage = (message) => {
        try {
          const parsed: unknown = JSON.parse(String(message.data));
          if (isRecord(parsed)) handleRealtimeEvent(parsed);
        } catch {
          // Ignore malformed data-channel events; protocol errors arrive separately.
        }
      };
      channel.onerror = () => {
        setError("The Realtime data channel failed.");
        updateStatus("error");
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState !== "failed") return;
        setError("The Realtime WebRTC connection failed.");
        updateStatus("error");
        stopRuntime();
      };
      runtimeRef.current = { peer, channel, stream, remoteAudio };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const localSdp = peer.localDescription?.sdp || offer.sdp;
      if (!localSdp) throw new Error("WebRTC did not create an SDP offer.");
      const call = await props.client.createVoiceRealtimeCall({
        sdp: localSdp,
        sessionContext: props.sessionContext,
      });
      await peer.setRemoteDescription({ type: "answer", sdp: call.sdp });
      return { connected: true, model: call.model, providerId: call.providerId };
    } catch (startError) {
      stopRuntime();
      const message = describeError(startError);
      setError(message);
      updateStatus("error");
      return { connected: false, error: message };
    }
  }, [handleRealtimeEvent, props.client, props.sessionContext, stopRuntime, updateStatus]);

  useEffect(() => {
    if (didStartRef.current) return;
    didStartRef.current = true;
    void startVoice();
  }, [startVoice]);

  useEffect(() => stopRuntime, [stopRuntime]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.repeat) return;
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [props.onClose]);

  useEffect(() => {
    if (status === "speaking" || status === "connecting" || status === "error") return;
    updateStatus(statusFromJob(props.job));
  }, [props.job, status, updateStatus]);

  useEffect(() => {
    const job = props.job;
    if (
      !connected
      || outputMuted
      || inputActiveRef.current
      || inputResponsePendingRef.current
      || responseActiveRef.current
      || outputAudioActiveRef.current
      || status === "speaking"
      || !job
      || job.status !== "completed"
      || !job.result
      || announcedCompletionsRef.current.has(job.id)
      || completionDeliveryRef.current?.jobId === job.id
      || (completionAttemptsRef.current.get(job.id) ?? 0) >= VOICE_COMPLETION_MAX_ATTEMPTS
    ) return;
    if (!sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [{
          type: "input_text",
          text: `Your current work is complete. Here is the full canonical result from your session:\n\n${job.result}\n\nTreat this result as your own work. Give a concise spoken summary; do not read the full answer verbatim.`,
        }],
      },
    })) return;
    completionDeliveryRef.current = {
      jobId: job.id,
      responseDone: false,
      audioStarted: false,
      audioStopped: false,
    };
    if (!requestResponse({
      instructions: "Give a natural two-to-four-sentence spoken summary of the completed result. State the outcome, the most important detail, and a useful next step. Do not read headings, citations, or long lists aloud. Speak in the first person, and mention that the full details are visible only if helpful.",
      tools: [],
      tool_choice: "none",
    }, "completion")) {
      completionDeliveryRef.current = null;
      return;
    }
    completionAttemptsRef.current.set(job.id, (completionAttemptsRef.current.get(job.id) ?? 0) + 1);
  }, [connected, outputMuted, props.job, requestResponse, responseSettledRevision, sendEvent, status]);

  useEffect(() => {
    latestActivityRef.current = props.activity.at(-1);
  }, [props.activity]);

  useEffect(() => {
    const job = props.job;
    if (!job || !ACTIVE_JOB_STATUSES.has(job.status) || progressJobIdRef.current === job.id) return;
    progressJobIdRef.current = job.id;
    lastProgressUpdateAtRef.current = Date.now() - VOICE_PROGRESS_UPDATE_INTERVAL_MS + VOICE_FIRST_PROGRESS_DELAY_MS;
    announcedActivityLabelsRef.current.clear();
    syncedActivityIdsRef.current.clear();
    spokenProgressCountRef.current = 0;
  }, [props.job]);

  useEffect(() => {
    if (!connected) return;
    for (const activity of props.activity) {
      const eventKey = activityEventKey(activity);
      if (syncedActivityIdsRef.current.has(eventKey)) continue;
      if (!sendEvent({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "system",
          content: [{
            type: "input_text",
            text: `Activity metadata from your current work: ${activity.label} (${activity.state}). This is not a result. Never infer findings, absence of findings, or completion from it.`,
          }],
        },
      })) break;
      syncedActivityIdsRef.current.add(eventKey);
    }
  }, [connected, props.activity, sendEvent]);

  useEffect(() => {
    if (!connected) return;
    const maybeSpeakProgress = () => {
      const job = jobRef.current;
      const latestActivity = latestActivityRef.current;
      if (
        outputMutedRef.current
        || inputActiveRef.current
        || responseActiveRef.current
        || outputAudioActiveRef.current
        || statusRef.current === "speaking"
        || !job
        || !ACTIVE_JOB_STATUSES.has(job.status)
        || !latestActivity
        || latestActivity.state !== "active"
        || spokenProgressCountRef.current >= VOICE_MAX_PROGRESS_UPDATES_PER_JOB
        || announcedActivityLabelsRef.current.has(activitySpeechKey(latestActivity))
        || Date.now() - lastProgressUpdateAtRef.current < VOICE_PROGRESS_UPDATE_INTERVAL_MS
      ) return;

      if (!requestResponse({
        instructions: `Say only what you are currently doing based on this activity label: "${latestActivity.label}". Use one natural first-person sentence of at most twelve words. Do not state or imply any finding, result, absence of a result, uncertainty, completion, or next step. Do not mention a task, worker, handoff, system, or tool.`,
        tools: [],
        tool_choice: "none",
      }, "progress")) return;
      announcedActivityLabelsRef.current.add(activitySpeechKey(latestActivity));
      spokenProgressCountRef.current += 1;
      lastProgressUpdateAtRef.current = Date.now();
    };

    const interval = window.setInterval(maybeSpeakProgress, VOICE_PROGRESS_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [connected, requestResponse]);

  useEffect(() => {
    const jobStatus = props.job?.status;
    if (outputMuted || !connected || !jobStatus || !ACTIVE_JOB_STATUSES.has(jobStatus)) return;
    const playProgressSound = () => {
      if (statusRef.current === "speaking") return;
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = jobStatus === "tool_use" ? 510 : jobStatus === "waiting_approval" ? 390 : 440;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.025, context.currentTime + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.16);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.18);
      oscillator.addEventListener("ended", () => void context.close());
    };
    const interval = window.setInterval(playProgressSound, jobStatus === "tool_use" ? 5_000 : 8_000);
    return () => window.clearInterval(interval);
  }, [connected, outputMuted, props.job?.status]);

  const toggleMicrophone = useCallback(() => {
    const next = !microphoneMuted;
    microphoneMutedRef.current = next;
    setMicrophoneMuted(next);
    runtimeRef.current.stream?.getAudioTracks().forEach((track) => { track.enabled = !next; });
    if (next) {
      inputActiveRef.current = false;
      inputResponsePendingRef.current = false;
      if (inputResponseGraceTimerRef.current !== null) {
        window.clearTimeout(inputResponseGraceTimerRef.current);
        inputResponseGraceTimerRef.current = null;
      }
      setResponseSettledRevision((revision) => revision + 1);
    }
    return { microphoneMuted: next };
  }, [microphoneMuted]);

  const toggleOutput = useCallback(() => {
    const next = !outputMuted;
    outputMutedRef.current = next;
    setOutputMuted(next);
    if (runtimeRef.current.remoteAudio) runtimeRef.current.remoteAudio.muted = next;
    return { outputMuted: next };
  }, [outputMuted]);

  const sendTextCommand = useCallback((text: string) => {
    const command = text.trim();
    if (!command) return { sent: false, error: "Text is required." };
    if (!connected) return { sent: false, error: "Voice Mode is not connected." };
    if (!sendEvent({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: command }],
      },
    })) return { sent: false, error: "Voice Mode is not connected." };
    updateStatus("thinking");
    return requestResponse()
      ? { sent: true }
      : { sent: false, error: "Voice Mode could not start a response." };
  }, [connected, requestResponse, sendEvent, updateStatus]);

  const injectAudio = useCallback((args: unknown) => {
    const pcm16Base64 = readString(args, "pcm16Base64").trim();
    if (!pcm16Base64) return { sent: false, error: "pcm16Base64 is required." };
    let sent = true;
    for (let index = 0; index < pcm16Base64.length; index += 32_000) {
      sent = sendEvent({ type: "input_audio_buffer.append", audio: pcm16Base64.slice(index, index + 32_000) }) && sent;
    }
    return sent ? { sent: true } : { sent: false, error: "Voice Mode is not connected." };
  }, [sendEvent]);

  const startAction = useMemo<LegalworkControlAction>(() => ({
    id: "voice.start",
    label: "Start Voice Mode",
    description: "Connect Voice Mode to OpenAI Realtime.",
    sideEffect: "external",
    disabled: connected || status === "connecting",
    targetRef: rootRef,
    execute: startVoice,
  }), [connected, startVoice, status]);
  useControlAction(startAction);

  const stopAction = useMemo<LegalworkControlAction>(() => ({
    id: "voice.stop",
    label: "Stop Voice Mode",
    description: "Close Voice Mode and release its media resources.",
    sideEffect: "external",
    targetRef: rootRef,
    execute: () => { props.onClose(); return { stopped: true }; },
  }), [props.onClose]);
  useControlAction(stopAction);

  const muteAction = useMemo<LegalworkControlAction>(() => ({
    id: "voice.toggle_mute",
    label: microphoneMuted ? "Unmute microphone" : "Mute microphone",
    description: "Mute or unmute microphone input without changing spoken replies.",
    sideEffect: "none",
    disabled: !connected,
    targetRef: rootRef,
    execute: toggleMicrophone,
  }), [connected, microphoneMuted, toggleMicrophone]);
  useControlAction(muteAction);

  const outputAction = useMemo<LegalworkControlAction>(() => ({
    id: "voice.toggle_output",
    label: outputMuted ? "Unmute voice" : "Mute voice",
    description: "Mute or unmute spoken replies and progress sounds without changing the microphone.",
    sideEffect: "none",
    disabled: !connected,
    targetRef: rootRef,
    execute: toggleOutput,
  }), [connected, outputMuted, toggleOutput]);
  useControlAction(outputAction);

  const sendTextAction = useMemo<LegalworkControlAction>(() => ({
    id: "voice.send_text",
    label: "Send text through Voice Mode",
    description: "Deterministic test hook for a spoken request.",
    sideEffect: "external",
    requiresArgs: true,
    args: [{ name: "text", type: "string", required: true }],
    targetRef: rootRef,
    execute: (args) => sendTextCommand(voiceTextArgument(args)),
  }), [sendTextCommand]);
  useControlAction(sendTextAction);

  const injectTranscriptAction = useMemo<LegalworkControlAction>(() => ({
    id: "voice.inject_transcript",
    label: "Inject a voice transcript",
    description: "Deterministic test hook for a transcribed request.",
    sideEffect: "external",
    requiresArgs: true,
    args: [{ name: "text", type: "string", required: true }],
    targetRef: rootRef,
    execute: (args) => sendTextCommand(voiceTextArgument(args)),
  }), [sendTextCommand]);
  useControlAction(injectTranscriptAction);

  const injectAudioAction = useMemo<LegalworkControlAction>(() => ({
    id: "voice.inject_audio",
    label: "Inject voice audio",
    description: "Deterministic test hook for PCM16 audio through semantic VAD.",
    sideEffect: "external",
    requiresArgs: true,
    args: [{ name: "pcm16Base64", type: "string", required: true }],
    targetRef: rootRef,
    execute: injectAudio,
  }), [injectAudio]);
  useControlAction(injectAudioAction);

  const statusAction = useMemo<LegalworkControlAction>(() => ({
    id: "voice.status",
    label: "Read Voice Mode status",
    description: "Return the voice connection and current conversation state.",
    sideEffect: "none",
    targetRef: rootRef,
    execute: () => ({
      connected,
      status,
      microphoneMuted,
      outputMuted,
      workspaceId: props.workspaceId,
      sessionId: props.sessionId,
      job: props.job,
      activity: props.activity,
      error,
    }),
  }), [connected, error, microphoneMuted, outputMuted, props.activity, props.job, props.sessionId, props.workspaceId, status]);
  useControlAction(statusAction);

  const latestActivity = props.activity.at(-1);
  const sampleVoiceAudio = useCallback(() => audioMeterRef.current?.sample(
    !microphoneMutedRef.current, !outputMutedRef.current,
  ) ?? SILENT_VOICE_AUDIO, []);

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 flex flex-col items-center justify-end overflow-hidden bg-gradient-to-b from-background/35 via-background/75 to-background pb-8"
      data-testid="voice-mode"
    >
      <div className="relative flex w-80 max-w-[calc(100%_-_2rem)] flex-col items-center gap-4 rounded-[2rem] bg-background/72 px-8 py-6 shadow-[0_18px_70px_rgba(15,23,42,0.08)] backdrop-blur-md">
        <VoiceWaveform status={status} sample={sampleVoiceAudio} />
        <div className="min-h-11 w-full text-center" aria-live="polite">
          <div className={cn("text-sm font-medium text-dls-text", status === "error" && "text-red-11")}>
            {statusCopy(status, error, microphoneMuted, latestActivity)}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleMicrophone}
            disabled={!connected}
            className={cn(
              "grid size-9 place-items-center rounded-full border border-dls-border bg-background/90 text-dls-secondary shadow-sm transition-colors hover:bg-dls-hover hover:text-dls-text disabled:opacity-40",
              microphoneMuted && "bg-dls-hover text-dls-text",
            )}
            aria-label={microphoneMuted ? "Unmute microphone" : "Mute microphone"}
            title={microphoneMuted ? "Unmute microphone" : "Mute microphone"}
          >
            {microphoneMuted ? <MicOff size={15} /> : <Mic2 size={15} />}
          </button>
          <button
            type="button"
            onClick={toggleOutput}
            disabled={!connected}
            className={cn(
              "grid size-9 place-items-center rounded-full border border-dls-border bg-background/90 text-dls-secondary shadow-sm transition-colors hover:bg-dls-hover hover:text-dls-text disabled:opacity-40",
              outputMuted && "bg-dls-hover text-dls-text",
            )}
            aria-label={outputMuted ? "Unmute voice" : "Mute voice"}
            title={outputMuted ? "Unmute voice" : "Mute voice"}
          >
            {outputMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
        </div>
      </div>
    </div>
  );
}
