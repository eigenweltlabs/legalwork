import { useEffect, useRef, useState } from "react";
import { AlertCircle, Headphones, Maximize, Minimize, Pause, Play, Volume2, VolumeX } from "lucide-react";

import { Button } from "@/components/ui/button";

function timeLabel(seconds: number) {
  if (!Number.isFinite(seconds)) return "0:00";
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  return `${hours ? `${hours}:` : ""}${String(Math.floor(whole / 60) % 60).padStart(hours ? 2 : 1, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

export function MediaPreview({ kind, src, title }: { kind: "audio" | "video"; src: string; title: string }) {
  const media = useRef<HTMLMediaElement | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const syncFullscreen = () => setFullscreen(document.fullscreenElement === container.current);
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  function toggleFullscreen() {
    const action = document.fullscreenElement === container.current ? document.exitFullscreen() : container.current?.requestFullscreen();
    void action?.catch(() => setNotice("Fullscreen is unavailable. Use the expand button above for a larger view."));
  }

  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function togglePlayback() {
    const element = media.current;
    if (!element || error) return;
    if (!element.paused) {
      element.pause();
      return;
    }
    try {
      setNotice(null);
      await element.play();
    } catch (cause) {
      // Switching tabs while play() is pending aborts playback normally.
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setNotice("Playback could not start. Try again or open this file in its own app.");
    }
  }

  const events = {
    src,
    preload: "metadata",
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
    onTimeUpdate: () => setPosition(media.current?.currentTime ?? 0),
    onDurationChange: () => setDuration(media.current?.duration ?? 0),
    onVolumeChange: () => {
      setVolume(media.current?.volume ?? 1);
      setMuted(media.current?.muted ?? false);
    },
    onRateChange: () => setRate(media.current?.playbackRate ?? 1),
    onError: () => {
      setPlaying(false);
      setError("This file could not be played. Its format or codec may not be supported. Download it or open it in its own app using the buttons above.");
    },
  };
  const seekable = Number.isFinite(duration) && duration > 0;

  return (
    <div className="h-full overflow-auto bg-muted/25 p-4 sm:p-6">
      <div className="flex min-h-full items-center justify-center">
        <div ref={container} data-media-player={kind} className={`w-full overflow-hidden border border-border bg-background shadow-sm ${fullscreen ? "flex h-full max-w-none flex-col rounded-none" : "max-w-3xl rounded-2xl"}`}>
          {kind === "video" ? <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2">
            <span className="text-xs font-medium text-muted-foreground">Video</span>
            <Button variant="outline" size="sm" aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"} onClick={toggleFullscreen}>
              {fullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
              {fullscreen ? "Exit fullscreen" : "Fullscreen"}
            </Button>
          </div> : null}
          {kind === "video" ? (
            <video {...events} ref={(element) => { media.current = element; }} playsInline aria-label={title} onDoubleClick={toggleFullscreen} className={fullscreen ? "min-h-0 w-full flex-1 bg-black object-contain" : "max-h-[65vh] w-full bg-black object-contain"} />
          ) : (
            <div className="flex flex-col items-center gap-5 bg-gradient-to-br from-primary/10 via-muted/40 to-background px-6 py-12">
              <audio {...events} ref={(element) => { media.current = element; }} aria-label={title} />
              <div className="flex size-24 items-center justify-center rounded-3xl border border-primary/10 bg-background/80 text-primary shadow-sm">
                <Headphones className="size-10" strokeWidth={1.25} />
              </div>
              <div className="max-w-full text-center">
                <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.2em] text-muted-foreground">Audio</p>
                <p className="break-words text-base font-medium">{title}</p>
              </div>
            </div>
          )}
          <div className="shrink-0 space-y-3 p-4">
            {error ? <p role="alert" className="flex gap-2 text-sm text-destructive"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</p> : null}
            {notice && !error ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
            <input type="range" aria-label="Seek" aria-valuetext={`${timeLabel(position)} of ${timeLabel(duration)}`} min={0} max={seekable ? duration : 0} step={0.1} value={seekable ? Math.min(position, duration) : 0} disabled={!seekable || !!error} onChange={(event) => {
              if (media.current) media.current.currentTime = Number(event.target.value);
              setPosition(Number(event.target.value));
            }} className="block h-4 w-full cursor-pointer accent-primary disabled:cursor-default" />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="default" size="icon" className="rounded-full" aria-label={playing ? "Pause" : "Play"} disabled={!!error} onClick={() => void togglePlayback()}>
                {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
              </Button>
              <span className="mr-auto text-xs tabular-nums text-muted-foreground">{timeLabel(position)} <span className="px-1 opacity-50">/</span> {timeLabel(duration)}</span>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" aria-label={muted || volume === 0 ? "Unmute" : "Mute"} onClick={() => {
                  if (!media.current) return;
                  if (media.current.volume === 0) media.current.volume = 1;
                  media.current.muted = !muted && volume > 0;
                }}>{muted || volume === 0 ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}</Button>
                <input type="range" aria-label="Volume" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={(event) => {
                  if (!media.current) return;
                  media.current.volume = Number(event.target.value);
                  media.current.muted = false;
                }} className="h-4 w-16 cursor-pointer accent-primary" />
              </div>
              <select aria-label="Playback speed" value={rate} onChange={(event) => {
                if (media.current) media.current.playbackRate = Number(event.target.value);
              }} className="h-8 rounded-md border border-border bg-background px-1 text-xs">
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((speed) => <option key={speed} value={speed}>{speed}×</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
