import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { CreateProjectInput } from "../../src/react-app/domains/workspace/create-project-modal";
import { BackOfficeStore } from "../../../server/src/back-office/store";
import { openSqlite } from "../../../server/src/runtime-db";

const window = new Window({ url: "http://localhost" });
window.document.write("<!doctype html><html><head></head><body></body></html>");
for (const [key, value] of Object.entries({
  window, document: window.document, navigator: window.navigator, localStorage: window.localStorage,
  HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
  Element: window.Element, Node: window.Node, Event: window.Event,
  MutationObserver: window.MutationObserver, ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
})) Object.defineProperty(globalThis, key, { value, configurable: true });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { defaultProjectTemplates } = await import("@legalwork/types/workspace");
const { createLegalworkServerClient } = await import("../../src/app/lib/legalwork-server");
const { CreateProjectModal } = await import("../../src/react-app/domains/workspace/create-project-modal");
const { useProjectDefaultsStore } = await import("../../src/react-app/domains/workspace/project-defaults-store");
const { t, setLocale } = await import("../../src/i18n");
const store = new BackOfficeStore(await openSqlite(":memory:"));
const actor = { userId: "owner", model: true, edit: true, finance: true };
const alpha = store.saveRecord("local", actor, { objectId: "matters", revision: 0, values: { name: "Alpha" } });
const beta = store.saveRecord("local", actor, { objectId: "matters", revision: 0, values: { name: "Beta" } });
store.saveRecord("local", actor, { objectId: "matters", revision: 0, archived: true, values: { name: "Archived case" } });
const catalog = { revision: 1, templates: defaultProjectTemplates(), defaultTemplateId: "legal_matter" };
let recordWrites = 0;
const client = {
  ...createLegalworkServerClient({ baseUrl: "http://localhost" }),
  getProjectTemplates: async () => catalog,
  projectFolderSources: async () => ({ sources: [] }),
  backOffice: async (path: string, options?: { body?: unknown }) => {
    if (path.startsWith("?")) return { scope: "local", directoryId: "local:fixture", model: store.model("local"),
      records: store.records("local", actor), views: [], permissions: actor, sync: { enabled: false, cursor: 0, pending: 0, error: null } };
    if (path === "/projects") return { projects: [] };
    if (path === "/records" && options?.body) { recordWrites++; return { record: store.saveRecord("local", actor, options.body) }; }
    throw new Error(`Unexpected request ${path}`);
  },
};
useProjectDefaultsStore.setState({ ...catalog, migrated: true, hasLegacyDefaults: false, serverKey: client.baseUrl });
const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const host = document.createElement("div"); document.body.append(host);
const root = createRoot(host);
const submissions: CreateProjectInput[] = [];
let closeRequests = 0;
async function render(open = true, error: string | null = null) {
  await act(async () => {
    root.render(<QueryClientProvider client={cache}><CreateProjectModal open={open} client={client} submitting={false} error={error}
      onClose={() => { closeRequests++; }} onPickFolder={async () => null} onConfirm={async input => { submissions.push(input); }} /></QueryClientProvider>);
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}
function input(label: string) {
  const element = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); assert.ok(element, `Missing input ${label}: ${document.body.textContent?.slice(-1200)}`); return element;
}
function button(text: string) {
  const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.trim() === text);
  assert.ok(element, `Missing button ${text}`); return element;
}
async function type(label: string, value: string) {
  await act(async () => {
    const element = input(label); element.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set; assert.ok(setter); setter.call(element, value);
    element.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
async function enter(label: string) {
  await act(async () => input(label).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
}
try {
  setLocale("en");
  await render();
  await type(t("projects.name"), "My project draft");
  assert.equal(button(t("projects.matters.choose")).disabled, false);
  await act(async () => button(t("projects.matters.choose")).click());
  assert.ok(!document.body.textContent?.includes("Archived case"));
  await type(t("projects.matters.search"), "Alpha");
  await act(async () => input(t("projects.matters.search")).dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
  await act(async () => input(t("projects.matters.search")).dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })));
  await enter(t("projects.matters.search"));
  assert.ok(document.querySelector('button[aria-label="Remove: Alpha"]'));
  assert.equal(input(t("projects.matters.search")).value, "Alpha");
  await type(t("projects.matters.search"), "Beta");
  await enter(t("projects.matters.search"));
  assert.ok(document.querySelector('button[aria-label="Remove: Beta"]'));
  await act(async () => input(t("projects.matters.search")).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(closeRequests, 0, "Escape closes the picker, not the project dialog");
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Remove: Alpha"]')?.click());
  await act(async () => button(t("projects.matters.choose")).click());
  await type(t("projects.matters.search"), "New case");
  await enter(t("projects.matters.search"));
  assert.equal(input("Matter name").value, "New case");
  assert.equal(button(t("projects.create")).disabled, true);
  await enter("Matter name");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.equal(recordWrites, 1);
  assert.equal(submissions.length, 0, "Nested creation must not submit the outer project form");
  assert.equal(input(t("projects.name")).value, "My project draft");
  const created = store.records("local", actor, "matters").find(record => record.values.name === "New case"); assert.ok(created);
  assert.ok(document.querySelector('button[aria-label="Remove: New case"]'));
  await act(async () => button(t("projects.create")).click());
  assert.equal(submissions.length, 1);
  assert.deepEqual(submissions[0].matters, { directoryId: "local:fixture", recordIds: [beta.id, created.id] });
  assert.equal(submissions[0].templateId, "legal_matter");
  await render(true, "Project could not be saved");
  assert.equal(input(t("projects.name")).value, "My project draft");
  assert.ok(document.querySelector('button[aria-label="Remove: New case"]'));
  await render(false);
  setLocale("de");
  await render();
  assert.equal(input(t("projects.name")).value, "");
  assert.equal(document.querySelector('button[aria-label="Remove: New case"]'), null);
  assert.ok(button("Mandate auswählen"));
  await type(t("projects.name"), "Ohne Mandat");
  await act(async () => button(t("projects.create")).click());
  assert.equal(submissions[1].matters, undefined);
  console.log("Project matter flow passed");
} finally {
  await act(async () => root.unmount());
  cache.clear(); store.close(); await window.happyDOM.close();
}
