import { ArrowRight, CalendarCheck2, CalendarClock, Clock3, FileCheck2, ListChecks, Monitor, Repeat2, Sunrise } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconTile, Surface } from "@/react-app/design-system/surface";
import { cn } from "@/lib/utils";
import { currentLocale, t } from "@/i18n";
import type { ScheduledTaskDraft } from "./scheduled-task-dialog";
import { suggestedSchedule } from "./schedule-format";

export function ScheduledTasksWelcome({ connected, hasProjects, assistantWorkspaceId, onCreate }: {
  connected: boolean; hasProjects: boolean; assistantWorkspaceId?: string; onCreate: (draft?: ScheduledTaskDraft) => void;
}) {
  const disabled = !connected || !hasProjects;
  const templates = [
    { key: "brief", workspaceId: assistantWorkspaceId, Icon: Sunrise, color: "text-amber-11", title: t("scheduled.template_brief"), description: t("scheduled.template_brief_description"), prompt: t("scheduled.template_brief_prompt"), cadence: t("scheduled.routine_mornings"), schedule: () => suggestedSchedule("weekdays", 6) },
    { key: "deadlines", Icon: CalendarCheck2, color: "text-blue-11", title: t("scheduled.template_deadlines"), description: t("scheduled.template_deadlines_description"), prompt: t("scheduled.template_deadlines_prompt"), cadence: t("scheduled.routine_deadlines"), schedule: () => suggestedSchedule("weekdays", 8) },
    { key: "review", Icon: FileCheck2, color: "text-green-11", title: t("scheduled.template_review"), description: t("scheduled.template_review_description"), prompt: t("scheduled.template_review_prompt"), cadence: t("scheduled.routine_fridays"), schedule: () => suggestedSchedule("friday", 16) },
    { key: "planning", Icon: ListChecks, color: "text-violet-11", title: t("scheduled.template_planning"), description: t("scheduled.template_planning_description"), prompt: t("scheduled.template_planning_prompt"), cadence: t("scheduled.routine_mondays"), schedule: () => suggestedSchedule("monday", 9) },
  ];
  const weekday = new Intl.DateTimeFormat(currentLocale(), { weekday: "short", timeZone: "UTC" });

  return <div className="@container/welcome mx-auto flex min-h-full max-w-5xl flex-col justify-center gap-8 py-4 lw-enter @3xl:py-6">
    <div className="grid items-center gap-8 @2xl/welcome:grid-cols-2 @4xl/welcome:gap-16">
      <div>
        <div className="mb-4 flex items-center gap-2 text-xs font-medium text-muted-foreground"><CalendarClock className="size-4 text-blue-11" />{t("scheduled.routines_eyebrow")}</div>
        <h1 className="max-w-[17ch] text-balance text-3xl font-semibold leading-[1.12] tracking-[-0.04em] @3xl/welcome:text-4xl">{t("scheduled.welcome")}</h1>
        <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted-foreground">{t("scheduled.description")}</p>
        <Button className="mt-6" disabled={disabled} onClick={() => onCreate()}>{t("scheduled.new")}<ArrowRight className="size-4" /></Button>
        {!connected ? <p className="mt-3 text-xs text-muted-foreground">{t("scheduled.disconnected")}</p> : !hasProjects && <p className="mt-3 text-xs text-muted-foreground">{t("scheduled.no_projects")}</p>}
      </div>
      <div className="relative isolate rounded-[var(--lw-radius-2xl)] bg-muted/40 p-4 @lg/welcome:p-5">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 rounded-[inherit] bg-[radial-gradient(ellipse_at_top_right,var(--blue-3),transparent_70%)]" />
        <div className="mb-4 flex items-center justify-between gap-3"><h2 className="text-sm font-medium">{t("scheduled.example_week")}</h2><span className="rounded-full border border-border bg-background/60 px-2 py-0.5 text-[10px] text-muted-foreground">{t("scheduled.example")}</span></div>
        <div aria-hidden="true" className="mb-4 grid grid-cols-7 gap-1.5">
          {Array.from({ length: 7 }, (_, day) => <div key={day} className={cn("flex min-w-0 flex-col items-center gap-2 rounded-lg border px-1 py-2", day < 5 ? "border-border bg-background/80" : "border-transparent text-muted-foreground/60")}>
            <span className="text-[10px] font-medium">{weekday.format(new Date(Date.UTC(2026, 0, 5 + day)))}</span>
            <div className="flex h-4 items-end gap-1"><span className={cn("w-1 rounded-full", day < 5 ? "h-3 bg-amber-9/70" : "h-1 bg-border")} />{day === 4 && <span className="h-4 w-1 rounded-full bg-green-9/70" />}</div>
          </div>)}
        </div>
        <div className="relative space-y-3 before:absolute before:bottom-5 before:left-5 before:top-5 before:w-px before:bg-border">
          {[templates[0], templates[2]].map(({ key, Icon, color, title, cadence }) => <Surface key={key} className="relative flex items-center gap-3 p-2.5 shadow-xs">
            <IconTile size="sm" className={color}><Icon /></IconTile><div className="min-w-0"><p className="text-xs font-medium leading-snug">{title}</p><p className="mt-1 text-[11px] text-muted-foreground">{cadence}</p></div><Repeat2 className="ml-auto size-3.5 shrink-0 text-muted-foreground/60" />
          </Surface>)}
        </div>
        <p className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground"><Clock3 className="size-3" />{t("scheduled.your_schedule")}</p>
      </div>
    </div>
    <section>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2"><h2 className="text-base font-medium tracking-tight">{t("scheduled.start_routine")}</h2><p className="text-xs text-muted-foreground">{t("scheduled.templates_hint")}</p></div>
      <div className="grid gap-3 @md/welcome:grid-cols-2">
        {templates.map(({ key, workspaceId, Icon, color, title, description, prompt, cadence, schedule }) => <Button key={key} variant="outline" disabled={disabled || (key === "brief" && !workspaceId)} onClick={() => onCreate({ title, prompt, workspaceId, schedule: schedule() })}
          className="group h-auto min-w-0 flex-col items-stretch gap-0 whitespace-normal rounded-[var(--lw-radius-2xl)] p-4 text-left font-normal shadow-none transition-[background-color,border-color,box-shadow] hover:border-foreground/20 hover:bg-muted/30 hover:shadow-sm">
          <span className="flex items-center justify-between gap-3"><IconTile size="sm" className={color}><Icon /></IconTile><span className="text-[11px] text-muted-foreground">{cadence}</span></span>
          <span className="mt-3 text-sm font-medium text-foreground">{title}</span><span className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{description}</span>
          <span className="mt-auto flex items-center justify-between pt-4 text-xs text-muted-foreground group-hover:text-foreground"><span>{t("scheduled.use_template")}</span><ArrowRight className="size-3.5 transition-transform motion-safe:group-hover:translate-x-0.5" /></span>
        </Button>)}
      </div>
    </section>
    <div className="flex items-start gap-3 border-t border-border pt-5"><Monitor className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div><p className="text-xs font-medium">{t("scheduled.local_title")}</p><p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{t("scheduled.local_detail")}</p></div></div>
  </div>;
}
