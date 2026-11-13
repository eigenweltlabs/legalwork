import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { createLegalworkServerClient } from "../src/app/lib/legalwork-server";
import { ResearchDatabasesStep } from "../src/react-app/domains/onboarding/research-databases";

test("onboarding suggests databases by country and offers custom and deferred setup", () => {
  const client = createLegalworkServerClient({ baseUrl: "http://fixture.invalid", token: "fixture", hostToken: "fixture-host" });
  const cache = new QueryClient();
  cache.setQueryData(["browser-passwords", client.baseUrl], { items: [] });
  const render = (initialCountry: string, totalSteps = 7) => renderToStaticMarkup(<QueryClientProvider client={cache}>
    <ResearchDatabasesStep client={client} workspaceId="project" initialCountry={initialCountry} totalSteps={totalSteps} onCountryChange={() => {}} onDone={() => {}} />
  </QueryClientProvider>);
  try {
    const german = render("DE");
    expect(german).toContain("beck-online"); expect(german).toContain("juris"); expect(german).not.toContain("Bloomberg Law");
    expect(german).toContain("Libra (Wolters Kluwer)"); expect(german).toContain("app.libratech.ai");
    expect(german).toContain("Add another website"); expect(german).toContain("Save logins later");
    expect(german).toContain('aria-valuenow="7"'); expect(german).toContain('aria-valuemax="7"');
    const american = render("US", 4);
    expect(american).toContain("CourtListener"); expect(american).toContain("Free account"); expect(american).toContain("Westlaw");
    expect(american).not.toContain("beck-online"); expect(american).toContain('aria-valuenow="4"');
    expect(render("")).not.toContain('role="checkbox"');
  } finally { cache.clear(); }
});

test("research setup sends only the saved vault reference and provider selection over the host API", async () => {
  const payload = { providerId: "courtlistener", country: "US", passwordId: "218d2173-2e4b-4ef2-98e6-52e0367d1d7b" };
  const calls: Array<{ path: string; body: unknown; host: string | null }> = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    calls.push({ path: new URL(request.url).pathname, body: await request.json(), host: request.headers.get("x-legalwork-host-token") });
    return Response.json({ item: { id: payload.passwordId, websites: [{ name: "CourtListener", url: "https://www.courtlistener.com/", providerId: "courtlistener" }] } });
  } });
  try {
    const client = createLegalworkServerClient({ baseUrl: server.url.origin, token: "fixture", hostToken: "fixture-host" });
    await client.configureResearchDatabase("project", payload);
    expect(calls).toEqual([{ path: "/workspace/project/research-databases", body: payload, host: "fixture-host" }]);
  } finally { server.stop(true); }
});

test("research wiki bootstrap sends the UI language with owner authorization and preserves its purpose", async () => {
  const calls: Array<{ path: string; body: unknown; host: string | null }> = [];
  const result = { created: true, wiki: { id: "218d2173-2e4b-4ef2-98e6-52e0367d1d7b", name: "Rechtliche Recherche", purpose: "legal-research" } };
  const server = Bun.serve({ port: 0, async fetch(request) {
    calls.push({ path: new URL(request.url).pathname, body: await request.json(), host: request.headers.get("x-legalwork-host-token") });
    return Response.json(result);
  } });
  try {
    const client = createLegalworkServerClient({ baseUrl: server.url.origin, token: "fixture", hostToken: "fixture-host" });
    expect(await client.ensureLegalResearchWiki("de", "DE")).toEqual(result);
    expect(calls).toEqual([{ path: "/wikis/legal-research/ensure", body: { language: "de", country: "DE" }, host: "fixture-host" }]);
  } finally { server.stop(true); }
});
