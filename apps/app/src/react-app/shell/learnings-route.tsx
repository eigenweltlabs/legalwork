/** @jsxImportSource react */

import { useRef, useState, type ReactNode } from "react";
import { Activity, ArrowLeft, ArrowRight, ArrowUpRight, ChevronRight, FileText, Folder, ListChecks, RefreshCw, Rocket } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useBenchmarkStore } from "../domains/benchmark/store";
import { SettingsSurface } from "./settings-route";

/**
 * Learnings main pane. Rendered inside the session shell's `SidebarInset`
 * (via SessionPage's `mainView`), so the main app sidebar stays in place.
 *
 * Teaser for the unreleased Learning product: three frosted glass cards, each
 * holding a small purpose-built visualization of one pillar —
 *   1. Data structuring & Benchmarks  2. Post learning  3. Continual learning
 * The first card is live: clicking it opens the Benchmark task page (embedded
 * via the same singleView SettingsSurface mechanism the Workflows and
 * Integrations pages use). The other two are blurred illustrative demo data.
 */

type ModelStatus = "live" | "learning" | "staged";

const STATUS_COLOR: Record<ModelStatus, string> = {
  live: "var(--lw-live)",
  learning: "var(--lw-violet)",
  staged: "var(--lw-blue-2)",
};

function Sparkline({ data, color, width = 38, height = 14 }: { data: number[]; color: string; width?: number; height?: number }) {
  const pad = 2;
  const max = Math.max(...data);
  const min = Math.min(...data);
  const span = max - min || 1;
  const stepX = width / (data.length - 1);
  const pts = data.map((d, i) => {
    const x = i * stepX;
    const y = pad + (height - pad * 2) * (1 - (d - min) / span);
    return [x, y] as const;
  });
  const path = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const last = pts[pts.length - 1];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={1.8} fill={color} />
    </svg>
  );
}

