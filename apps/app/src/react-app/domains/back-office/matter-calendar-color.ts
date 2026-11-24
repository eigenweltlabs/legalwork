import type { CSSProperties } from "react";
import { THEME_LIGHT } from "twenty-ui/theme";
import { recordColor } from "./record-colors";
import { calendarDisplayColor, type CalendarColor } from "../calendar/calendar-colors";

/** Match RecordChip's Avatar: the matter ID is its color seed and soft uses shade 4. */
export function matterCalendarColor(matterId: string | null, theme: Pick<typeof THEME_LIGHT, "color"> = THEME_LIGHT): CalendarColor {
  if (!matterId) return calendarDisplayColor(null);
  const name = recordColor(matterId);
  const style: CSSProperties & { [key: `--matter-${string}`]: string } = {
    "--matter-fill": theme.color[`${name}4`], "--matter-hover": theme.color[`${name}5`],
    "--matter-border": theme.color[`${name}6`], "--matter-ink": theme.color[`${name}12`],
  };
  return {
    card: "border-[color:var(--matter-border)] bg-[var(--matter-fill)] hover:bg-[var(--matter-hover)]",
    accent: "text-[color:var(--matter-ink)]", marker: "text-[color:var(--matter-ink)]", style,
  };
}
