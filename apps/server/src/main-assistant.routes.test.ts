import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("assistant HTTP provisioning, scheduling, source scope, delegation and permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "assistant-http-"));
  const script = join(root, "test.mjs");
  await writeFile(script, `
    import assert from "node:assert/strict";
    import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
    import { join } from "node:path";
    const { startServer } = await import(${JSON.stringify(new URL("./server.ts", import.meta.url).href)});
    const root = process.env.XDG_CONFIG_HOME, folder = join(root, "matter");
    await mkdir(folder);
    const sessions = new Map(); const deliveries = []; const finished = new Set(); const notices = new Map();
    let failSend = false, failReads = false; const running = new Set(); const disposals = [];
    let pendingApprovals = [], pendingQuestions = []; const attentionReplies = [];
    const engine = Bun.serve({ port: 0, async fetch(request) {
      const url = new URL(request.url), path = url.pathname;
      const directory = decodeURIComponent(request.headers.get("x-opencode-directory") || url.searchParams.get("directory") || folder);
      if (path === "/permission") return Response.json(pendingApprovals);
      if (path === "/question") return Response.json(pendingQuestions);
      if (path.startsWith("/api/session/")) return new Response(null, { status: 404 });
      if ((path.startsWith("/permission/") || path.startsWith("/question/")) && path.endsWith("/reply")) {
        attentionReplies.push({ path, body: await request.json() });
        pendingApprovals = []; pendingQuestions = [];
        return Response.json(true);
      }
      if (path.endsWith("/children")) return Response.json([]);
      if (path.endsWith("/abort")) { running.delete(path.split("/")[2]); return Response.json(true); }
      if (path === "/session/status") return failReads ? new Response(null, { status: 503 }) : Response.json(Object.fromEntries([...running].map(id => [id, { type: "busy" }])));
      if (path === "/instance/dispose") { disposals.push(directory); running.clear(); return Response.json(true); }
      if (path === "/session" && request.method === "GET") return Response.json([...sessions.values()]);
      if (path === "/session" && request.method === "POST") {
        const id = "chat-" + sessions.size;
        const session = { id, title: (await request.json()).title, directory, time: { created: Date.now(), updated: Date.now() }, version: "1", slug: id, projectID: "project" };
        sessions.set(id, session); return Response.json(session);
      }
      if (path.endsWith("/prompt_async")) { const sessionId = path.split("/")[2]; const input = await request.json(); deliveries.push({ sessionId, directory, ...input }); if (!failSend) { running.add(sessionId); if (input.messageID) notices.set(input.messageID, { info: { id: input.messageID, sessionID: sessionId, role: "user" }, parts: input.parts }); } return new Response(null, { status: failSend ? 503 : 204 }); }
      if (path.endsWith("/todo")) return failReads ? new Response(null, { status: 503 }) : Response.json([{ content: "Review draft", status: "pending", priority: "medium" }]);
      if (path.endsWith("/message")) return Response.json([{ info: { id: "last-reply", sessionID: path.split("/")[2], role: "assistant", time: { created: Date.now(), ...(finished.has(path.split("/")[2]) ? { completed: Date.now() } : {}) }, finish: finished.has(path.split("/")[2]) ? "stop" : undefined, providerID: "fixture-provider", modelID: "chosen-model" }, parts: [{ type: "text", text: "Draft ready; awaiting partner review." }, { type: "text", synthetic: true, text: "hidden reminder" }] }]);
      if (path.includes("/message/")) return notices.has(path.split("/").at(-1)) ? Response.json(notices.get(path.split("/").at(-1))) : new Response(null, { status: 404 });
      if (path.startsWith("/session/")) { const item = sessions.get(path.split("/")[2]); return item ? Response.json(item) : new Response(null, { status: 404 }); }
      return Response.json({});
    }});
    const config = { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "host", configPath: join(root, "server.json"), projectsDirectory: join(root, "projects"),
      opencodeBaseUrl: engine.url.origin, approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [],
      workspaces: [{ id: "matter", name: "Matter", path: folder, preset: "starter", workspaceType: "local", baseUrl: engine.url.origin }],
      authorizedRoots: [root], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
    const recordings = Array.from({ length: 105 }, (_, index) => ({ id: "rec-" + index, title: "Recording " + index, createdAt: 1000 - index, durationMs: 1000, status: "complete", segmentCount: 1, projectIds: [], error: null }));
    const recorderCalls = [];
    config.recorder = {
      status: () => ({ available: true, recordingActive: false, liveTranscriptActive: false, fileName: null, error: null }),
      setLiveTranscript: () => { throw new Error("Not used"); },
      library: {
        list: async () => recordings,
        read: async id => { const meta = recordings.find(item => item.id === id); return meta ? { meta, segments: [{ startMs: 0, text: id === "rec-104" ? "Needle client transcript" : "Long transcript ".repeat(1000) }] } : null; },
        rename: async (id, title) => { recordings.find(item => item.id === id).title = title; },
        link: async (id, projectId, linked) => { const item = recordings.find(item => item.id === id); item.projectIds = linked ? [...new Set([...item.projectIds, projectId])] : item.projectIds.filter(id => id !== projectId); },
        trash: async id => { recordings.splice(recordings.findIndex(item => item.id === id), 1); },
        control: async input => { recorderCalls.push(input); return { ok: true, recording: null }; },
      },
    };
    const server = await startServer(config), base = "http://127.0.0.1:" + server.port;
    const call = (path, method="GET", body, token="fixture") => fetch(base + path, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    try {
      assert.equal((await call("/assistant/current", "POST", {}, "wrong")).status, 401);
      const projectFields = [{ id: "our_client", label: "Our client", type: "text", value: null }];
      const [a, b] = await Promise.all([call("/assistant/current", "POST", { projectFields }), call("/assistant/current", "POST", {})]);
      const assistant = await a.json(); assert.deepEqual(await b.json(), assistant);
      assert.equal(assistant.workspace.preset, "main-assistant");
      assert.equal(assistant.workspace.path, join(root, "projects", "Assistant"));
      assert.equal(sessions.size, 1);
      assert.deepEqual(assistant.profile, { name: null, icon: "dot" });
      assert.equal((await (await call("/assistant/onboarding")).json()).needed, true);
      assert.equal((await (await call("/assistant/onboarding")).json()).greetingUnread, true);
      const viewed = await (await call("/assistant/onboarding/view", "POST")).json();
      assert.equal(viewed.greetingUnread, false); assert.equal(viewed.needed, true);
      for (const invalid of [{ name: " " }, { name: "x".repeat(61) }, { icon: "unknown" }, { name: "Josi", icon: "bird" }]) {
        assert.equal((await call("/assistant/onboarding", "POST", invalid)).status, 400);
      }
      assert.equal((await call("/assistant/onboarding", "POST", { icon: "bird" })).status, 409);
      const naming = await (await call("/assistant/name", "POST", { name: "Josi" })).json();
      assert.equal(naming.showAvatarPicker, true); assert.equal(naming.onboarding.agentNamed, true);
      const named = naming.onboarding;
      assert.equal(named.step, "avatar"); assert.equal(named.sessionId, assistant.day.sessionId);
      assert.deepEqual((await (await call("/assistant")).json()).profile, { name: "Josi", icon: "dot" });
      const chosen = await (await call("/assistant/onboarding", "POST", { icon: "professional_bear" })).json();
      assert.equal(chosen.needed, false); assert.equal(chosen.step, "complete");
      for (const icon of ["bird", "professional_bear", "professional_fox", "professional_owl"]) {
        assert.equal((await call("/assistant/profile", "PATCH", { name: null, icon })).status, 200);
        assert.deepEqual((await (await call("/assistant/current", "POST", {})).json()).profile, { name: null, icon });
      }
      assert.equal((await call("/assistant/profile", "PATCH", { name: "Momo", icon: "otter" })).status, 200);
      assert.equal((await (await call("/assistant/onboarding")).json()).needed, false);
      assert.equal((await call("/assistant/onboarding", "GET", undefined, "wrong")).status, 401);
      assert.equal((await (await call("/assistant/current", "POST", {})).json()).workspace.name, "Momo");
      assert.equal((await call("/assistant/profile", "PATCH", { name: " ", icon: "otter" })).status, 400);
      assert.equal((await call("/assistant/profile", "PATCH", { name: "Momo", icon: "unknown" })).status, 400);
      const originalProjects = config.workspaces;
      config.workspaces = Array.from({ length: 500 }, (_, index) => ({ ...originalProjects[0], id: "project-" + String(index).padStart(4, "0"), name: "Project " + String(index).padStart(4, "0") }));
      let cursor = "", listed = [];
      do {
        const page = await (await call("/assistant/projects?limit=50" + (cursor ? "&cursor=" + cursor : ""))).json();
        listed.push(...page.projects.map(project => project.id)); cursor = page.nextCursor;
      } while (cursor);
      assert.equal(new Set(listed).size, 500); assert.equal(listed.length, 500);
      assert.equal((await (await call("/assistant/projects?query=0499")).json()).projects[0].id, "project-0499");
      config.workspaces.push({ ...originalProjects[0], id: "aster", name: "Project Aster" }, { ...originalProjects[0], id: "alster", name: "Alster" });
      const firstMatch = await (await call("/assistant/projects?query=alster&limit=1")).json();
      assert.equal(firstMatch.projects[0].id, "alster"); assert.equal(firstMatch.projects[0].match, "exact");
      const secondMatch = await (await call("/assistant/projects?query=alster&limit=1&cursor=" + firstMatch.nextCursor)).json();
      assert.equal(secondMatch.projects[0].id, "aster"); assert.equal(secondMatch.projects[0].match, "approximate"); assert.equal(secondMatch.nextCursor, null);
      assert.equal((await call("/assistant/projects?query=other&cursor=" + firstMatch.nextCursor)).status, 400);
      config.workspaces = originalProjects;
      assert.equal((await (await call("/assistant/history")).json()).days[0].sessionId, assistant.day.sessionId);
      assert.equal((await call("/assistant/history?before=bad")).status, 400);
      const schedule = await (await call("/workspace/" + assistant.workspace.id + "/scheduled-tasks", "POST", {
        title: "Morning brief", prompt: "Review open projects", sessionId: assistant.day.sessionId, reuseChat: true, pinSession: true, projectAccess: "project",
        schedule: { kind: "rrule", startAt: "2099-10-08T06:00:00", timeZone: "Europe/Berlin", rrule: "FREQ=DAILY" }
      })).json();
      assert.equal(schedule.task.sessionId, null); assert.equal(schedule.task.reuseChat, false); assert.equal(schedule.task.projectAccess, "all"); assert.equal(schedule.task.pinSession, false);
      const project = await (await call("/assistant/projects", "POST", { name: "Acquisition" })).json();
      assert.equal(project.project.path, join(root, "projects", "Acquisition"));
      assert.deepEqual(project.details.fields, projectFields);
      const metadata = await call("/workspace/" + project.project.id + "/project/metadata", "PATCH", { revision: project.details.revision, values: { our_client: "Nordstern GmbH" } });
      assert.equal(metadata.status, 200);
      assert.equal((await call("/workspace/" + project.project.id + "/project/metadata", "PATCH", { revision: project.details.revision, values: { our_client: "Wrong stale update" } })).status, 409);
      const byClient = await (await call("/assistant/projects?query=Nordstern")).json();
      assert.equal(byClient.projects[0].id, project.project.id); assert.equal(byClient.projects[0].match, "metadata");
      for (const projectId of ["matter", project.project.id]) {
        assert.equal((await call("/workspace/" + projectId + "/tasks", "POST", { title: "Review escrow", projectId, dueDate: "2099-10-08" })).status, 201);
        assert.equal((await call("/workspace/" + projectId + "/calendar", "POST", { title: "Escrow filing", kind: "deadline", start: "2099-10-09", source: "Fixture" })).status, 200);
      }
      const tasks = await (await call("/assistant/tasks?query=ESCROW&limit=1")).json();
      assert.equal(tasks.items.length, 1); assert.ok(tasks.nextCursor); assert.equal(tasks.items[0].dueDate, "2099-10-08");
      const moreTasks = await (await call("/assistant/tasks?query=escrow&limit=1&cursor=" + tasks.nextCursor)).json();
      assert.equal(moreTasks.items.length, 1); assert.notEqual(tasks.items[0].id, moreTasks.items[0].id); assert.equal(moreTasks.nextCursor, null);
      assert.equal((await (await call("/assistant/tasks?query=escrow&projectId=matter")).json()).items.length, 1);
      const calendarQuery = "/assistant/calendar?from=2099-10-01&to=2099-11-01&kind=deadline&query=escrow&limit=1";
      const deadlines = await (await call(calendarQuery)).json();
      assert.equal(deadlines.items.length, 1); assert.equal(deadlines.items[0].verified, false); assert.equal(deadlines.items[0].start, "2099-10-09");
      const moreDeadlines = await (await call(calendarQuery + "&cursor=" + deadlines.nextCursor)).json();
      assert.equal(moreDeadlines.items.length, 1); assert.notEqual(deadlines.items[0].itemId, moreDeadlines.items[0].itemId);
      assert.equal((await call("/assistant/sessions/search?query=escrow&scope=project")).status, 400);
      assert.equal((await call("/assistant/calendar?from=2099-10-01&to=2099-09-01")).status, 400);
      const inbox = await (await call("/workspace/" + assistant.workspace.id + "/tasks", "POST", { title: "General follow-up", dueDate: "2099-10-07" })).json();
      const globalRange = "?from=2099-10-01&to=2099-11-01";
      const uiCalendar = await (await call("/calendar/occurrences" + globalRange)).json();
      const assistantCalendar = await (await call("/assistant/calendar" + globalRange)).json();
      assert.deepEqual(assistantCalendar.items.map(item => item.id).sort(), uiCalendar.occurrences.map(item => item.id).sort());
      assert.ok(assistantCalendar.items.some(item => item.itemId === inbox.task.id && item.projectId === null));
      const scheduleSearch = await (await call("/scheduled-tasks?limit=1")).json();
      assert.equal(scheduleSearch.tasks.length, 1); assert.ok(scheduleSearch.tasks[0].workspaceId);
      assert.equal(scheduleSearch.tasks[0].prompt, undefined);
      const recordingsPage = await (await call("/assistant/recordings?limit=2")).json();
      assert.equal(recordingsPage.items.length, 2); assert.ok(recordingsPage.nextCursor);
      const nextRecordings = await (await call("/assistant/recordings?limit=2&cursor=" + recordingsPage.nextCursor)).json();
      assert.equal(nextRecordings.items[0].id, "rec-2");
      assert.equal((await call("/assistant/recordings?query=changed&cursor=" + recordingsPage.nextCursor)).status, 400);
      const emptySearch = await (await call("/assistant/recordings?query=needle&searchTranscripts=true")).json();
      assert.equal(emptySearch.items.length, 0); assert.ok(emptySearch.nextCursor);
      const foundRecording = await (await call("/assistant/recordings?query=needle&searchTranscripts=true&cursor=" + emptySearch.nextCursor)).json();
      assert.equal(foundRecording.items[0].id, "rec-104");
      const transcript = await (await call("/assistant/recordings/rec-1?limit=50")).json();
      assert.equal(transcript.transcript.length, 50); assert.equal(transcript.nextOffset, 50);
      assert.equal((await call("/assistant/recordings/rec-1", "PATCH", { title: "Client call" })).status, 200);
      assert.equal((await call("/assistant/recordings/rec-1/project", "POST", { projectId: "missing", linked: true })).status, 404);
      const linked = await (await call("/assistant/recordings/rec-1/project", "POST", { projectId: "matter", linked: true })).json();
      assert.deepEqual(linked.recording.projectIds, ["matter"]);
      const filtered = await (await call("/assistant/recordings?projectId=matter")).json();
      assert.equal(filtered.items[0].title, "Client call");
      assert.equal((await call("/assistant/recorder", "GET")).status, 200);
      assert.equal((await call("/assistant/recorder", "POST", { action: "stop" })).status, 400);
      assert.equal((await call("/assistant/recorder", "POST", { action: "start", sources: ["microphone"] })).status, 200);
      assert.deepEqual(recorderCalls.at(-1), { action: "start", sources: ["microphone"] });
      assert.equal((await call("/assistant/recordings/rec-1", "DELETE")).status, 200);
      assert.equal((await call("/assistant/recordings/rec-1")).status, 404);
      assert.equal((await call("/assistant/recordings/..%2Fsecret", "DELETE")).status, 400);

      await writeFile(join(assistant.workspace.path, "request.txt"), "Nordstern GmbH agreement for review");
      const share = { workspaceId: assistant.workspace.id, sessionId: assistant.day.sessionId, path: "request.txt", title: "Agreement" };
      const shared = await call("/assistant/share-file", "POST", share);
      assert.equal(shared.status, 200);
      assert.equal((await shared.json()).file.path, "request.txt");
      assert.equal((await call("/assistant/share-file", "POST", { ...share, path: "missing.md" })).status, 404);
      assert.equal((await call("/assistant/share-file", "POST", { ...share, path: "../outside.md" })).status, 400);
      assert.equal((await call("/assistant/share-file", "POST", { ...share, path: "." })).status, 404);
      assert.equal((await call("/assistant/share-file", "POST", { ...share, workspaceId: project.project.id })).status, 403);
      await writeFile(join(project.project.path, "review.md"), "Provider-side review");
      const projectShare = { ...share, projectId: project.project.id, path: "review.md", title: "Provider-side review" };
      const projectCard = await call("/assistant/share-file", "POST", projectShare);
      assert.equal(projectCard.status, 200);
      assert.deepEqual((await projectCard.json()).file, { path: "review.md", title: "Provider-side review", size: 20,
        source: { workspaceId: project.project.id, workspaceRoot: await realpath(project.project.path), projectName: project.project.name } });
      await assert.rejects(readFile(join(assistant.workspace.path, "review.md")), { code: "ENOENT" }, "Sharing references the original instead of copying it");
      assert.equal((await call("/assistant/share-file", "POST", { ...projectShare, path: "../private.md" })).status, 400);
      assert.equal((await call("/assistant/share-file", "POST", { ...projectShare, path: "missing.md" })).status, 404);
      assert.equal((await call("/assistant/share-file", "POST", { ...projectShare, projectId: "unknown-project" })).status, 404);
      assert.equal((await call("/assistant/react", "POST", { workspaceId: assistant.workspace.id, sessionId: assistant.day.sessionId, assistantMessageId: "last-reply", emoji: "👍" })).status, 409);

      await writeFile(join(root, "outside.txt"), "Out of scope");
      const input = { files: ["request.txt"], initializeProject: true, workspaceId: project.project.id, sourceWorkspaceId: assistant.workspace.id, sourceSessionId: assistant.day.sessionId, title: "Review terms", conversationLanguage: "en", prompt: "Compare liability clauses and write the memorandum in German", scope: "Save a draft for partner review. Do not contact the counterparty." };
      assert.equal((await call("/assistant/delegate", "POST", { ...input, sourceWorkspaceId: "matter" })).status, 400);
      assert.equal((await call("/assistant/delegate", "POST", { ...input, workspaceId: assistant.workspace.id })).status, 400);
      const beforeBadFile = sessions.size;
      assert.equal((await call("/assistant/delegate", "POST", { ...input, files: [join(root, "outside.txt")] })).status, 403);
      assert.equal(sessions.size, beforeBadFile);
      const result = await (await call("/assistant/delegate", "POST", input)).json();
      assert.equal(result.files.length, 1);
      assert.equal(await readFile(join(project.project.path, result.files[0].path), "utf8"), "Nordstern GmbH agreement for review");
      assert.ok(deliveries[0].parts[1].text.includes(result.files[0].path));
      assert.ok(deliveries[0].parts[1].text.includes("legalwork_project_set_metadata"));
      assert.equal(result.ok, true); assert.equal(result.delegation.workspaceId, project.project.id);
      assert.equal(result.delegation.scope, input.scope); assert.equal(result.delegation.status, "started");
      assert.equal(deliveries.length, 1); assert.equal(deliveries[0].directory, project.project.path);
      assert.equal(deliveries[0].agent, "legalwork"); assert.deepEqual(deliveries[0].model, { providerID: "fixture-provider", modelID: "chosen-model" });
      assert.equal(deliveries[0].parts[0].text, input.title + "\\n\\n" + input.scope);
      assert.equal(deliveries[0].parts[1].synthetic, true);
      assert.ok(!deliveries[0].parts[0].text.includes(result.files[0].path));
      assert.deepEqual(deliveries[0].parts[0].metadata.legalworkSharedFiles, [{ name: "request.txt", path: result.files[0].path, bytes: result.files[0].bytes }]);
      assert.equal(result.delegation.conversationLanguage, "en");
      assert.ok(deliveries[0].parts[1].text.includes("Conversation language: en"));
      assert.ok(deliveries[0].parts[1].text.includes("write the memorandum in German"));
      assert.ok(deliveries[0].parts[1].text.includes("Keep requested documents in their separately specified language"));
      assert.equal((await call("/assistant/delegate", "POST", { ...input, conversationLanguage: "" })).status, 400);
      assert.deepEqual(deliveries[0].parts[0].metadata.legalworkAssistantSender, { name: "Momo", icon: "otter" });
      pendingApprovals = [{ id: "approval-1", sessionID: result.delegation.sessionId, permission: "edit", patterns: ["report.docx"], metadata: { description: "Save proposed report edits" } }];
      pendingQuestions = [{ id: "question-1", sessionID: result.delegation.sessionId, questions: [{ header: "Scope", question: "Which agreement?", options: [{ label: "A", description: "First" }], custom: true }] }];
      const attention = await (await call("/assistant/attention")).json();
      assert.equal(attention.items.length, 2); assert.deepEqual(attention.unavailable, []);
      const approval = attention.items.find(item => item.kind === "approval");
      assert.equal(approval.visible, false, "Reading a request must not show it");
      assert.deepEqual((await (await call("/assistant/attention?presented=true")).json()).items, []);
      assert.equal((await call("/assistant/attention/present", "POST", approval)).status, 400, "A card needs a user-facing explanation");
      assert.equal((await call("/assistant/attention/visibility", "POST", { ...approval, visible: true })).status, 409, "Visibility cannot promote an unpresented request");
      const presentation = { ...approval, title: "Approve report edits?", description: "Allow the project to save its proposed changes to report.docx." };
      assert.equal((await call("/assistant/attention/present", "POST", presentation)).status, 200);
      const shown = (await (await call("/assistant/attention?presented=true")).json()).items;
      assert.equal(shown.length, 1, "The unrelated question stays off the panel");
      assert.equal(shown[0].presentation.title, presentation.title);
      assert.equal(shown[0].visible, true);
      assert.equal((await call("/assistant/attention/visibility", "POST", { ...approval, visible: false })).status, 200);
      assert.equal((await call("/assistant/attention/present", "POST", presentation)).status, 200);
      const hidden = (await (await call("/assistant/attention?presented=true")).json()).items;
      assert.equal(hidden.length, 1, "Retries do not duplicate cards");
      assert.equal(hidden[0].visible, false, "Retries do not reopen hidden cards");
      assert.equal(hidden[0].presentedAt, shown[0].presentedAt);
      assert.equal(attentionReplies.length, 0, "Hiding does not approve or reject");
      assert.equal((await (await call("/assistant/attention")).json()).items.find(item => item.id === approval.id).visible, false);
      assert.equal((await call("/assistant/attention/reply", "POST", { ...approval, reply: "once", revision: "old" })).status, 409);
      assert.equal((await call("/assistant/attention/reply", "POST", { ...approval, reply: "once", workspaceId: "matter" })).status, 404);
      assert.equal((await call("/assistant/attention/reply", "POST", { ...approval, reply: "always" })).status, 400);
      assert.equal((await call("/assistant/follow-up", "POST", { workspaceId: approval.workspaceId, sessionId: approval.sessionId, prompt: "Skip this approval" })).status, 409);
      assert.equal(attentionReplies.length, 0);
      assert.equal((await call("/assistant/attention/reply", "POST", { ...approval, reply: "once" })).status, 200);
      assert.deepEqual(attentionReplies, [{ path: "/permission/approval-1/reply", body: { reply: "once" } }]);
      assert.equal((await call("/assistant/attention/reply", "POST", { ...approval, reply: "once" })).status, 409);
      assert.deepEqual((await (await call("/assistant/attention?presented=true")).json()).items, [], "Answered cards disappear");
      const queued = await (await call("/assistant/follow-up", "POST", { workspaceId: approval.workspaceId, sessionId: approval.sessionId, prompt: "Use agreement A" })).json();
      assert.equal(queued.status, "queued", "A busy session must accept a durable follow-up without interruption");
      const control = { workspaceId: approval.workspaceId, sessionId: approval.sessionId, sourceSessionId: assistant.day.sessionId };
      const pending = await (await call("/assistant/session-control", "POST", { ...control, action: "list_queue" })).json();
      assert.equal(pending.messages[0].prompt, "Use agreement A");
      assert.equal((await call("/assistant/session-control", "POST", { ...control, action: "edit_queued", messageId: queued.message.id, prompt: "Use agreement B" })).status, 200);
      assert.equal((await call("/assistant/session-control", "POST", { ...control, action: "cancel_queued", messageId: queued.message.id })).status, 200);
      assert.equal((await call("/assistant/session-control", "POST", { ...control, workspaceId: "matter", action: "stop" })).status, 404);
      // The card opens the project by activating it, then loading the running chat.
      const activated = await fetch(base + "/workspaces/" + project.project.id + "/activate", { method: "POST", headers: { "x-legalwork-host-token": "host" } });
      assert.equal(activated.status, 200);
      assert.deepEqual(disposals, [], "Opening delegated work must not reload its engine");
      const status = await (await call("/assistant/projects/" + project.project.id + "/sessions/" + result.delegation.sessionId)).json();
      assert.equal(status.status.type, "busy"); assert.equal(status.todos[0].content, "Review draft");
      assert.equal((await call("/assistant/projects/matter/sessions/" + assistant.day.sessionId)).status, 404);
      const overviewUrl = "/assistant/projects/" + project.project.id + "/overview";
      const overview = await (await call(overviewUrl)).json();
      assert.equal(overview.project.id, project.project.id);
      assert.equal(overview.tasks.items[0].title, "Review escrow"); assert.equal(overview.tasks.available, true);
      assert.equal(overview.calendar.available, true); assert.ok(overview.calendar.from < overview.today && overview.calendar.to > overview.today);
      assert.equal(overview.sessions.items.length, 1, "Never include chats from the assistant or another project");
      assert.equal(overview.sessions.items[0].status.type, "busy");
      assert.equal(overview.sessions.items[0].todos.items[0].content, "Review draft");
      assert.equal(overview.sessions.items[0].messages.items[0].text, "Draft ready; awaiting partner review.");
      assert.equal(overview.sessions.items[0].messages.items[0].messageId, "last-reply");
      assert.equal((await call(overviewUrl + "?sessionLimit=50")).status, 400);
      const unfinished = await (await call("/assistant/tasks?projectId=" + project.project.id + "&status=unfinished&sort=due")).json();
      assert.equal(unfinished.items[0].id, overview.tasks.items[0].id);
      failReads = true;
      const partial = await (await call(overviewUrl)).json();
      assert.equal(partial.tasks.available, true); assert.equal(partial.sessions.items[0].status.type, "unavailable");
      assert.equal(partial.sessions.items[0].todos.available, false);
      failReads = false;
      assert.equal((await call("/workspace/" + project.project.id + "/tasks", "POST", { title: "Earlier follow-up", projectId: project.project.id, dueDate: "2099-10-07" })).status, 201);
      const bounded = await (await call(overviewUrl + "?taskLimit=1")).json();
      assert.equal(bounded.tasks.items[0].title, "Earlier follow-up");
      const continuation = new URLSearchParams(bounded.tasks.next.arguments);
      const continued = await (await call("/assistant/tasks?" + continuation)).json();
      assert.deepEqual(continued.items.map(task => task.title), ["Review escrow"]);
      failSend = true;
      const unconfirmed = await (await call("/assistant/delegate", "POST", input)).json();
      assert.equal(unconfirmed.ok, false); assert.equal(unconfirmed.delegation.status, "delivery-unconfirmed"); assert.ok(unconfirmed.delegation.sessionId);
      failSend = false;
      running.delete(result.delegation.sessionId); finished.add(result.delegation.sessionId);
      const deadline = Date.now() + 18000;
      while (!deliveries.some(item => item.messageID) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
      const returned = deliveries.find(item => item.messageID);
      assert.ok(returned, "The background return queue must wake the source Assistant");
      assert.equal(returned.sessionId, assistant.day.sessionId);
      assert.equal(returned.agent, "legalwork"); assert.deepEqual(returned.model, { providerID: "fixture-provider", modelID: "chosen-model" });
      assert.equal(returned.parts[0].synthetic, true);
      assert.ok(returned.parts[0].text.includes("Draft ready; awaiting partner review."));
      assert.ok(!returned.parts[0].text.includes("hidden reminder"));
      const issued = await fetch(base + "/tokens", { method: "POST", headers: { "x-legalwork-host-token": "host", "content-type": "application/json" }, body: JSON.stringify({ scope: "viewer", label: "reader" }) });
      const viewer = (await issued.json()).token;
      assert.equal((await call("/assistant/attention/reply", "POST", { workspaceId: project.project.id, sessionId: result.delegation.sessionId, id: "request", revision: "revision", kind: "approval", reply: "once" }, viewer)).status, 403);
      assert.equal((await call("/assistant/recordings", "GET", undefined, viewer)).status, 200);
      assert.equal((await call("/assistant/recordings/rec-2", "DELETE", undefined, viewer)).status, 403);
      assert.equal((await call("/assistant/recorder", "POST", { action: "start" }, viewer)).status, 403);
      assert.equal((await call(overviewUrl, "GET", undefined, viewer)).status, 200);
      assert.equal((await call(overviewUrl, "GET", undefined, "wrong")).status, 401);
      assert.equal((await call("/assistant/profile", "PATCH", { name: "No", icon: "cat" }, viewer)).status, 403);
      assert.equal((await call("/assistant/history", "GET", undefined, viewer)).status, 200);
      for (const route of ["/assistant/current", "/assistant/projects", "/assistant/delegate", "/assistant/name", "/assistant/onboarding", "/assistant/onboarding/view"]) assert.equal((await call(route, "POST", input, viewer)).status, 403);
      assert.equal((await call("/assistant/session-control", "POST", { ...control, action: "stop" }, viewer)).status, 403);
      running.add(control.sessionId);
      const stopped = await (await call("/assistant/session-control", "POST", { ...control, action: "stop" })).json();
      assert.equal(stopped.stopped, true); assert.equal(running.has(control.sessionId), false);
      const redirected = await (await call("/assistant/session-control", "POST", { ...control, action: "redirect", prompt: "Review from the provider perspective only" })).json();
      assert.equal(redirected.status, "sent");
      assert.equal(deliveries.at(-1).sessionId, control.sessionId);
      assert.equal(deliveries.at(-1).parts[0].text, "Review from the provider perspective only");
      const { projectSyncStore } = await import(${JSON.stringify(new URL("./project-sync-store.ts", import.meta.url).href)});
      (await projectSyncStore(config)).saveLink({ workspaceId: project.project.id, projectId: "shared-project", orgId: "other-firm", origin: "remote", role: "member", ownerUserId: "owner",
        settings: { access: "members", memberIds: [], scope: { documents: true, notes: true, tasks: false, calendar: false, recordings: false, metadata: true, reviews: false } },
        confirmed: true, remoteUpdatedAt: null, filesReconciledAt: null, state: "active", allowDeletions: false, lastSyncAt: null, lastError: null, report: null });
      const restricted = await (await call(overviewUrl)).json();
      assert.equal(restricted.tasks.available, false); assert.equal(restricted.calendar.available, false);
      assert.equal(restricted.tasks.items, undefined); assert.equal(restricted.calendar.items, undefined);
      config.readOnly = true; assert.equal((await call("/assistant/recordings/rec-2", "DELETE")).status, 403); assert.equal((await call("/assistant/current", "POST", {})).status, 403);
      console.log("assistant HTTP checks passed");
    } finally { await server.stop(); engine.stop(true); }
  `);
  try {
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, XDG_CONFIG_HOME: root, LEGALWORK_RUNTIME_DB: join(root, "runtime.sqlite"), LEGALWORK_PROJECTS_DIR: join(root, "projects") }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, failure: exit === 0 ? "" : stdout + stderr }).toEqual({ exit: 0, failure: "" });
    expect(stdout).toContain("assistant HTTP checks passed");
  } finally { await rm(root, { force: true, recursive: true }); }
}, 30000);