/** 1. Raw documents on the left flow into sorted, tagged practice folders. */
function DataStructuringViz() {
  const folders = [
    { label: "M&A", count: "1,840" },
    { label: "Employment", count: "1,120" },
    { label: "Litigation", count: "2,210" },
  ];
  return (
    <div className="flex h-full w-full items-center justify-between gap-2 text-foreground">
      <div className="flex flex-col gap-1.5">
        {[30, 22, 34, 24].map((w, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <FileText className="size-3 shrink-0 opacity-40" />
            <div className="h-1.5 rounded-full" style={{ width: w, background: "currentColor", opacity: 0.14 }} />
          </div>
        ))}
      </div>
      <ArrowRight className="size-4 shrink-0 opacity-30" />
      <div className="flex flex-col gap-1.5">
        {folders.map((f) => (
          <div
            key={f.label}
            className="flex items-center justify-between gap-2 rounded-md px-2 py-1"
            style={{ background: "rgba(35,82,222,.06)", border: "1px solid rgba(35,82,222,.14)" }}
          >
            <span className="flex items-center gap-1.5">
              <Folder className="size-3" style={{ color: "var(--lw-blue-2)" }} />
              <span className="text-[11px] font-medium">{f.label}</span>
            </span>
            <span className="font-mono text-[9px] text-muted-foreground">{f.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 2. A compact fleet of specialist models — name, trend, accuracy, status. */
function ModelsViz() {
  const models: { name: string; acc: string; status: ModelStatus; spark: number[] }[] = [
    { name: "M&A", acc: "94.2%", status: "live", spark: [90, 91, 90.5, 92, 93, 94.2] },
    { name: "Litigation", acc: "91.7%", status: "learning", spark: [89, 90, 89.5, 91, 90.8, 91.7] },
    { name: "Employment", acc: "92.9%", status: "live", spark: [92, 92.3, 92.1, 92.6, 92.7, 92.9] },
    { name: "Tax", acc: "87.6%", status: "staged", spark: [82, 83.5, 84, 85.5, 86.8, 87.6] },
  ];
  return (
    <div className="flex h-full w-full flex-col justify-center gap-1.5">
      {models.map((m) => (
        <div
          key={m.name}
          className="flex items-center justify-between gap-2 rounded-md px-2 py-1"
          style={{ background: "rgba(255,255,255,.45)", border: "1px solid var(--border)" }}
        >
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full" style={{ background: STATUS_COLOR[m.status] }} />
            <span className="text-[11px] font-medium text-foreground">{m.name}</span>
          </span>
          <span className="flex items-center gap-2">
            <Sparkline data={m.spark} color={m.status === "learning" ? "var(--lw-violet)" : "var(--lw-blue-2)"} />
            <span className="font-mono text-[10px] text-foreground">{m.acc}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** 3. The flywheel: signals → tasks → continual learn → rollout, with progress. */
function ContinualLearningViz() {
  const steps = [
    { icon: Activity, label: "Signals" },
    { icon: ListChecks, label: "Tasks" },
    { icon: RefreshCw, label: "Continual learn" },
    { icon: Rocket, label: "Rollout" },
  ];
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4">
      <div className="flex items-center gap-1">
        {steps.map((s, i) => (
          <div key={s.label} className="flex items-center gap-1">
            <div className="flex flex-col items-center gap-1">
              <span
                className="flex size-7 items-center justify-center rounded-lg"
                style={{ background: "rgba(35,82,222,.08)", border: "1px solid rgba(35,82,222,.16)" }}
              >
                <s.icon className="size-3.5" style={{ color: "var(--lw-blue-2)" }} />
              </span>
              <span className="font-mono text-[8px] uppercase tracking-[0.08em] text-muted-foreground">{s.label}</span>
            </div>
            {i < steps.length - 1 && <ChevronRight className="size-3 shrink-0 text-muted-foreground/40" />}
          </div>
        ))}
      </div>
      <div className="w-full">
        <div className="flex items-center justify-between font-mono text-[8px] uppercase tracking-[0.08em] text-muted-foreground">
          <span>to next continual learn</span>
          <span>31/40</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full" style={{ background: "rgba(14,10,7,.06)" }}>
          <div className="h-full rounded-full" style={{ width: "77.5%", background: "linear-gradient(90deg, var(--lw-blue), var(--lw-blue-2))" }} />
        </div>
      </div>
    </div>
  );
}

function PreviewCard({
  step,
  title,
  desc,
  children,
  blurred = true,
  onClick,
  cta,
}: {
  step: string;
  title: string;
  desc: string;
  children: ReactNode;
  blurred?: boolean;
  onClick?: () => void;
  cta?: ReactNode;
}) {
  return (
    <div
      className={`glass flex flex-col gap-4 rounded-[20px] p-4 ${
        onClick ? "cursor-pointer transition-shadow hover:shadow-[0_0_0_1.5px_rgba(35,82,222,0.35)]" : ""
      }`}
      style={{ boxShadow: "none" }}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (event) => (event.key === "Enter" || event.key === " ") && onClick() : undefined}
    >
      <div
        className="flex h-[150px] items-center justify-center overflow-hidden rounded-xl p-4"
        style={{ border: "1px solid var(--border)", background: "rgba(255,255,255,.30)" }}
      >
        <div className={`pointer-events-none h-full w-full select-none ${blurred ? "blur-[2px]" : ""}`}>
          {children}
        </div>
      </div>
      <div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground">{step}</span>
          <h3 className="text-sm font-medium text-foreground">{title}</h3>
          {onClick ? <ArrowRight className="ml-auto size-3.5 text-muted-foreground/60" /> : null}
        </div>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{desc}</p>
      </div>
      {cta ? <div className="mt-auto pt-1">{cta}</div> : null}
    </div>
  );
}

function TalkWithResearcherLink() {
  return (
    <a
      href="https://eigenweltlabs.com"
      target="_blank"
      rel="noopener noreferrer"
      onClick={(event) => event.stopPropagation()}
      className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full border border-[rgba(35,82,222,0.22)] px-3 text-[12px] font-medium text-[#2352DE] transition-colors hover:bg-[rgba(35,82,222,0.08)]"
    >
      Talk with Researcher
      <ArrowUpRight className="size-3.5" />
    </a>
  );
}

export type LearningsPaneProps = {
  workspaceId?: string;
};

export function LearningsPane(props: LearningsPaneProps) {
  const [view, setView] = useState<"overview" | "benchmark">("overview");
  const [benchmarkPath, setBenchmarkPath] = useState("benchmark");
  const benchmarkNavigateRef = useRef<((path: string) => void) | null>(null);

  const benchmarkTasks = useBenchmarkStore((state) => state.tasks);
  const benchmarkRuns = useBenchmarkStore((state) => state.runs);
  const activeRun = useBenchmarkStore((state) => state.activeRun);

  // One back affordance, always in the same spot: its label and target follow
  // the current depth (detail screens go up one level, the root leaves to
  // Learnings), and the current screen's title sits next to it.
  const back = (() => {
    const segments = benchmarkPath.split("/");
    if (segments[1] === "tasks" && segments[2]) {
      const taskId = decodeURIComponent(segments[2]);
      return {
        label: "Tasks",
        action: () => benchmarkNavigateRef.current?.("benchmark"),
        title: benchmarkTasks.find((task) => task.id === taskId)?.title ?? null,
      };
    }
    if (segments[1] === "runs" && segments[2] && segments[3] === "items" && segments[4]) {
      const runPath = `benchmark/runs/${segments[2]}`;
      const itemPath = `${runPath}/items/${segments[4]}`;
      const itemId = decodeURIComponent(segments[4]);
      const item = activeRun?.items.find((entry) => entry.id === itemId) ?? null;
      const itemTitle = item ? `${item.taskTitle} · ${item.modelID}` : null;
      if (segments[5] === "chat") {
        return {
          label: "Details",
          action: () => benchmarkNavigateRef.current?.(itemPath),
          title: itemTitle ? `${itemTitle} — Chat` : "Chat",
        };
      }
      return {
        label: "Run",
        action: () => benchmarkNavigateRef.current?.(runPath),
        title: itemTitle,
      };
    }
    if (segments[1] === "runs" && segments[2]) {
      const runId = decodeURIComponent(segments[2]);
      return {
        label: "Runs",
        action: () => benchmarkNavigateRef.current?.("benchmark"),
        title:
          activeRun?.run.id === runId
            ? activeRun.run.title
            : benchmarkRuns.find((run) => run.id === runId)?.title ?? null,
      };
    }
    return { label: "Learnings", action: () => setView("overview"), title: "Benchmark" };
  })();

  if (view === "benchmark") {
    return (
      <div className="flex h-full w-full flex-col">
        <div className="flex min-w-0 items-center gap-2 px-4 pt-3">
          <Button variant="ghost" size="sm" onClick={back.action}>
            <ArrowLeft size={14} />
            {back.label}
          </Button>
          {back.title ? (
            <>
              <span className="text-muted-foreground/40">/</span>
              <span className="truncate text-sm font-medium text-foreground">{back.title}</span>
            </>
          ) : null}
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <SettingsSurface
            embedded
            singleView
            initialPath="benchmark"
            workspaceId={props.workspaceId}
            onEmbeddedPathChange={setBenchmarkPath}
            embeddedNavigateRef={benchmarkNavigateRef}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-y-auto">
      {/* Brand radial wash (kept from the original placeholder). */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-[12%] -top-[20%] h-[60%] w-[60%] rounded-full bg-[radial-gradient(ellipse,rgba(35,82,222,0.07),transparent_70%)] blur-3xl" />
        <div className="absolute -bottom-[18%] -right-[8%] h-[50%] w-[50%] rounded-full bg-[radial-gradient(ellipse,rgba(134,105,185,0.06),transparent_70%)] blur-3xl" />
      </div>

      <div className="relative z-10 flex min-h-full items-center justify-center px-6 py-10">
        <div className="w-full max-w-[1080px]">
        {/* Header — left aligned */}
        <div className="text-left">
          <span className="lw-section-eyebrow">Learnings · Private preview</span>
          <h1 className="mt-2 text-4xl font-medium tracking-[-0.04em] text-foreground">Own your firm&apos;s intelligence</h1>
          <p className="mt-2 max-w-lg text-sm text-muted-foreground">
            Your firm&apos;s own models, learned on your matters, improving every week.
          </p>
        </div>

        {/* Three pillar cards */}
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          <PreviewCard
            step="01"
            title="Data structuring & Benchmarks"
            desc="We extract the firm's tacit knowledge from your matters, redlines, and comments: partner preferences, drafting style, negotiation playbooks, and review standards."
            blurred={false}
            onClick={() => setView("benchmark")}
            cta={
              <Button
                size="sm"
                className="gap-1.5"
                onClick={(event) => {
                  event.stopPropagation();
                  setView("benchmark");
                }}
              >
                Start
                <ArrowRight className="size-3.5" />
              </Button>
            }
          >
            <DataStructuringViz />
          </PreviewCard>
          <PreviewCard
            step="02"
            title="Post learning"
            desc="A specialist model per practice area, learned on your work and benchmarked against open baselines. Weights your firm owns."
            cta={<TalkWithResearcherLink />}
          >
            <ModelsViz />
          </PreviewCard>
          <PreviewCard
            step="03"
            title="Continual learning"
            desc="Signals from real work, like corrections, rewrites, and missed context, become verifiable tasks that continual learn your models and roll out."
            cta={<TalkWithResearcherLink />}
          >
            <ContinualLearningViz />
          </PreviewCard>
        </div>
        </div>
      </div>
    </div>
  );
}
