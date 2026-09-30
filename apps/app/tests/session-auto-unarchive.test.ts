import { describe, expect, test } from "bun:test";
import { createClient } from "../src/app/lib/opencode";

const submissions: Record<string, (client: ReturnType<typeof createClient>) => Promise<unknown>> = {
  message: client => client.session.prompt({ sessionID: "session-a", parts: [{ type: "text", text: "Continue" }] }),
  prompt_async: client => client.session.promptAsync({ sessionID: "session-a", parts: [{ type: "text", text: "Continue" }] }),
  command: client => client.session.command({ sessionID: "session-a", command: "review", arguments: "Continue" }),
  shell: client => client.session.shell({ sessionID: "session-a", agent: "build", command: "echo hello" }),
};

describe("resuming archived sessions", () => {
  for (const [action, submit] of Object.entries(submissions)) {
    test(`${action} restores the same session before adding a message`, async () => {
      let archived = 123;
      const requests: string[] = [];
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const path = new URL(request.url).pathname;
          requests.push(`${request.method} ${path}`);
          expect(request.headers.get("Authorization")).toBe("Bearer test-token");
          expect(decodeURIComponent(request.headers.get("x-opencode-directory") ?? "")).toBe("/project folder");
          if (request.method === "PATCH") {
            expect(await request.json()).toEqual({ time: { archived: 0 } });
            archived = 0;
            return Response.json({ id: "session-a", time: { archived } });
          }
          expect(archived).toBe(0);
          return Response.json({});
        },
      });
      try {
        const client = createClient(`${server.url}workspace/project-a/opencode`, "/project folder", { mode: "legalwork", token: "test-token" });
        await submit(client);
        expect(requests).toEqual([
          "PATCH /workspace/project-a/opencode/session/session-a",
          `POST /workspace/project-a/opencode/session/session-a/${action}`,
        ]);
      } finally {
        server.stop(true);
      }
    });
  }

  test("reading an archived session does not restore it", async () => {
    const requests: string[] = [];
    const server = Bun.serve({ port: 0, fetch(request) {
      requests.push(request.method);
      return Response.json({ id: "session-a", time: { archived: 123 } });
    } });
    try {
      const session = await createClient(String(server.url)).session.get({ sessionID: "session-a" });
      expect(session.data?.time.archived).toBe(123);
      expect(requests).toEqual(["GET"]);
    } finally {
      server.stop(true);
    }
  });

  test("does not submit a hidden message if restoration fails", async () => {
    const requests: string[] = [];
    const server = Bun.serve({ port: 0, fetch(request) {
      requests.push(request.method);
      return Response.json({ message: "Cannot restore session" }, { status: 403 });
    } });
    try {
      const result = await createClient(String(server.url)).session.promptAsync({ sessionID: "session-a", parts: [] });
      expect(result.error).toBeDefined();
      expect(requests).toEqual(["PATCH"]);
    } finally {
      server.stop(true);
    }
  });
});
