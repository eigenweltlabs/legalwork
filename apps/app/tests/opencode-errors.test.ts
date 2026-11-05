import { expect, test } from "bun:test";
import { createClient } from "../src/app/lib/opencode";

test("native server errors display their message instead of raw JSON", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ code: "workspace_not_found", message: "Workspace not found" }, { status: 404 }) });
  try { await expect(createClient(server.url.origin).session.get({ sessionID: "missing" })).rejects.toThrow("Workspace not found"); }
  finally { server.stop(true); }
});

test("native errors retain their typed fields and successful values arrive directly", async () => {
  let failure = true;
  const info = { id: "session", title: "Direct value", location: { directory: "/fixture" } };
  const server = Bun.serve({ port: 0, fetch: () => failure
    ? Response.json({ _tag: "SessionNotFoundError", sessionID: "session", message: "Chat not found" }, { status: 404 })
    : Response.json({ data: info }) });
  const client = createClient(server.url.origin);
  try {
    await expect(client.session.get({ sessionID: "session" })).rejects.toMatchObject({ _tag: "SessionNotFoundError", sessionID: "session", message: "Chat not found" });
    failure = false;
    expect(await client.session.get({ sessionID: "session" })).toEqual(info);
  } finally { server.stop(true); }
});
