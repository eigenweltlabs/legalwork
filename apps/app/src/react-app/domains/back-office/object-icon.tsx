import { CalendarDays,ListTodo,Link2, BriefcaseBusiness, Building2, Database, UserRound, UsersRound } from "lucide-react";

export const primaryObjectIcons = new Map([
  ["matters", BriefcaseBusiness],
  ["clients", UsersRound],
  ["people", UserRound],
  ["companies", Building2],
]);

export function ObjectIcon({ id, size = 15, className }: { id: string; size?: number; className?: string }) {
  const Icon = primaryObjectIcons.get(id) ?? (id === "@tasks" ? ListTodo : id === "@deadlines" ? CalendarDays : id === "@member" ? UserRound : id === "@directory" ? Link2 : Database);
  return <Icon size={size} className={className} aria-hidden="true" />;
}
