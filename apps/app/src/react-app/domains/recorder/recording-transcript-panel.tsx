/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, FileAudio, FileText, Loader2, X } from "lucide-react";
import type { AudioRecordingDetail, AudioTranscriptEdit, AudioTranscriptSegment } from "@legalwork/types/audio";
import { audioRecordingEditTranscript, audioRecordingGet, audioRecordingSummarize } from "@/app/lib/desktop";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { currentLocale, t } from "@/i18n";
import { PanelEmptyState } from "@/react-app/design-system/panel-chrome";
import { type RecordingPanelTab, usePanelTabStore } from "../session/panel/panel-tab-store";
import { ArtifactFrame } from "../session/artifacts/artifact-frame";
import { MarkdownBlock } from "../session/surface/markdown";
import { useRecorderStore } from "./recorder-store";
import { recordingTime, transcriptTurns } from "./recording-transcript";
import { RecordingSpeakers, SpeakerAssignment, SPEAKER_COLORS } from "./recording-speakers";
import "./recording-transcript-panel.css";

const EMPTY_SEGMENTS: AudioTranscriptSegment[] = [];

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

export function RecordingTranscriptPanel({ sessionId, tab, onClose }: { sessionId: string; tab: RecordingPanelTab; onClose: () => void }) {
  const updateTitle = useCallback((title: string) => {
    usePanelTabStore.getState().updateTabLabel(sessionId, tab.id, title);
  }, [sessionId, tab.id]);
  return <ArtifactFrame title={tab.label} icon={<FileAudio className="size-5" />} expandable actions={
    <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("panel_tabs.close_tab")} title={t("panel_tabs.close_tab")}><X /></Button>
  }>
    <RecordingTranscript recordingId={tab.recordingId} title={tab.label} onTitleChange={updateTitle} />
  </ArtifactFrame>;
}

