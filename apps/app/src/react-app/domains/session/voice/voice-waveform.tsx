import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
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

export function VoiceCard({ children }: { children: ReactNode }) {
  return <div data-testid="voice-card" className="relative flex w-[520px] max-w-[calc(100%_-_2rem)] flex-col items-center gap-4 rounded-[2rem] bg-background/72 px-8 py-6 shadow-[0_18px_70px_rgba(15,23,42,0.08)] backdrop-blur-md">{children}</div>;
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
      const amplitude = height * (0.04 + level * 0.34 + (working ? 0.025 : 0));
      const colors = state === "error" ? ["#fb7185", "#dc467f", "#e89ba8", "#b86ae1"]
        : state === "waiting_approval" ? ["#ffb94f", "#f28b65", "#ffe39a", "#e77cb6"]
        : ["#e94ff5", "#8748ff", "#26d8eb", "#5175ff"];
      const y = (u: number, phase: number) => {
        const envelope = Math.pow(Math.sin(Math.PI * u), 0.9);
        const index = Math.min(4, Math.floor(u * 5));
        const band = bands[index] + (bands[index + 1] - bands[index]) * (u * 5 - index);
        const wave = Math.sin(u * Math.PI * 3.4 - time * 0.95 + phase)
          + 0.18 * Math.sin(u * Math.PI * 6.2 + time * 0.7 + phase * 1.4);
        return height / 2 + envelope * amplitude * wave * (0.8 + band * 0.2);
      };
      // Two broad, crossing ribbons. Vertical color transitions give each lobe
      // its own color while their translucent overlaps stay flat on the page.
      for (let ribbon = 0; ribbon < 2; ribbon++) {
        const phase = ribbon * 0.9;
        ctx.beginPath();
        const steps = Math.ceil(width / 2);
        for (let step = 0; step <= steps; step++) {
          const u = step / steps;
          if (step === 0) ctx.moveTo(0, y(0, phase)); else ctx.lineTo(u * width, y(u, phase));
        }
        for (let step = steps; step >= 0; step--) {
          const u = step / steps;
          ctx.lineTo(u * width, y(u, phase + 2.2));
        }
        ctx.closePath();
        const gradient = ctx.createLinearGradient(0, height / 2 - amplitude, 0, height / 2 + amplitude);
        gradient.addColorStop(0, `${colors[ribbon === 0 ? 0 : 2]}40`);
        gradient.addColorStop(0.22, `${colors[ribbon === 0 ? 0 : 2]}e8`);
        gradient.addColorStop(0.52, `${colors[ribbon === 0 ? 1 : 3]}a8`);
        gradient.addColorStop(0.78, `${colors[ribbon === 0 ? 3 : 2]}d0`);
        gradient.addColorStop(1, `${colors[ribbon === 0 ? 3 : 2]}30`);
        ctx.fillStyle = gradient;
        ctx.globalAlpha = ribbon === 0 ? 0.88 : 0.72;
        ctx.fill();
        // A narrow luminous rim and a soft reflection through the translucent
        // body give the ribbons a glass finish without adding perspective.
        ctx.save();
        ctx.clip();
        const sheen = ctx.createLinearGradient(0, height / 2 - amplitude, 0, height / 2 + amplitude);
        sheen.addColorStop(0, "#ffffff00");
        sheen.addColorStop(0.32, "#ffffff08");
        sheen.addColorStop(0.46, "#ffffff80");
        sheen.addColorStop(0.52, "#ffffff18");
        sheen.addColorStop(1, "#ffffff00");
        ctx.fillStyle = sheen;
        ctx.fillRect(0, 0, width, height);
        ctx.restore();
        ctx.strokeStyle = gradient;
        ctx.lineWidth = 1.2;
        ctx.globalAlpha = 0.55;
        ctx.shadowColor = colors[ribbon === 0 ? 1 : 2];
        ctx.shadowBlur = 7;
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 0.65;
        ctx.globalAlpha = 0.7;
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
