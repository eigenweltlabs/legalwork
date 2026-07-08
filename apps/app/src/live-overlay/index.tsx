/** @jsxImportSource react */
/**
 * Call overlay renderer — a compact always-on-top card shown over meeting
 * apps: live captions from the local transcriber, AI-suggested follow-up
 * questions, and a type-to-ask box answered by the main window's session AI.
 * Loaded by apps/desktop/electron/audio/call-overlay.mjs.
 */
import * as React from "react";
import ReactDOM from "react-dom/client";
import { EyeOff, Loader2, Radio, SendHorizontal, Sparkles, X } from "lucide-react";

import { initLocale, t } from "../i18n";
import type { AudioRecorderEvent, AudioTranscriptSegment } from "@legalwork/types/audio";
import "../app/index.css";

type CallOverlayApi = {
  onEvent: (callback: (event: AudioRecorderEvent) => void) => () => void;
  ask: (askId: string, question: string) => void;
  suggest: (askId: string) => void;
  hide: () => void;
  platform: "darwin" | "windows" | "linux";
};

declare global {
  interface Window {
    __LEGALWORK_CALL_OVERLAY__?: CallOverlayApi;
  }
}

type Answer = {
  askId: string;
  kind: "question" | "suggestions";
  question: string;
  text: string;
  pending: boolean;
  error: string | null;
};

const MAX_VISIBLE_SEGMENTS = 4;
/** No answer within this window → show an error instead of spinning forever
 * (the main window may have been closed mid-call). */
const ASK_TIMEOUT_MS = 120_000;

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function OverlayApp() {
  const api = window.__LEGALWORK_CALL_OVERLAY__;
  const [segments, setSegments] = React.useState<AudioTranscriptSegment[]>([]);
  const [partial, setPartial] = React.useState<AudioTranscriptSegment | null>(null);
  const [answers, setAnswers] = React.useState<Answer[]>([]);
  const [question, setQuestion] = React.useState("");
  const transcriptRef = React.useRef<HTMLDivElement>(null);
  const answersRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!api) return;
    return api.onEvent((event) => {
      switch (event.type) {
        case "recording-started":
          // New recording → clocks restart at 0; drop the previous call's captions.
          setSegments([]);
          setPartial(null);
          break;
        case "transcript-segment":
          setSegments((current) => [...current, event.segment].slice(-60));
          setPartial((current) =>
            current && current.endMs <= event.segment.endMs ? null : current,
          );
          break;
        case "transcript-partial":
          setPartial(event.segment);
          break;
        case "transcript-partial-clear":
          setPartial((current) => (current && current.endMs <= event.endMs ? null : current));
          break;
        case "ask-answer":
          setAnswers((current) =>
            current.map((answer) =>
              answer.askId === event.askId
                ? { ...answer, text: event.text, pending: !event.done, error: event.error }
                : answer,
            ),
          );
          break;
        default:
          break;
      }
    });
  }, [api]);

  React.useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [segments.length, partial?.text]);
  React.useEffect(() => {
    answersRef.current?.scrollTo({ top: answersRef.current.scrollHeight, behavior: "smooth" });
  }, [answers]);

  const submitAsk = React.useCallback(
    (kind: Answer["kind"], text: string) => {
      if (!api) return;
      const askId = `overlay-${Date.now().toString(36)}`;
      setAnswers((current) => [
        ...current.slice(-8),
        { askId, kind, question: text, text: "", pending: true, error: null },
      ]);
      window.setTimeout(() => {
        setAnswers((current) =>
          current.map((answer) =>
            answer.askId === askId && answer.pending
              ? { ...answer, pending: false, error: "No answer — is the LegalWork window open?" }
              : answer,
          ),
        );
      }, ASK_TIMEOUT_MS);
      if (kind === "suggestions") api.suggest(askId);
      else api.ask(askId, text);
    },
    [api],
  );

  const visibleSegments = segments.slice(-MAX_VISIBLE_SEGMENTS);
  const latestAnswer = answers[answers.length - 1] ?? null;

  return (
    <div className="flex h-dvh flex-col overflow-hidden rounded-2xl border border-border/70 bg-background/90 text-foreground shadow-2xl backdrop-blur-xl">
      {/* Drag header */}
      <div
        className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <Radio className="size-3.5 text-primary" />
        <span className="text-xs font-semibold tracking-wide">{t("recorder.overlay_title")}</span>
        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
          <EyeOff className="size-3" />
          {t("recorder.overlay_hidden_note")}
        </span>
        <div className="ml-auto flex items-center gap-1" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <button
            type="button"
            aria-label={t("recorder.overlay_close")}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => api?.hide()}
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      {/* Live captions */}
      <div ref={transcriptRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-2">
        {visibleSegments.length === 0 && !partial ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            {t("recorder.overlay_no_transcript")}
          </div>
        ) : null}
        {visibleSegments.map((segment) => (
          <div key={segment.id} className="flex gap-2 text-[13px] leading-snug">
            <span className="shrink-0 pt-px text-[10px] tabular-nums text-muted-foreground">
              {formatClock(segment.startMs)}
            </span>
            <span>{segment.text}</span>
          </div>
        ))}
        {partial ? (
          <div className="flex gap-2 text-[13px] italic leading-snug text-muted-foreground">
            <span className="shrink-0 pt-px text-[10px] not-italic tabular-nums">
              {formatClock(partial.startMs)}
            </span>
            <span>{partial.text}…</span>
          </div>
        ) : null}
      </div>

      {/* Latest AI answer */}
      {latestAnswer ? (
        <div ref={answersRef} className="max-h-36 shrink-0 overflow-y-auto border-t border-border/60 px-3 py-2">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            {latestAnswer.kind === "suggestions" ? <Sparkles className="size-3 text-primary" /> : null}
            <span className="truncate">
              {latestAnswer.kind === "suggestions"
                ? t("recorder.copilot_suggestions_title")
                : latestAnswer.question}
            </span>
          </div>
          {latestAnswer.pending ? (
            <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              {t("recorder.copilot_thinking")}
            </div>
          ) : latestAnswer.error ? (
            <div className="mt-1 text-xs text-destructive">{latestAnswer.error}</div>
          ) : (
            <div className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-snug">
              {latestAnswer.text}
            </div>
          )}
        </div>
      ) : null}

      {/* Copilot actions */}
      <div className="shrink-0 border-t border-border/60 p-2">
        <button
          type="button"
          className="mb-1.5 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          disabled={segments.length === 0}
          onClick={() => submitAsk("suggestions", t("recorder.copilot_suggest"))}
        >
          <Sparkles className="size-4" />
          {t("recorder.copilot_suggest")}
        </button>
        <div className="flex items-end gap-1.5">
          <textarea
            value={question}
            rows={1}
            onChange={(event) => setQuestion(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              const text = question.trim();
              if (!text) return;
              setQuestion("");
              submitAsk("question", text);
            }}
            placeholder={t("recorder.overlay_ask_placeholder")}
            className="max-h-20 min-h-8 flex-1 resize-none rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-[13px] leading-snug outline-none placeholder:text-muted-foreground focus:border-ring"
          />
          <button
            type="button"
            aria-label={t("recorder.copilot_ask")}
            disabled={!question.trim()}
            className="rounded-lg border border-border bg-muted/40 p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
            onClick={() => {
              const text = question.trim();
              if (!text) return;
              setQuestion("");
              submitAsk("question", text);
            }}
          >
            <SendHorizontal className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

initLocale();
const rootElement = document.getElementById("root");
if (rootElement) {
  ReactDOM.createRoot(rootElement).render(<OverlayApp />);
}
