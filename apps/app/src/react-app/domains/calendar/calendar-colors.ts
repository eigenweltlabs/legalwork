const PROJECT_COLORS = [
  { card: "border-blue-6/70 bg-blue-3/60 hover:bg-blue-4/80", accent: "text-blue-11" },
  { card: "border-violet-6/70 bg-violet-3/60 hover:bg-violet-4/80", accent: "text-violet-11" },
  { card: "border-teal-6/70 bg-teal-3/60 hover:bg-teal-4/80", accent: "text-teal-11" },
  { card: "border-orange-6/70 bg-orange-3/60 hover:bg-orange-4/80", accent: "text-orange-11" },
  { card: "border-pink-6/70 bg-pink-3/60 hover:bg-pink-4/80", accent: "text-pink-11" },
  { card: "border-cyan-6/70 bg-cyan-3/60 hover:bg-cyan-4/80", accent: "text-cyan-11" },
  { card: "border-green-6/70 bg-green-3/60 hover:bg-green-4/80", accent: "text-green-11" },
  { card: "border-amber-6/70 bg-amber-3/60 hover:bg-amber-4/80", accent: "text-amber-11" },
  { card: "border-bronze-6/70 bg-bronze-3/60 hover:bg-bronze-4/80", accent: "text-bronze-11" },
  { card: "border-indigo-6/70 bg-indigo-3/60 hover:bg-indigo-4/80", accent: "text-indigo-11" },
];

/** Project identity keeps the color stable across renames, filters and date ranges. */
export function calendarProjectColor(projectId: string | null) {
  if (!projectId) return { card: "border-border/60 bg-muted/40 hover:bg-muted", accent: "text-muted-foreground" };
  let hash = 2166136261;
  for (const character of projectId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return PROJECT_COLORS[(hash >>> 0) % PROJECT_COLORS.length];
}
