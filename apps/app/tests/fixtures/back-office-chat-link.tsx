import assert from "node:assert/strict";
import { Window } from "happy-dom";

const window = new Window({ url: "http://localhost" });
for (const [key, value] of Object.entries({
  window, document: window.document, navigator: window.navigator, location: window.location,
  HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, Event: window.Event,
  CustomEvent: window.CustomEvent, getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, key, { value, configurable: true });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { MarkdownBlock } = await import("../../src/components/markdown/markdown");
const { APP_LINK_EVENT } = await import("../../src/lib/app-link");
const { PanelTabDestinationProvider } = await import("../../src/react-app/domains/session/panel/panel-tab-destination");
const { createPanelTabStore } = await import("../../src/react-app/domains/session/panel/panel-tab-store");
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const workspaceId = "example-project";
const scope = "workspace:" + workspaceId;
const panels = createPanelTabStore();
const activeId = "3f4f4497-6245-48a1-9f44-e4e4380e2d09";
const archivedId = "1ce85b7f-03dc-40a6-967e-88c07954c249";
const active = "legalwork://app/back-office/matters?record=" + activeId;
const archived = "legalwork://app/back-office/ismsChecklist?record=" + archivedId + "&archived=true";
const settings = "legalwork://app/settings/general";
const originalLinks = [active, archived, settings].map((href, index) => `[Link ${index}](${href})`).join(" ");
const globalLinks: string[] = [];
window.addEventListener(APP_LINK_EVENT, event => {
  if (event instanceof window.CustomEvent && typeof event.detail === "string") globalLinks.push(event.detail);
});

const clickLink = async (index: number) => {
  const link = host.querySelectorAll<HTMLAnchorElement>("[data-legalwork-app-link]")[index];
  assert.ok(link, "Expected an existing app link to render in the chat");
  await act(async () => link.click());
};

try {
  await act(async () => root.render(<MemoryRouter>
    <PanelTabDestinationProvider destination={{ kind: "workspace", workspaceId }} onOpen={(tab, options) => {
      assert.equal(options?.besideChat, true);
      panels.getState().openTab(scope, tab);
    }}>
      <MarkdownBlock text={originalLinks} />
    </PanelTabDestinationProvider>
  </MemoryRouter>));
  await clickLink(0);
  assert.deepEqual(panels.getState().sessions[scope].tabs.map(tab => [tab.id, tab.type === "project-view" && tab.backOfficePath]),
    [["project-view:back-office", "/back-office/matters?record=" + activeId]]);
  await clickLink(1);
  assert.deepEqual(panels.getState().sessions[scope].tabs.map(tab => [tab.id, tab.type === "project-view" && tab.backOfficePath]),
    [["project-view:back-office", "/back-office/ismsChecklist?record=" + archivedId + "&archived=true"]]);
  await clickLink(2);
  assert.deepEqual(globalLinks, [settings]);
  await act(async () => root.render(<MemoryRouter><MarkdownBlock text={originalLinks} /></MemoryRouter>));
  await clickLink(0);
  assert.deepEqual(globalLinks, [settings, active]);
} finally {
  await act(async () => root.unmount());
  await window.happyDOM.close();
}
