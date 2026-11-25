export const timeRoutes = {
  timesheets: "/time",
  "timesheet-workday": "/time/workday",
  "billing-review": "/time/review",
  "billing-settings": "/time/settings",
} as const;

export function timeEntryReviewPath(entry: { id: string; date: string }) {
  return timeRoutes["billing-review"] + "?" + new URLSearchParams({ date: entry.date, reviewEntry: entry.id });
}

export function timePage(path: string) {
  return (Object.keys(timeRoutes) as (keyof typeof timeRoutes)[]).find(
    (page) => path === timeRoutes[page] || path === "/back-office/" + page,
  );
}
