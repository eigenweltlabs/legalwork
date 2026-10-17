/** @jsxImportSource react */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, FileText, Loader2 } from "lucide-react";
import type { AudioRecordingDetail, AudioTranscriptSegment } from "@legalwork/types/audio";
import { audioRecordingGet } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { currentLocale, t } from "@/i18n";
import { PanelEmptyState } from "@/react-app/design-system/panel-chrome";
import { type RecordingPanelTab, usePanelTabStore } from "../session/panel/panel-tab-store";
import { useRecorderStore } from "./recorder-store";
import { recordingTime, transcriptTurns } from "./recording-transcript";
import "./recording-transcript-panel.css";

const EMPTY_SEGMENTS: AudioTranscriptSegment[] = [];
const SPEAKER_COLORS = ["var(--lw-file-word)", "var(--lw-file-image)", "var(--lw-file-sheet)", "var(--lw-file-slides)"];

function TranscriptDuration({ startedAt, durationMs }: { startedAt: number | null; durationMs: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  return <span className="tabular-nums">{recordingTime(startedAt === null ? durationMs : now - startedAt)}</span>;
}

export function RecordingTranscriptPanel({ sessionId, tab }: { sessionId: string; tab: RecordingPanelTab }) {
  const queryClient = useQueryClient();
  const recording = useRecorderStore(state => state.recording);
  const dictationId = useRecorderStore(state => state.dictationRecordingId);
  const liveRecording = recording?.id === tab.recordingId && !recording.ephemeral && recording.id !== dictationId ? recording : null;
  const liveSegments = useRecorderStore(state => liveRecording ? state.segments : EMPTY_SEGMENTS);
  const partial = useRecorderStore(state => liveRecording ? state.partial : null);
  const startedAt = useRecorderStore(state => liveRecording ? state.recordingStartedAt : null);
  const finalizing = useRecorderStore(state => Boolean(liveRecording && state.finalizing));
  const savedRecording = useRecorderStore(state => state.recordings.find(item => item.id === tab.recordingId));
  const queryKey = useMemo(() => ["recorder", "transcript", tab.recordingId], [tab.recordingId]);
  const detail = useQuery({
    queryKey,
    queryFn: () => audioRecordingGet(tab.recordingId),
    enabled: !liveRecording,
    retry: false,
  });

  // Preserve the text while the completed, speaker-labeled transcript loads.
  useEffect(() => {
    if (!liveRecording) return;
    queryClient.setQueryData<AudioRecordingDetail>(queryKey, {
      meta: { ...liveRecording, durationMs: startedAt === null ? liveRecording.durationMs : Date.now() - startedAt },
      segments: liveSegments,
    });
  }, [queryClient, queryKey, liveRecording, liveSegments, startedAt, finalizing]);

  const meta = liveRecording ?? savedRecording ?? detail.data?.meta;
  const segments = liveRecording ? liveSegments : detail.data?.segments ?? EMPTY_SEGMENTS;
  const turns = useMemo(() => transcriptTurns(segments, partial), [segments, partial]);
  const speakers = new Set(segments.flatMap(segment => segment.speaker == null ? [] : [segment.speaker])).size;
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const wasLive = useRef(false);

  useEffect(() => {
    if (liveRecording) wasLive.current = true;
    if (followRef.current && wasLive.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [turns, liveRecording]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    if (!meta || meta.title === tab.label) return;
    usePanelTabStore.getState().updateTabLabel(sessionId, tab.id, meta.title);
  }, [meta, sessionId, tab]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(turns.map(turn => turn.segments.map(segment => segment.text).join(" ")).join("\n\n"));
      setCopied(true);
    } catch {
      toast.error(t("recorder.transcript_copy_failed"));
    }
  };

  if (!liveRecording && detail.isPending) {
    return <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-4 animate-spin" />{t("recorder.transcript_loading")}</div>;
  }
  if (!liveRecording && (detail.isError || !detail.data || detail.data.meta.ephemeral)) {
    return <PanelEmptyState icon={<FileText />} title={t("recorder.transcript_load_failed")}>
      <Button variant="outline" size="sm" onClick={() => void detail.refetch()}>{t("tasks.retry")}</Button>
    </PanelEmptyState>;
  }

  return (
    <div className="lw-recording-transcript">
      <header className="lw-recording-transcript-header">
        <div className="min-w-0">
          <h1>{meta?.title ?? tab.label}</h1>
          {meta ? <p>{new Date(meta.createdAt).toLocaleDateString(currentLocale(), { dateStyle: "medium" })} · {new Date(meta.createdAt).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" })}</p> : null}
        </div>
        <Button variant="ghost" size="icon-sm" aria-label={t("recorder.transcript_copy")} title={t("recorder.transcript_copy")} disabled={turns.length === 0} onClick={() => void copy()}>{copied ? <Check /> : <Copy />}</Button>
      </header>
      <div className="lw-recording-transcript-meta">
        <span>{t("recorder.last_transcript")}</span>
        {speakers > 0 ? <span>{t("recorder.transcript_speakers", { count: speakers })}</span> : null}
        <TranscriptDuration startedAt={finalizing ? null : startedAt} durationMs={detail.data?.meta.durationMs ?? meta?.durationMs ?? 0} />
        {liveRecording ? <span className="lw-recording-transcript-status" role="status">
          {finalizing ? <Loader2 className="size-3.5 animate-spin" /> : <span className="lw-recording-transcript-dot" aria-hidden="true" />}
          {t(finalizing ? "recorder.finishing" : "recorder.transcript_live")}
        </span> : null}
      </div>
      <div
        ref={scrollRef}
        className="lw-recording-transcript-body"
        aria-label={t("recorder.last_transcript")}
        onScroll={event => {
          const node = event.currentTarget;
          followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
        }}
      >
        {turns.length === 0 ? <div className="lw-recording-transcript-empty"><FileText className="size-6" /><p>{t(liveRecording ? "recorder.waiting_for_speech" : "recorder.transcript_empty")}</p></div> : turns.map(turn => (
          <section key={turn.id} className="lw-recording-transcript-turn">
            <div className="lw-recording-transcript-speaker">
              {turn.speaker === null ? null : <span style={{ color: SPEAKER_COLORS[turn.speaker % SPEAKER_COLORS.length] }}>{t("recorder.speaker_label", { n: turn.speaker + 1 })}</span>}
              <time>{recordingTime(turn.startMs)}</time>
            </div>
            <p className="lw-recording-transcript-words">{turn.segments.map((segment, index) => <span key={segment.id} className={segment.final ? undefined : "lw-recording-transcript-partial"}>{index > 0 ? " " : null}{segment.text}</span>)}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
