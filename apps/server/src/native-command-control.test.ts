import { expect, test } from "bun:test";
import { OpenCode } from "@opencode/client";
import { assertManagedCommandIntegration, assertRunnableCommand, interruptEngineSession, runNativeCommand } from "./native-command-control.js";
import { ApiError } from "./errors.js";
import { nativeQueueTransport } from "./native-queue-transport.js";
import type { ServerConfig } from "./types.js";

test("Stop cancels command expansion in the saved location and still interrupts the engine when cancellation fails", async () => {
  let mode: "command" | "standalone" | "broken" | "permission" = "command";
  let interrupted = 0;
  const client = OpenCode.make({ baseUrl: "http://command-control.invalid", fetch: Object.assign(async (request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
    if (url.pathname === "/api/session/chat") return Response.json({ data: { id: "chat", location: { directory: "/saved/project" } } });
    if (url.pathname === "/api/session/chat/interrupt") { interrupted++; return Response.json({ interrupted: false }); }
    expect(url.pathname).toBe("/api/rpc/legalwork.commands/cancel");
    expect(url.searchParams.get("location[directory]")).toBe("/saved/project");
    expect(JSON.parse(String(init?.body))).toEqual({ input: { sessionID: "chat" } });
    if (mode === "command") return Response.json({ output: { cancelled: true } });
    const detail = mode === "permission" ? { _tag: "ForbiddenError", message: "Forbidden" }
      : { _tag: "RpcError", type: mode === "standalone" ? "rpc.unavailable" : "command.broken", message: "Command integration unavailable" };
    // The LegalWork transport preserves structured upstream errors in ApiError.
    throw new ApiError(502, "opencode_request_failed", "The agent engine rejected the request.", { status: 500, detail });
  }, { preconnect: fetch.preconnect }) });
  expect(await interruptEngineSession(client, "chat", { managedCommands: true })).toEqual({ interrupted: true });
  mode = "standalone";
  expect(await interruptEngineSession(client, "chat", { managedCommands: false })).toEqual({ interrupted: false });
  await expect(interruptEngineSession(client, "chat", { managedCommands: true })).rejects.toThrow();
  mode = "broken";
  await expect(interruptEngineSession(client, "chat", { managedCommands: false })).rejects.toThrow();
  mode = "permission";
  await expect(interruptEngineSession(client, "chat", { managedCommands: false })).rejects.toThrow();
  expect(interrupted).toBe(5);
});

test("shortcut admission requires the active sandbox adapter and rejects the native unsafe loader", async () => {
  let mode: "ready" | "missing" | "failed" | "unsafe" = "ready";
  const client = OpenCode.make({ baseUrl: "http://command-control.invalid", fetch: Object.assign(async (request: Parameters<typeof fetch>[0]) => {
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
    expect(url.pathname).toBe("/api/plugin");
    expect(url.searchParams.get("location[directory]")).toBe("/matter");
    return Response.json({ location: { directory: "/matter" }, data: mode === "missing" ? [] : [
      { id: "legalwork.commands", state: mode === "failed" ? { status: "failed", error: "Fixture startup failed" } : { status: "active" } },
      ...(mode === "unsafe" ? [{ id: "opencode.config.command", state: { status: "active" } }] : []),
    ] });
  }, { preconnect: fetch.preconnect }) });
  await expect(assertManagedCommandIntegration(client, { directory: "/matter" })).resolves.toBeUndefined();
  for (const value of ["missing", "failed", "unsafe"] satisfies Array<"missing" | "failed" | "unsafe">) {
    mode = value;
    await expect(assertManagedCommandIntegration(client, { directory: "/matter" })).rejects.toMatchObject({ code: "managed_commands_unavailable" });
  }
});

test("native compact is a built-in operation, while unknown configured shortcuts remain rejected", async () => {
  const paths: string[] = [];
  const client = OpenCode.make({ baseUrl: "http://command-control.invalid", fetch: Object.assign(async (request: Parameters<typeof fetch>[0]) => {
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
    paths.push(url.pathname);
    if (url.pathname === "/api/plugin") return Response.json({ location: { directory: "/matter" }, data: [{ id: "legalwork.commands", state: { status: "active" } }] });
    expect(url.pathname).toBe("/api/command");
    return Response.json({ location: { directory: "/matter" }, data: [{ id: "review", name: "review", description: "Review", source: "plugin" }] });
  }, { preconnect: fetch.preconnect }) });
  await expect(assertRunnableCommand(client, { directory: "/matter" }, "compact")).resolves.toBeUndefined();
  expect(paths).toEqual([]);
  await expect(assertRunnableCommand(client, { directory: "/matter" }, "review")).resolves.toBeUndefined();
  await expect(assertRunnableCommand(client, { directory: "/matter" }, "missing")).rejects.toMatchObject({ code: "command_not_found" });
});

