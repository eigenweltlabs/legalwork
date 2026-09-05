import { useEffect, useRef, useSyncExternalStore } from "react";
import { SILENT_VOICE_AUDIO, type VoiceAudioFrame } from "./voice-audio-meter";
import "./voice-waveform.css";

export type VoiceStatus = "connecting" | "listening" | "thinking" | "tool_use" | "waiting_approval" | "speaking" | "error";

const motionQuery = "(prefers-reduced-motion: reduce)";
const reducedMotionSnapshot = () => window.matchMedia(motionQuery).matches;
function subscribeMotionPreference(listener: () => void) {
  const media = window.matchMedia(motionQuery);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

/** A flat, layered ribbon. Volume shapes its height; speech frequencies shape
 * its contours. Sampling and drawing stay outside React's render loop. */
export function VoiceWaveform({ status, sample }: { status: VoiceStatus; sample: () => VoiceAudioFrame }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const current = useRef({ status, sample });
  current.current = { status, sample };
  const redraw = useRef<() => void>(() => {});
  const reducedMotion = useSyncExternalStore(subscribeMotionPreference, reducedMotionSnapshot, () => true);
  useEffect(() => {
    const element = canvas.current;
    const ctx = element?.getContext("2d");
    if (!element || !ctx) return;
    let frame = 0, previous = 0, time = 0, level = 0, visible = true;
    const bands = [0, 0, 0, 0, 0, 0];
    const draw = (now: number) => {
      const delta = previous ? Math.min((now - previous) / 1000, 0.05) : 0;
      previous = now;
      const state = current.current.status;
      const audio = state === "error" ? SILENT_VOICE_AUDIO : current.current.sample();
      const target = reducedMotion ? 0.22 : audio.level;
      level = reducedMotion ? target : level + (target - level) * Math.min(1, delta * (target > level ? 22 : 7));
      for (let i = 0; i < 6; i++) bands[i] += (audio.bands[i] - bands[i]) * Math.min(1, delta * 10);
      if (!reducedMotion) time += delta * (0.65 + level * 1.5);
      const width = element.clientWidth, height = element.clientHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (element.width !== Math.round(width * dpr) || element.height !== Math.round(height * dpr)) {
        element.width = Math.round(width * dpr);
        element.height = Math.round(height * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const working = state === "thinking" || state === "tool_use";
      const amplitude = height * (0.045 + level * 0.36 + (working ? 0.035 : 0));
      const colors = state === "error" ? ["#eb9bab", "#c27094", "#bb83bb"]
        : state === "waiting_approval" ? ["#e8c783", "#c19c5b", "#deaf94"]
        : ["#3bc8d9", "#386cf1", "#9168db"];
      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, `${colors[0]}00`);
      gradient.addColorStop(0.14, colors[0]);
      gradient.addColorStop(0.43, colors[1]);
      gradient.addColorStop(0.75, colors[2]);
      gradient.addColorStop(1, `${colors[2]}00`);
      const y = (u: number, lane: number) => {
        const envelope = Math.pow(Math.sin(Math.PI * u), 1.3);
        const index = Math.min(4, Math.floor(u * 5));
        const band = bands[index] + (bands[index + 1] - bands[index]) * (u * 5 - index);
        const wave = Math.sin(u * Math.PI * 3.4 - time * 1.8 + lane * 1.1)
          + 0.28 * Math.sin(u * Math.PI * 7.6 + time * 1.2 + lane * 0.8);
        return height / 2 + envelope * amplitude * (wave * (0.65 + band * 0.35) + lane * 0.22);
      };
      ctx.fillStyle = gradient;
      for (let lane = -1; lane < 1; lane += 0.4) {
        ctx.beginPath();
        for (let x = 0; x <= width; x += 2) {
          if (x === 0) ctx.moveTo(x, y(0, lane)); else ctx.lineTo(x, y(x / width, lane));
        }
        for (let x = width; x >= 0; x -= 2) ctx.lineTo(x, y(x / width, lane + 0.4));
        ctx.closePath();
        ctx.globalAlpha = 0.12 + level * 0.12;
        ctx.fill();
      }
      ctx.strokeStyle = gradient;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      for (let i = 0; i < 17; i++) {
        const lane = (i - 8) / 8;
        ctx.beginPath();
        for (let x = 0; x <= width; x += 2) {
          if (x === 0) ctx.moveTo(x, y(0, lane)); else ctx.lineTo(x, y(x / width, lane));
        }
        ctx.globalAlpha = 0.12 + (1 - Math.abs(lane)) * 0.4;
        ctx.lineWidth = i === 8 ? 1.3 : 0.65;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    const tick = (now: number) => { draw(now); frame = requestAnimationFrame(tick); };
    const resume = () => {
      cancelAnimationFrame(frame);
      previous = 0;
      if (document.hidden || !visible) return;
      draw(performance.now());
      if (!reducedMotion) frame = requestAnimationFrame(tick);
    };
    redraw.current = resume;
    const resize = new ResizeObserver(resume);
    resize.observe(element);
    const visibility = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; resume(); });
    visibility.observe(element);
    document.addEventListener("visibilitychange", resume);
    resume();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      visibility.disconnect();
      document.removeEventListener("visibilitychange", resume);
      redraw.current = () => {};
    };
  }, [reducedMotion]);
  useEffect(() => { redraw.current(); }, [status]);
  return <div className="lw-voice-waveform" data-testid="voice-waveform" data-voice-state={status}
    role="img" aria-label={`Voice status: ${status.replaceAll("_", " ")}`}>
    <canvas ref={canvas} aria-hidden="true" />
  </div>;
}
