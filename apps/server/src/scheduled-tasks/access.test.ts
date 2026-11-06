import { permissionAction } from "../agent-sandbox/permissions.js";
import { nativePluginTools } from "../opencode-plugins/native-plugin-test-support.js";
const LegalWorkScheduledTaskTools = (context = {}) => nativePluginTools(LegalWorkScheduledTaskToolsDefinition, context);
import { expect, test } from "bun:test";
import { ScheduledTaskInputSchema } from "./schema.js";
import { ALL_PROJECTS_TASK_AGENT, PROJECT_TASK_AGENT, hasProjectTaskBoundary, projectTaskPermissions, allProjectTaskPermissions } from "./access.js";
import LegalWorkScheduledTaskToolsDefinition from "../opencode-plugins/legalwork-scheduled-task-tools.js";

test("project-only agent denies unscoped tools and preserves ordered user tool permissions", () => {
  const policy = projectTaskPermissions([
    { action: "*", resource: "*", effect: "ask" },
    { action: "legalwork_project_*", resource: "*", effect: "deny" },
    { action: "legalwork_calendar_get", resource: "*", effect: "allow" },
    { action: "legalwork_calendar_get", resource: "private-*", effect: "deny" },
  ]);
  expect(permissionAction(policy, "legalwork_project_read", "brief.md")).toBe("deny");
  expect(permissionAction(policy, "legalwork_calendar_get", "public-event")).toBe("allow");
  expect(permissionAction(policy, "legalwork_calendar_get", "private-event")).toBe("deny");
  expect(permissionAction(policy, "legalwork_calendar_list", "*")).toBe("ask");
  for (const tool of ["shell", "read", "task", "mcp_mail", "legalwork_schedule_update"]) expect(permissionAction(policy, tool, "*")).toBe("deny");
  expect(ScheduledTaskInputSchema.shape.projectAccess.parse(undefined)).toBe("project");
  const defaults = projectTaskPermissions();
  for (const tool of ["legalwork_schedule_clock", "legalwork_recordings_list", "legalwork_recording_read"]) expect(permissionAction(defaults, tool, "*")).toBe("allow");
  const denied = projectTaskPermissions([{ action: "legalwork_recording*", resource: "*", effect: "deny" }]);
  for (const tool of ["legalwork_recordings_list", "legalwork_recording_read"]) expect(permissionAction(denied, tool, "*")).toBe("deny");
  expect(hasProjectTaskBoundary(undefined)).toBe(false);
  expect(hasProjectTaskBoundary({ id: PROJECT_TASK_AGENT, permissions: defaults })).toBe(true);
  for (const action of ["*", "shell", "read", "task", "mcp_*", "legalwork_schedule_update"]) {
    expect(hasProjectTaskBoundary({ id: PROJECT_TASK_AGENT, permissions: [{ action: "*", resource: "*", effect: "deny" }, { action, resource: "*", effect: "allow" }] })).toBe(false);
  }
});

test("all-project runs preserve native resource rules and disable app UI tools", () => {
  const policy = allProjectTaskPermissions([
    { action: "shell", resource: "*", effect: "ask" },
    { action: "legalwork_ui_*", resource: "*", effect: "allow" },
    { action: "read", resource: "private/*", effect: "deny" },
  ]);
  expect(permissionAction(policy, "shell", "git status")).toBe("ask");
  expect(permissionAction(policy, "read", "private/brief.md")).toBe("deny");
  for (const action of ["legalwork_ui_execute_action", "legalwork_ui_snapshot", "legalwork_ui_list_actions"]) expect(permissionAction(policy, action, "*")).toBe("deny");
});

test("scheduled project tools reject cross-project reads by default and allow explicit all-project runs", async () => {
  const url = process.env.LEGALWORK_SERVER_URL, token = process.env.LEGALWORK_SERVER_TOKEN;
  const reads: string[] = [];
  const queries: URLSearchParams[] = [];
  const projects = [{ id: "current", name: "Current", path: "/matters/current" }, { id: "other", name: "Other", path: "/matters/other" }];
  const server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/assistant") return Response.json({ workspace: null });
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