/** Transcript content shared by workspace tabs and the global Recorder. */
export function RecordingTranscript({ recordingId, title, onTitleChange }: {
  recordingId: string;
  title?: string;
  onTitleChange?: (title: string) => void;
}) {
  const queryClient = useQueryClient();
  const recording = useRecorderStore(state => state.recording);
  const dictationId = useRecorderStore(state => state.dictationRecordingId);
  const liveRecording = recording?.id === recordingId && !recording.ephemeral && recording.id !== dictationId ? recording : null;
  const liveSegments = useRecorderStore(state => liveRecording ? state.segments : EMPTY_SEGMENTS);
  const partials = useRecorderStore(state => liveRecording ? state.partials : EMPTY_SEGMENTS);
  const startedAt = useRecorderStore(state => liveRecording ? state.recordingStartedAt : null);
  const finalizing = useRecorderStore(state => Boolean(liveRecording && state.finalizing));
  const reconnecting = useRecorderStore(state => Boolean(liveRecording && !state.finalizing && state.transcriptionReconnecting));
  const savedRecording = useRecorderStore(state => state.recordings.find(item => item.id === recordingId));
  const queryKey = useMemo(() => ["recorder", "transcript", recordingId], [recordingId]);
  const detail = useQuery({
    queryKey,
    queryFn: () => audioRecordingGet(recordingId),
    enabled: !liveRecording,
    retry: false,
    refetchInterval: query => query.state.data?.meta.speakerProcessing || query.state.data?.meta.summaryProcessing ? 2000 : false,
  });
  useEffect(() => {
    if (!liveRecording) void queryClient.invalidateQueries({ queryKey });
  }, [savedRecording, liveRecording, queryClient, queryKey]);

  // Preserve the text while the completed, speaker-labeled transcript loads.
  useEffect(() => {
    if (!liveRecording) return;
    queryClient.setQueryData<AudioRecordingDetail>(queryKey, {
      meta: { ...liveRecording, durationMs: startedAt === null ? liveRecording.durationMs : Date.now() - startedAt },
      segments: liveSegments,
    });
  }, [queryClient, queryKey, liveRecording, liveSegments, startedAt, finalizing]);

  const meta = liveRecording ?? detail.data?.meta ?? savedRecording;
  const segments = liveRecording ? liveSegments : detail.data?.segments ?? EMPTY_SEGMENTS;
  const turns = useMemo(() => transcriptTurns(segments, partials), [segments, partials]);
  const segmentCounts = new Map<number, number>();
  for (const segment of segments) if (segment.speaker != null) segmentCounts.set(segment.speaker, (segmentCounts.get(segment.speaker) ?? 0) + 1);
  const speakers = segmentCounts.size;
  const people = [...new Set([
    ...turns.flatMap(turn => turn.speaker === null ? [] : [turn.speaker]),
    ...Object.keys(meta?.speakerNames ?? {}).map(Number),
  ])].sort((a, b) => a - b).map(id => ({ id, name: meta?.speakerNames?.[id] ?? t("recorder.speaker_label", { n: id + 1 }), segmentCount: segmentCounts.get(id) ?? 0 }));
  const [saving, setSaving] = useState(false);
  const [startingSummary, setStartingSummary] = useState(false);
  const summaryStartingRef = useRef(false);
  const summarize = async () => {
    if (summaryStartingRef.current || liveRecording || meta?.speakerProcessing || meta?.summaryProcessing) return;
    summaryStartingRef.current = true;
    setStartingSummary(true);
    try {
      const { model, instructions } = useRecorderStore.getState().meetingNotes;
      const updated = await audioRecordingSummarize(recordingId, { model, instructions });
      queryClient.setQueryData(queryKey, updated);
      await useRecorderStore.getState().refreshRecordings();
    } catch (error) {
      toast.error(t("recorder.meeting_notes_start_failed"), { description: error instanceof Error ? error.message : String(error) });
    } finally {
      summaryStartingRef.current = false;
      setStartingSummary(false);
    }
  };
  const savingRef = useRef(false);
  const edit = async (change: AudioTranscriptEdit) => {
    if (liveRecording || meta?.speakerProcessing || savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    try {
      const updated = await audioRecordingEditTranscript(recordingId, change);
      queryClient.setQueryData(queryKey, updated);
      await useRecorderStore.getState().refreshRecordings();
      return true;
    } catch (error) {
      toast.error(t("recorder.speaker_save_failed"), { description: error instanceof Error ? error.message : String(error) });
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
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
  const recordingTitle = meta?.title;
  useEffect(() => {
    if (recordingTitle) onTitleChange?.(recordingTitle);
  }, [recordingTitle, onTitleChange]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(turns.map(turn => {
        const name = people.find(person => person.id === turn.speaker)?.name;
        return `${name ? `${name}: ` : ""}${turn.segments.map(segment => segment.text).join(" ")}`;
      }).join("\n\n"));
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
    <div
      ref={scrollRef}
      className="lw-recording-transcript"
      aria-label={t("recorder.last_transcript")}
      onScroll={event => {
        const node = event.currentTarget;
        followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
      }}
    >
      <div className="lw-recording-transcript-content">
      <header className="lw-recording-transcript-header">
        <div className="min-w-0 flex-[1_1_240px]">
          <h1>{meta?.title ?? title}</h1>
          <div className="lw-recording-transcript-details">
            {meta ? <span>{new Date(meta.createdAt).toLocaleDateString(currentLocale(), { dateStyle: "medium" })} · {new Date(meta.createdAt).toLocaleTimeString(currentLocale(), { hour: "2-digit", minute: "2-digit" })}</span> : null}
            <TranscriptDuration startedAt={finalizing ? null : startedAt} durationMs={detail.data?.meta.durationMs ?? meta?.durationMs ?? 0} />
            {speakers > 0 ? <span>{t("recorder.transcript_speakers", { count: speakers })}</span> : null}
            {liveRecording ? <span className="lw-recording-transcript-status" role="status">
              {finalizing ? <Loader2 className="size-3.5 animate-spin" /> : <span className="lw-recording-transcript-dot" aria-hidden="true" />}
              {t(finalizing ? "recorder.finishing" : "recorder.transcript_live")}
            </span> : null}
            {meta?.speakerProcessing ? <span className="lw-recording-transcript-status" role="status">
              <Loader2 className="size-3.5 animate-spin" />{t("recorder.diarize_identifying")}
            </span> : null}
          </div>
          {reconnecting ? <p className="mt-2 text-sm text-warning" role="status">{t("recorder.transcription_reconnecting")}</p> : null}
          {!liveRecording && meta?.error ? <p className="mt-2 text-sm text-warning" role="status">{meta.error}</p> : null}
          {meta?.speakerError ? <p className="mt-2 text-sm text-muted-foreground" role="status">{meta.speakerError}</p> : null}
          {meta?.summaryProcessing && !meta.speakerProcessing ? <p className="mt-2 flex items-center gap-2 text-sm text-muted-foreground" role="status"><Loader2 className="size-3.5 animate-spin" />{t("recorder.meeting_notes_processing")}</p> : null}
          {meta?.summaryError ? <p className="mt-2 text-sm text-warning" role="alert">{meta.summaryError}</p> : null}
        </div>
        <div className="lw-recording-transcript-actions">
          {!liveRecording && meta?.transcriptionSource === "cloud" && !meta.summary && turns.length > 0 ?
            <Button variant="ghost" size="sm" className="px-2 text-xs" onClick={() => void summarize()}
              disabled={startingSummary || meta.summaryProcessing || meta.speakerProcessing}
              aria-label={t(meta.summaryError ? "recorder.meeting_notes_retry" : "recorder.meeting_notes_manual")}
              title={`${t("recorder.meeting_notes_manual")}: ${t("recorder.meeting_notes_manual_description")}`}>
              {t((startingSummary || meta.summaryProcessing) && !meta.speakerProcessing ? "recorder.meeting_notes_manual_running"
                : meta.summaryError ? "recorder.meeting_notes_retry" : "recorder.meeting_notes_manual")}
            </Button> : null}
          <Button variant="ghost" size="icon-sm" aria-label={t("recorder.transcript_copy")} title={t("recorder.transcript_copy")} disabled={turns.length === 0} onClick={() => void copy()}>{copied ? <Check /> : <Copy />}</Button>
          <RecordingSpeakers speakers={people} disabled={saving || Boolean(liveRecording || meta?.speakerProcessing)} live={Boolean(liveRecording)} edit={edit} />
        </div>
      </header>
      {meta?.summary ? <section className="lw-recording-transcript-summary" aria-label={t("recorder.meeting_summary")}>
        <h2>{t("recorder.meeting_summary")}</h2>
        <MarkdownBlock text={meta.summary} />
      </section> : null}
      <div className="lw-recording-transcript-body">
        {turns.length === 0 ? <div className="lw-recording-transcript-empty"><FileText className="size-6" /><p>{t(liveRecording ? "recorder.waiting_for_speech" : "recorder.transcript_empty")}</p></div> : turns.map(turn => (
          <section key={turn.id} className="lw-recording-transcript-turn">
            <div className="lw-recording-transcript-speaker">
              {liveRecording ? (turn.speaker === null ? null : <span style={{ color: SPEAKER_COLORS[turn.speaker % SPEAKER_COLORS.length] }}>{people.find(person => person.id === turn.speaker)?.name}</span>)
                : <SpeakerAssignment speaker={turn.speaker} speakers={people} segmentIds={turn.segments.map(segment => segment.id)} disabled={saving || Boolean(meta?.speakerProcessing)} edit={edit} />}
              <time>{recordingTime(turn.startMs)}</time>
            </div>
            <div className="lw-recording-transcript-words">{turn.segments.map(segment => <div key={segment.id} className="lw-transcript-segment">
              <span className={segment.final ? undefined : "lw-recording-transcript-partial"}>{segment.text}</span>
              {!liveRecording && turn.segments.length > 1 ? <SpeakerAssignment compact speaker={segment.speaker ?? null} speakers={people} segmentIds={[segment.id]} disabled={saving || Boolean(meta?.speakerProcessing)} edit={edit} /> : null}
            </div>)}</div>
          </section>
        ))}
      </div>
      </div>
    </div>
  );
}
