import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { FormInfo } from "@opencode/client";
import { browserPasswordRequest } from "@legalwork/types/browser-password-request";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { NativeFormPanel } from "../src/react-app/domains/session/modals/native-form-panel";
import { replyToQuestion, questionWithReceivedAt } from "../src/react-app/domains/session/sync/interaction-state";
import { createClient } from "../src/app/lib/opencode";

const request = { website: "https://login.example.org", label: "Example", username: "lawyer" };
const form: FormInfo = { id: "form_login", sessionID: "chat", title: "Save a login", metadata: { legalworkBrowserPassword: request },
  fields: [{ key: "password_id", type: "string", hidden: true }, { key: "cancelled", type: "boolean", hidden: true, default: false }] };
const id = "218d2173-2e4b-4ef2-98e6-52e0367d1d7b";

test("the inline card has a masked password field and locked website, and a restored saved login needs no re-entry", () => {
  const client = createLegalworkServerClient({ baseUrl: "http://fixture.invalid", token: "fixture", hostToken: "fixture-host" });
  const cache = new QueryClient();
  const render = () => renderToStaticMarkup(<QueryClientProvider client={cache}>
    <NativeFormPanel form={form} client={client} busy={false} onReply={() => {}} />
  </QueryClientProvider>);
  try {
    cache.setQueryData(["browser-passwords", client.baseUrl, request.website], { items: [] });
    const html = render();
    expect(html).toContain("Sign-in details needed"); expect(html).toContain(request.website);
    expect(html).toContain('type="password"'); expect(html).toContain("Save login and resume task");
    expect(html).not.toContain('type="url"'); expect(html).not.toContain('name="password_id"');
    cache.setQueryData(["browser-passwords", client.baseUrl, request.website], { items: [{ ...request, id, origin: request.website, updatedAt: "2026-10-27" }] });
    const restored = render();
    expect(restored).toContain("Resume task with saved login"); expect(restored).not.toContain('type="password"');
  } finally { cache.clear(); }
});

test("native answer serialization sends only saved ID/cancellation, while the existing host API owns password storage", async () => {
  const secret = "synthetic-inline-only", calls: Array<{ path: string; body: unknown; host: string | null }> = [];
  const server = Bun.serve({ port: 0, async fetch(httpRequest) {
    const path = new URL(httpRequest.url).pathname;
    calls.push({ path, body: await httpRequest.json(), host: httpRequest.headers.get("x-legalwork-host-token") });
    if (path === "/browser-passwords") return Response.json({ item: { id, label: request.label, username: request.username, origin: request.website, updatedAt: "2026-10-27" } });
    return new Response(null, { status: 204 });
  } });
  try {
    const host = createLegalworkServerClient({ baseUrl: server.url.origin, token: "fixture", hostToken: "fixture-host" });
    const engine = createClient(server.url.origin);
    const saved = await host.saveBrowserPassword({ label: request.label, origin: request.website, username: request.username, password: secret });
    await replyToQuestion(engine, questionWithReceivedAt(form, Date.now()), [[saved.item.id], ["false"]], "/fixture");
    await replyToQuestion(engine, questionWithReceivedAt({ ...form, id: "form_cancel" }, Date.now()), [[""], ["true"]], "/fixture");
    expect(calls[0]).toMatchObject({ path: "/browser-passwords", host: "fixture-host", body: { password: secret } });
    expect(calls[1]?.body).toEqual({ answer: { password_id: id, cancelled: false } });
    expect(calls[2]?.body).toEqual({ answer: { password_id: "", cancelled: true } });
    expect(JSON.stringify(calls.slice(1))).not.toContain(secret);
  } finally { server.stop(true); }
});

test("credential-card metadata accepts only canonical secure website origins and metadata fields", () => {
  expect(browserPasswordRequest({ legalworkBrowserPassword: request })).toEqual(request);
  const embeddedCredentials = new URL(request.website);
  embeddedCredentials.username = "fixture"; embeddedCredentials.password = "synthetic";
  for (const website of ["", "not a URL", "http://example.org", embeddedCredentials.href, "https://example.org/path", "file:///private"]) {
    expect(browserPasswordRequest({ legalworkBrowserPassword: { ...request, website } })).toBeNull();
  }
  expect(browserPasswordRequest({ legalworkBrowserPassword: { ...request, password: "must-not-enter-metadata" } })).toBeNull();
});