test("immediate and queued compact use the native lifecycle operation; other slash commands retain full inputs", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const client = OpenCode.make({ baseUrl: "http://command-control.invalid", fetch: Object.assign(async (request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
    calls.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
    if (url.pathname.endsWith("/compact")) return Response.json({ data: { id: JSON.parse(String(init?.body)).id ?? "compaction", type: "compaction", status: "queued" } });
    return new Response(null, { status: 204 });
  }, { preconnect: fetch.preconnect }) });
  await runNativeCommand(client, { sessionID: "chat", name: "compact", text: "", delivery: "steer" });
  await runNativeCommand(client, { sessionID: "chat", name: "COMPACT", text: "", delivery: "queue" }, "msg_durable");
  const command = { sessionID: "chat", name: "review", text: "complete arguments", files: [{ uri: "file:///matter/source.txt" }], delivery: "queue" } satisfies Parameters<typeof client.session.command>[0];
  await runNativeCommand(client, command, "not-a-command-input");
  expect(calls).toEqual([
    { path: "/api/session/chat/compact", body: { delivery: "steer" } },
    { path: "/api/session/chat/compact", body: { delivery: "queue", id: "msg_durable" } },
    { path: "/api/session/chat/command", body: { name: "review", text: "complete arguments", files: command.files, delivery: "queue" } },
  ]);
});

test("queued compact retains preparation and ordered agent/model selection before native admission", async () => {
  const paths: string[] = [];
  const client = OpenCode.make({ baseUrl: "http://command-control.invalid", fetch: Object.assign(async (request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
    paths.push(url.pathname);
    if (url.pathname.endsWith("/compact")) expect(JSON.parse(String(init?.body))).toEqual({ id: "msg_00000000000040008000000000000001", delivery: "queue" });
    if (url.pathname.endsWith("/compact")) return Response.json({ data: { id: "msg_00000000000040008000000000000001" } });
    return new Response(null, { status: 204 });
  }, { preconnect: fetch.preconnect }) });
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "host", configPath: "/fixture/server.json", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  let preparationFails = false;
  const transport = nativeQueueTransport(config, { client: async () => client, prepare: async () => { paths.push("prepare"); if (preparationFails) throw Error("Permission denied"); } });
  const entry = { id: "00000000-0000-4000-8000-000000000001", status: "queued", draft: { mode: "prompt", text: "/compact", parts: [], attachments: [], editor: { mentions: {}, pasteParts: [] } }, execution: { kind: "command", command: "compact", args: "", model: { providerID: "provider", id: "model", variant: "medium" }, agent: "legalwork" } } satisfies Parameters<typeof transport.send>[2];
  expect(await transport.send("workspace", "chat", entry)).toEqual({ accepted: true });
  expect(paths).toEqual(["prepare", "/api/session/chat/agent", "/api/session/chat/model", "/api/session/chat", "/api/session/chat/compact"]);
  paths.length = 0; preparationFails = true;
  await expect(transport.send("workspace", "chat", entry)).rejects.toThrow("Permission denied");
  expect(paths).toEqual(["prepare"]);
});

test("a different pending native compaction acknowledgement cannot accept this queued input", async () => {
  const client = OpenCode.make({ baseUrl: "http://command-control.invalid", fetch: Object.assign(async () => Response.json({ data: { id: "msg_other" } }), { preconnect: fetch.preconnect }) });
  await expect(runNativeCommand(client, { sessionID: "chat", name: "compact", text: "", delivery: "queue" }, "msg_expected")).rejects.toThrow("queued compaction identity");
});

test("compaction reconciliation binds exact pending or completed IDs without replaying completed work", async () => {
  const id = "msg_00000000000040008000000000000001";
  let state: "pending" | "completed" | "wrong-type" | "wrong-id" = "pending";
  const paths: string[] = [];
  const client = OpenCode.make({ baseUrl: "http://command-control.invalid", fetch: Object.assign(async (request: Parameters<typeof fetch>[0]) => {
    const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
    paths.push(url.pathname);
    if (url.pathname.endsWith("/inbox")) return Response.json({ data: state === "pending" ? [{ id, type: "compaction" }] : [] });
    if (url.pathname === "/api/session/active") return Response.json({ data: {} });
    if (url.pathname.endsWith("/compact")) return Response.json({ data: { id } });
    expect(url.pathname).toBe(`/api/session/chat/message/${id}`);
    return Response.json({ data: { id: state === "wrong-id" ? "msg_other" : id, type: state === "wrong-type" ? "user" : "compaction" } });
  }, { preconnect: fetch.preconnect }) });
  const config: ServerConfig = { host: "127.0.0.1", port: 0, token: "fixture", hostToken: "host", configPath: "/fixture/server.json", approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false, startedAt: 0, tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false };
  const transport = nativeQueueTransport(config, { client: async () => client, prepare: async () => {} });
  const entry = { id: "00000000-0000-4000-8000-000000000001", status: "uncertain", draft: { mode: "prompt", text: "/compact", parts: [], attachments: [], editor: { mentions: {}, pasteParts: [] } }, execution: { kind: "command", command: "compact", args: "" } } satisfies Parameters<NonNullable<typeof transport.confirmed>>[2];
  expect(await transport.confirmed?.("workspace", "chat", entry)).toBe(true);
  expect(paths).toEqual(["/api/session/chat/inbox", "/api/session/active", "/api/session/chat/compact"]);
  paths.length = 0; state = "completed";
  expect(await transport.confirmed?.("workspace", "chat", entry)).toBe(true);
  expect(paths).toEqual(["/api/session/chat/inbox", `/api/session/chat/message/${id}`]);
  state = "wrong-type";
  expect(await transport.confirmed?.("workspace", "chat", entry)).toBe(false);
  state = "wrong-id";
  expect(await transport.confirmed?.("workspace", "chat", entry)).toBe(false);
});
