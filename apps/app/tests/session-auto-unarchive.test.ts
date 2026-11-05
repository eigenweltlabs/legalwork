import { describe, expect, test } from "bun:test";
import { sendSessionPrompt, sendSessionCommand } from "../src/app/lib/system-reminder";
import { shellInSession } from "../src/app/lib/opencode-session";
import { createClient } from "../src/app/lib/opencode";

const submissions:Record<string,(client:ReturnType<typeof createClient>)=>Promise<unknown>>={
 prompt:client=>sendSessionPrompt(client,{sessionID:"session-a",parts:[{type:"text",text:"Continue"}]}),
 synthetic:client=>sendSessionPrompt(client,{sessionID:"session-a",noReply:true,parts:[{type:"text",text:"Context",synthetic:true}]}),
 command:client=>sendSessionCommand(client,{sessionID:"session-a",command:"review",arguments:"Continue"}),
 shell:client=>shellInSession(client,"session-a","echo hello"),
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
          if (request.method === "PATCH") {
            expect(await request.json()).toEqual({ archived:false });
            archived = 0;
            return new Response(null,{status:204});
          }
          expect(archived).toBe(0);
          return ["prompt","synthetic"].includes(action) ? Response.json({data:{id:"inbox",sessionID:"session-a",type:action==="prompt" ? "user":"synthetic",payload:{text:"Continue"},delivery:"queue",time:{created:1}}}):new Response(null,{status:204});
        },
      });
      try {
        const client = createClient(server.url.origin, "/project folder", { mode: "legalwork", token: "test-token" });
        await submit(client);
        expect(requests).toEqual([
          "PATCH /api/session/session-a",
          `POST /api/session/session-a/${action}`,
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
      return Response.json({data:{ id: "session-a", time: { archived: 123 } }});
    } });
    try {
      const session = await createClient(String(server.url)).session.get({ sessionID: "session-a" });
      expect(session.time.archived).toBe(123);
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
      await expect(sendSessionPrompt(createClient(String(server.url)),{sessionID:"session-a",parts:[]})).rejects.toThrow();
      expect(requests).toEqual(["PATCH"]);
    } finally {
      server.stop(true);
    }
  });
});
