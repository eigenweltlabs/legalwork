import { mock } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

// These routes are not visited by the picker tests. Isolate their editor imports
// in this subprocess so Bun's Lexical module cycle cannot affect other tests.
mock.module("../../src/react-app/shell/session-route", () => ({ SessionRoute: () => null }));
mock.module("../../src/react-app/shell/settings-route", () => ({ SettingsSurface: () => null }));

const { AppProviders } = await import("../../src/react-app/shell/providers");
const { PlatformProvider, createDefaultPlatform } = await import("../../src/react-app/kernel/platform");
const { WordAddinRoot } = await import("../../src/word-addin/word-addin-root");

Object.defineProperty(globalThis, "window", { configurable: true, value: {
  location: { origin: "http://office-fixture.invalid" },
  localStorage: { getItem: () => null, setItem: () => {} },
  matchMedia: () => ({ matches: false }),
} });

const workspacesKey = ["word-addin", "workspaces"];
const project = { id: "office-project", name: "Office project fixture", path: "/office-fixture" };
const results = [];
for (const state of ["loading", "empty", "projects", "error", "sessions"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  if (state !== "loading" && state !== "error") {
    client.setQueryData(workspacesKey, { items: state === "empty" ? [] : [project] });
  }
  if (state === "error") {
    client.getQueryCache().build(client, { queryKey: workspacesKey }).setState({
      status: "error", error: new Error("Fixture server unavailable"), fetchStatus: "idle",
    });
  }
  if (state === "sessions") {
    client.setQueryData(["word-addin", "sessions", project.id], { items: [
      { id: "office-chat", title: "Office chat fixture", time: { updated: 1 } },
    ] });
  }
  const route = state === "sessions" ? `/w/${project.id}/sessions` : "/";
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <PlatformProvider value={createDefaultPlatform()}>
        <AppProviders>
          <MemoryRouter initialEntries={[route]}><WordAddinRoot /></MemoryRouter>
        </AppProviders>
      </PlatformProvider>
    </QueryClientProvider>,
  );
  results.push({ state, html });
  client.clear();
}
console.log(JSON.stringify(results));
