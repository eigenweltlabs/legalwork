import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";

// The desktop app keeps this window's console warnings in main.log, so a failed
// request the server never answered must show up there.
const client = createLegalworkServerClient({ baseUrl: "http://127.0.0.1:4321", token: "token" });
let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

function stubFetch(respond: () => Promise<Response>) {
  return spyOn(globalThis, "fetch").mockImplementation(Object.assign(respond, { preconnect: fetch.preconnect }));
}

test("reports a request the server never answered", async () => {
  const fetchSpy = stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
  try {
    await expect(client.scanGithubSkills("ws_1", { url: "https://github.com/owner/repo" })).rejects.toThrow("Failed to fetch");
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^\[legalwork-server\] POST http:\/\/127\.0\.0\.1:4321\/workspace\/ws_1\/github-skills\/scan failed after \d+ms:$/),
      "Failed to fetch",
    );
  } finally {
    fetchSpy.mockRestore();
  }
});

test("reports an error response with its body, without the query string", async () => {
  const body = JSON.stringify({ code: "skill_not_found", message: "Skill not found: client-update" });
  const fetchSpy = stubFetch(() => Promise.resolve(new Response(body, { status: 404 })));
  try {
    await expect(client.getSkill("ws_1", "client-update", { includeGlobal: true })).rejects.toThrow("Skill not found: client-update");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/^\[legalwork-server\] GET http:\/\/127\.0\.0\.1:4321\/workspace\/ws_1\/skills\/client-update failed after \d+ms:$/),
      404,
      body,
    );
  } finally {
    fetchSpy.mockRestore();
  }
});
