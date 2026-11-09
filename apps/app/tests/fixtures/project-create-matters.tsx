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
const { BackOfficeFieldSchema } = await import("@legalwork/types/back-office");
const { createLegalworkServerClient } = await import("../../src/app/lib/legalwork-server");
const { CreateProjectModal } = await import("../../src/react-app/domains/workspace/create-project-modal");
const { useProjectDefaultsStore } = await import("../../src/react-app/domains/workspace/project-defaults-store");
const { t, setLocale } = await import("../../src/i18n");
const store = new BackOfficeStore(await openSqlite(":memory:"));
const actor = { userId: "owner", model: true, edit: true, finance: true };
const model = store.model("local");
store.saveModel("local", actor, { ...model, objects: model.objects.map(object => object.id === "matters" ? {
  ...object, fields: [...object.fields, BackOfficeFieldSchema.parse({ id: "requiredDetail", label: "Required detail", type: "text", required: true })],
} : object) }, model.revision);
const abc = store.saveRecord("local", actor, { objectId: "clients", revision: 0, values: { name: "ABC GmbH" } });
const alpha = store.saveRecord("local", actor, { objectId: "matters", revision: 0, values: { name: "Alpha", clients: [abc.id], fileNumber: "2026/042", requiredDetail: "Legal" } });
const beta = store.saveRecord("local", actor, { objectId: "matters", revision: 0, values: { name: "Beta", requiredDetail: "Legal" } });
store.saveRecord("local", actor, { objectId: "matters", revision: 0, archived: true, values: { name: "Archived case", requiredDetail: "Legal" } });
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
async function enter(label: string, modifier?: "metaKey" | "ctrlKey") {
  await act(async () => input(label).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...(modifier ? { [modifier]: true } : {}) })));
}
try {
  setLocale("en");
  await render();
  await type(t("projects.name"), "My project draft");
  assert.equal(button(t("projects.matters.choose")).disabled, false);
  await act(async () => button(t("projects.matters.choose")).click());
  assert.ok(!document.body.textContent?.includes("Archived case"));
  await type(t("projects.matters.search"), "ABC");
  assert.ok(document.body.textContent?.includes("ABC GmbH · Ref. 2026/042"));
  await act(async () => input(t("projects.matters.search")).dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
  await act(async () => input(t("projects.matters.search")).dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })));
  await enter(t("projects.matters.search"));
  assert.ok(document.querySelector('button[aria-label="Remove: Alpha"]'));
  assert.equal(input(t("projects.matters.search")).value, "ABC");
  await type(t("projects.matters.search"), "Beta");
  await enter(t("projects.matters.search"));
  assert.ok(document.querySelector('button[aria-label="Remove: Beta"]'));
  await act(async () => input(t("projects.matters.search")).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(closeRequests, 0, "Escape closes the picker, not the project dialog");
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Remove: Alpha"]')?.click());
  await act(async () => button(t("projects.matters.choose")).click());
  assert.ok(document.querySelector('[role="option"]')?.textContent?.includes("Beta"), "Recently selected matter precedes alphabetical matches on reopening");
  await type(t("projects.matters.search"), "New case");
  await enter(t("projects.matters.search"));
  assert.equal(input("Matter name").value, "New case");
  assert.equal(button(t("projects.create")).disabled, true);
  assert.ok(input("File number"));
  assert.ok(input("Required detail"), "Custom required fields remain visible");
  assert.ok(button(t("back_office.create.more_details")));
  assert.ok(!document.querySelector('button[aria-label="Edit Status"]'), "Optional fields start collapsed");
  assert.ok(document.body.textContent?.includes(t("projects.matters.saved_separately")));
  await enter("Matter name");
  assert.equal(recordWrites, 0, "Plain Enter must not create a partially completed matter");
  await enter("Matter name", "metaKey");
  assert.equal(recordWrites, 0, "Required custom fields prevent saving");
  await type("Required detail", "Litigation");
  await type("File number", "2026/043");
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Edit Clients"]')?.click());
  await type(t("back_office.create.search", { name: "Clients" }), "ABC");
  await enter(t("back_office.create.search", { name: "Clients" }));
  assert.ok(document.querySelector('button[aria-label="Remove: ABC GmbH"]'), "Client selection applies immediately without an Apply step");
  await act(async () => input(t("back_office.create.search", { name: "Clients" })).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(closeRequests, 0, "Escape in the nested picker must not close the project");
  assert.equal(input("Matter name").value, "New case");
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Edit Clients"]')?.click());
  await type(t("back_office.create.search", { name: "Clients" }), "New client");
  await enter(t("back_office.create.search", { name: "Clients" }));
  assert.equal(input("Client name").value, "New client");
  await enter("Client name", "ctrlKey");
  assert.equal(recordWrites, 1, "Nested shortcut creates only the client");
  assert.equal(store.records("local", actor, "matters").some(record => record.values.name === "New case"), false);
  assert.equal(input("Matter name").value, "New case");
  assert.equal(input("File number").value, "2026/043");
  await act(async () => button(t("back_office.create.more_details")).click());
  assert.ok(document.querySelector('button[aria-label="Edit Status"]'), "More details reveals optional fields");
  await type("Subject", "Keep this optional description");
  await act(async () => input("File number").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", metaKey: true, repeat: true, bubbles: true, cancelable: true })));
  assert.equal(recordWrites, 1, "Holding the creation shortcut must not create duplicate records");
  await enter("File number", "metaKey");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  assert.equal(recordWrites, 2);
  assert.equal(submissions.length, 0, "Nested creation must not submit the outer project form");
  assert.equal(input(t("projects.name")).value, "My project draft");
  const created = store.records("local", actor, "matters").find(record => record.values.name === "New case"); assert.ok(created);
  const newClient = store.records("local", actor, "clients").find(record => record.values.name === "New client"); assert.ok(newClient);
  assert.deepEqual(created.values.clients, [abc.id, newClient.id]);
  assert.equal(created.values.requiredDetail, "Litigation");
  assert.equal(created.values.fileNumber, "2026/043");
  assert.equal(created.values.subject, "Keep this optional description");
  assert.ok(document.querySelector('button[aria-label="Remove: New case"]'));
  await act(async () => button(t("projects.create")).click());
  assert.equal(submissions.length, 1);
  assert.deepEqual(submissions[0].matters, { directoryId: "local:fixture", recordIds: [beta.id, created.id] });
  assert.equal(submissions[0].templateId, "legal_matter");
  await render(true, "Project could not be saved");
  assert.equal(input(t("projects.name")).value, "My project draft");
  assert.ok(document.querySelector('button[aria-label="Remove: New case"]'));
  await render(false);
  assert.ok(store.records("local", actor, "matters").some(record => record.id === created.id), "Created matters survive closing the project draft");
  setLocale("de");
  await render();
  assert.equal(input(t("projects.name")).value, "");
  assert.equal(document.querySelector('button[aria-label="Remove: New case"]'), null);
  assert.ok(button("Mandate auswählen"));
  await act(async () => button(t("projects.matters.choose")).click());
  assert.ok(document.querySelector('[role="option"]')?.textContent?.includes("New case"), "Recents survive reopening the project dialog");
  await type(t("projects.matters.search"), "ABC 2026/043");
  assert.ok(document.body.textContent?.includes("ABC GmbH, New client · AZ 2026/043"));
  await act(async () => input(t("projects.matters.search")).dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await type(t("projects.name"), "Ohne Mandat");
  await act(async () => button(t("projects.create")).click());
  assert.equal(submissions[1].matters, undefined);
  console.log("Project matter flow passed");
} finally {
  await act(async () => root.unmount());
  cache.clear(); store.close(); await window.happyDOM.close();
}
