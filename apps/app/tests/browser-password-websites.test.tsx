import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createLegalworkServerClient, type LegalworkBrowserPassword } from "../src/app/lib/legalwork-server";
import { BrowserPasswordWebsites } from "../src/react-app/domains/settings/pages/browser-password-websites";

const connection: LegalworkBrowserPassword = {
  id: "218d2173-2e4b-4ef2-98e6-52e0367d1d7b", label: "Lexis", username: "fixture-user",
  origin: "https://360.lexisnexis.at", additionalOrigins: ["https://signin.lexisnexis.com"], updatedAt: "2026-11-03",
  websites: [{ name: "Lexis 360", url: "https://360.lexisnexis.at/", providerId: "lexis360-at", country: "AT" }],
};
const render = (saved = connection, canApprove = true) => {
  const client = createLegalworkServerClient({ baseUrl: "http://fixture.invalid", token: "fixture", ...(canApprove ? { hostToken: "fixture-host" } : {}) });
  return renderToStaticMarkup(<BrowserPasswordWebsites client={client} connection={saved} onBusyChange={() => {}} onSaved={() => {}} />);
};

test("saved login management separates navigation destinations from fill permissions without asking for the password", () => {
  const html = render();
  expect(html).toContain("Websites to open");
  expect(html).toContain("Sign-in websites");
  expect(html).toContain('aria-label="Remove starting page https://360.lexisnexis.at/"');
  expect(html).toContain('aria-label="Remove sign-in website https://signin.lexisnexis.com"');
  expect(html).not.toContain('aria-label="Remove sign-in website https://360.lexisnexis.at"');
  expect(html).toContain("Add URL");
  expect(html).toContain("Add sign-in URL");
  expect(html).not.toContain('type="password"');
});

test("old server metadata still renders and a non-owner cannot edit URL permissions", () => {
  const { additionalOrigins, ...legacy } = connection;
  expect(render(legacy)).toContain("Add URL");
  expect(render(connection, false)).toMatch(/<fieldset[^>]*disabled=""/);
});

test("adding and revoking a sign-in origin use host-authorized metadata calls without password contents", async () => {
  const calls: Array<{ method: string; path: string; query: string; host: string | null; body: unknown }> = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    calls.push({ method: request.method, path: url.pathname, query: url.search, host: request.headers.get("x-legalwork-host-token"), body: request.method === "POST" ? await request.json() : null });
    return Response.json({ item: connection });
  } });
  try {
    const client = createLegalworkServerClient({ baseUrl: server.url.origin, token: "fixture", hostToken: "fixture-host" });
    await client.addBrowserPasswordWebsite(connection.id, { loginUrl: "https://signin.lexisnexis.com" });
    await client.removeBrowserPasswordWebsite(connection.id, { loginUrl: "https://signin.lexisnexis.com" });
    expect(calls[0]).toMatchObject({ method: "POST", path: `/browser-passwords/${connection.id}/websites`, host: "fixture-host", body: { loginUrl: "https://signin.lexisnexis.com" } });
    expect(calls[0]?.body).not.toHaveProperty("url");
    expect(calls[1]).toMatchObject({ method: "DELETE", path: `/browser-passwords/${connection.id}/websites`, host: "fixture-host", body: null });
    expect(new URLSearchParams(calls[1]?.query).get("loginUrl")).toBe("https://signin.lexisnexis.com");
    expect(calls[0]?.body).not.toHaveProperty("password");
  } finally { server.stop(true); }
});
