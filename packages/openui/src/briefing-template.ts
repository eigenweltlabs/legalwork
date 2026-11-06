const bindings = `matters = Query("data", {name:"matters"}, {rows:[],total:0})
emails = Query("data", {name:"emails"}, {rows:[],total:0})
tasks = Query("data", {name:"tasks"}, {rows:[],total:0})`;
const overview = `Stack([Metric("Matters", matters.total, "With open actions"), Metric("Priority emails", emails.total), Metric("Open actions", tasks.total)], 3),
BarChart(matters.rows, "matter", ["overdue", "due_today", "upcoming"], "Actions by matter")`;

/** Reusable source-backed layouts, not sample facts to copy into a real briefing. */
export const MORNING_BRIEFING_TEMPLATE = {
  purpose: "A dated, calm morning briefing: priorities first, a matter workload chart, urgent emails with source links, and actionable tasks. Localize all labels and use the actual local date.",
  mode: "report",
  queries: {},
  datasets: {
    matters: "One row per matter with verified open actions: matter, overdue, due_today, upcoming (numeric counts, recorded dates only). total is the number of matters represented. Undated work belongs in tasks, not in a guessed date bucket. Use at most 8 chart rows; group remaining matters as Other without losing counts. Do not imply totals are firm-wide unless the source supports that.",
    emails: "Only important actionable messages from authorized connected email tools. Rows: title (subject), detail (why it matters and next action), meta (sender and received time), href (exact source URL), priority (High or Urgent only when supported). total matches the rows. Do not assume unread means urgent. Do not search browser pages, send mail or change read state.",
    tasks: "Verified next actions in priority order. Rows: title, detail (matter and next action), meta (recorded owner and due date, or undated), href (exact returned task/source link), priority. total matches the rows. Do not infer deadlines or ownership.",
    metadata: "Every dataset needs rows, total, revision (source revision or a snapshot identifier), asOf (actual capture timestamp), truncated. Keep sources/sourceOwner when known. Missing email access is not zero urgent emails: omit that metric and section and briefly note email unavailable where relevant. No invented example data.",
  },
  program: `${bindings}
root = Stack([Heading("Morning briefing", 1), ${overview}, Card("Priority emails", [ActionList(emails.rows, "No priority emails in the checked messages")]), Card("Next actions", [ActionList(tasks.rows, "No verified open actions")])])`,
  overviewProgram: `${bindings}
root = Stack([${overview}])`,
  markdown: `# Morning briefing · {{local date}}

{{One short paragraph naming the most important next action.}}

{{Paste the exact legalwork-view fence returned by legalwork_assistant_save_report here. Use overviewProgram so the detailed text below is not duplicated.}}

## Needs your attention
{{Up to three verified decisions or actions, each with its source link.}}

## Priority emails
{{Subject link, sender, why it matters, and suggested next action. Omit if not relevant; do not fabricate links.}}

## Tasks by matter
### {{Matter name}}
- [ ] {{Concrete action}} · {{priority and recorded due date}} · [Open task]({{returned task URL}})

## Notes
{{Preserve the user's notes and existing checked items on updates.}}
`,
  workflow: "For an authorized Assistant briefing: read sources, build datasets, save overviewProgram with legalwork_assistant_save_report using key morning-briefing-YYYY-MM-DD, embed the returned Markdown fence in briefings/YYYY-MM-DD.md, verify both saved outputs, then share only the Markdown file using legalwork_assistant_share_file. Use the full program for a standalone visual report. Read view_list/view_read before updating an existing key and pass its exact baseRevision; never reset user notes or duplicate checkboxes. General project/wiki views continue to use view_create/view_update previews and the user's Save action. Use a snapshot for a daily briefing, never describe it as live. Omit charts when the data does not support them.",
};
