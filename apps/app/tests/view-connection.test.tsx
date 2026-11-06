import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createLegalworkServerClient, type LegalworkServerClient } from "../src/app/lib/legalwork-server";
import { ViewPanel } from "../src/react-app/domains/views/view-panel";
import { viewPanelTab } from "../src/react-app/domains/views/view-reference";

const tab = viewPanelTab("http://127.0.0.1:4001", { owner: { kind: "workspace", id: "project" }, viewId: "00000000-0000-4000-8000-000000000001" }, "Dashboard");
function render(client: LegalworkServerClient | null) {
  const cache = new QueryClient();
  try {
    return renderToStaticMarkup(<QueryClientProvider client={cache}><ViewPanel client={client} tab={tab} sessionId="project" /></QueryClientProvider>);
  } finally { cache.clear(); }
}

test("a restored dashboard shows loading while its connection initializes, not a red connection error", () => {
  const html = render(null);
  expect(html).toContain('role="status"');
  expect(html).toContain("Loading view");
  expect(html).not.toContain("Connect to view this report");
  expect(html).not.toContain("lw-saved-view-error");
});

test("a dashboard from a different server gives a recovery instruction instead of querying that server or loading forever", () => {
  const html = render(createLegalworkServerClient({ baseUrl: "https://another.example" }));
  expect(html).toContain("Open this dashboard or report from its project or wiki to reconnect.");
  expect(html).not.toContain('role="status"');
  expect(html).not.toContain("lw-saved-view-error");
});
