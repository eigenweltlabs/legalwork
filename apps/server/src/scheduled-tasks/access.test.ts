import { expect, test } from "bun:test";
import { ScheduledTaskInputSchema } from "./schema.js";
import { ALL_PROJECTS_TASK_AGENT, PROJECT_TASK_AGENT, hasProjectTaskBoundary, projectTaskPermissions, allProjectTaskPermissions } from "./access.js";
import { LegalWorkScheduledTaskTools } from "../opencode-plugins/legalwork-scheduled-task-tools.js";

test("project-only agent denies unscoped tools and preserves user tool permissions", () => {
  expect(projectTaskPermissions({ "*": "ask", "legalwork_project_*": "deny", legalwork_calendar_get: "allow" })).toMatchObject({
    "*": "deny", legalwork_project_read: "deny", legalwork_calendar_get: "allow", legalwork_calendar_list: "ask",
  });
  expect(ScheduledTaskInputSchema.shape.projectAccess.parse(undefined)).toBe("project");
  expect(hasProjectTaskBoundary(undefined)).toBe(false);
  expect(hasProjectTaskBoundary({ name: PROJECT_TASK_AGENT, permission: [{ permission: "*", pattern: "*", action: "deny" }, { permission: "legalwork_project_read", pattern: "*", action: "allow" }] })).toBe(true);
  for (const permission of ["*", "bash", "read", "task", "mcp_*", "legalwork_schedule_update"]) {
    expect(hasProjectTaskBoundary({ name: PROJECT_TASK_AGENT, permission: [{ permission: "*", pattern: "*", action: "deny" }, { permission, pattern: "*", action: "allow" }] })).toBe(false);
  }
});

test("all-project runs preserve normal permissions but disable app UI tools", () => {
  expect(allProjectTaskPermissions({ bash: "ask", "legalwork_ui_*": "allow", legalwork_ui_execute_action: "allow", read: "deny" })).toMatchObject({
    bash: "ask", read: "deny", legalwork_ui_execute_action: "deny", legalwork_ui_snapshot: "deny", legalwork_ui_list_actions: "deny",
  });
});

test("scheduled project tools reject cross-project reads by default and allow explicit all-project runs", async () => {
  const url = process.env.LEGALWORK_SERVER_URL, token = process.env.LEGALWORK_SERVER_TOKEN;
  const reads: string[] = [];
  const queries: URLSearchParams[] = [];
  const projects = [{ id: "current", name: "Current", path: "/matters/current" }, { id: "other", name: "Other", path: "/matters/other" }];
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/workspaces") return Response.json({ items: projects });
    if (path === "/scheduled-tasks/projects") return Response.json({ projects });
    reads.push(path); queries.push(new URL(request.url).searchParams); return Response.json({ content: "Fixture source" });
  } });
  process.env.LEGALWORK_SERVER_URL = server.url.origin; process.env.LEGALWORK_SERVER_TOKEN = "fixture";
  try {
    const plugin = await LegalWorkScheduledTaskTools();
    const context = { agent: PROJECT_TASK_AGENT, directory: "/matters/current", sessionID: "scheduled" };
    const list = JSON.parse(await plugin.tool.legalwork_schedule_projects.execute({}, context));
    expect(list.projects).toEqual([projects[0]]);
    const denied = JSON.parse(await plugin.tool.legalwork_schedule_project_read.execute({ projectId: "other", kind: "files", id: "brief.md" }, context));
    expect(denied.ok).toBe(false); expect(reads).toEqual([]);
    await plugin.tool.legalwork_schedule_project_read.execute({ kind: "files", id: "brief.md" }, context);
    await plugin.tool.legalwork_schedule_project_read.execute({ projectId: "other", kind: "files", id: "brief.md" }, { ...context, agent: ALL_PROJECTS_TASK_AGENT });
    expect(reads).toEqual(["/workspace/current/project/content", "/workspace/other/project/content"]);
    const chatDenied = JSON.parse(await plugin.tool.legalwork_schedule_project_read.execute({ projectId: "other", kind: "sessions", id: "chat" }, context));
    expect(chatDenied.ok).toBe(false);
    await plugin.tool.legalwork_schedule_project_read.execute({ projectId: "other", kind: "sessions", id: "chat", before: "msg_old", offset: 12000 }, { ...context, agent: ALL_PROJECTS_TASK_AGENT });
    expect(Object.fromEntries(queries.at(-1)!)).toEqual({ kind: "sessions", id: "chat", before: "msg_old", offset: "12000" });
    await plugin.tool.legalwork_schedule_project_list.execute({ projectId: "other", kind: "sessions", limit: 100, cursor: "50" }, { ...context, agent: ALL_PROJECTS_TASK_AGENT });
    expect(Object.fromEntries(queries.at(-1)!)).toEqual({ kind: "sessions", limit: "50", cursor: "50" });
    const missing = JSON.parse(await plugin.tool.legalwork_schedule_project_list.execute({ projectId: "unknown" }, { ...context, agent: ALL_PROJECTS_TASK_AGENT }));
    expect(missing.ok).toBe(false);
    const regular = JSON.parse(await plugin.tool.legalwork_schedule_projects.execute({}, { ...context, agent: "legalwork" }));
    expect(regular.ok).toBe(false);
  } finally {
    server.stop(true);
    if (url === undefined) delete process.env.LEGALWORK_SERVER_URL; else process.env.LEGALWORK_SERVER_URL = url;
    if (token === undefined) delete process.env.LEGALWORK_SERVER_TOKEN; else process.env.LEGALWORK_SERVER_TOKEN = token;
  }
});
