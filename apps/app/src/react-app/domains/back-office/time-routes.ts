export const timeRoutes = {
  timesheets: "/time",
  "timesheet-workday": "/time/workday",
  "billing-review": "/time/review",
  "billing-settings": "/time/settings",
} as const;

export function timePage(path: string) {
  return (Object.keys(timeRoutes) as (keyof typeof timeRoutes)[]).find(
    (page) => path === timeRoutes[page] || path === "/back-office/" + page,
  );
}
