import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { BackOfficeStore } from "../../../server/src/back-office/store";
import { openSqlite } from "../../../server/src/runtime-db";
import type { ProjectField } from "@legalwork/types/workspace";

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
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createLegalworkServerClient } = await import("../../src/app/lib/legalwork-server");
const { BackOfficePage } = await import("../../src/react-app/domains/back-office/back-office-page");
const { ProjectMatterClients } = await import("../../src/react-app/domains/workspace/project-matter-clients");
const { ProjectProperties } = await import("../../src/react-app/domains/workspace/project-properties");
const { projectFieldsSchema } = await import("@legalwork/types/workspace");
const { t, setLocale } = await import("../../src/i18n");
setLocale("en");
const store = new BackOfficeStore(await openSqlite(":memory:"));
const actor = { userId: "owner", model: true, edit: true, finance: true };
const abc = store.saveRecord("local", actor, { objectId: "clients", revision: 0, values: { name: "ABC GmbH" } });
const alice = store.saveRecord("local", actor, { objectId: "people", revision: 0, values: { name: "Alice" } });
const bob = store.saveRecord("local", actor, { objectId: "people", revision: 0, values: { name: "Bob" } });
let writes = 0;
const client = {
  ...createLegalworkServerClient({ baseUrl: "http://localhost" }),
  backOffice: async (path: string, options?: { body?: unknown }) => {
    if (path.startsWith("?")) return { scope: "local", directoryId: "local:fixture", model: store.model("local"), records: store.records("local", actor), views: [], permissions: actor, sync: { enabled: false, cursor: 0, pending: 0, error: null } };
    if (path === "/projects") return { projects: [] };
    if (path === "/records" && options?.body) { writes++; return { record: store.saveRecord("local", actor, options.body) }; }
    throw new Error(`Unexpected request ${path}`);
  },
};
const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const host = document.createElement("div"); document.body.append(host);
const root = createRoot(host);
const initialFields: ProjectField[] = [{ id: "client", label: "Internal note", type: "text", value: "Keep me" },
  { id: "people", label: "Witnesses", labelSource: "custom", type: "backoffice", objectId: "people", multiple: true, value: null },
  { id: "matter", label: "Matters", labelSource: "suggested", type: "backoffice", objectId: "matters", multiple: true, quickAction: true, value: null },
  { id: "lead", label: "Lead", type: "backoffice", objectId: "people", multiple: true, quickAction: true, value: null },
  { id: "direct_client", label: "Client", type: "backoffice", objectId: "clients", multiple: true, quickAction: true, value: null }];
let savedFields = initialFields, projectWrites = 0, failProjectSave = false;
function Links() {
  const [fields, setFields] = useState(initialFields);
  const save = async (next: ProjectField[]) => { if (failProjectSave) throw new Error("Please retry"); projectWrites++; savedFields = next; setFields(next); };
  return <><ProjectProperties client={client} fields={fields} onSave={async (id, value) => save(projectFieldsSchema.parse(fields.map(field => field.id === id ? { ...field, value } : field)))} />
    <ProjectMatterClients client={client} fields={fields} /></>;
}
async function render(links = false) {
  await act(async () => { root.render(<QueryClientProvider client={cache}><MemoryRouter initialEntries={["/back-office/matters"]}>{links ? <Links /> : <BackOfficePage client={client} />}</MemoryRouter></QueryClientProvider>); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
}
function input(label: string) { const element = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`); assert.ok(element, `Missing ${label}: ${document.body.textContent?.slice(-1300)}`); return element; }
function button(text: string) { const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.getAttribute("aria-label") === text || button.textContent?.trim() === text); assert.ok(element, `Missing button ${text}: ${document.body.textContent?.slice(-1300)}`); return element; }
async function click(label: string) { await act(async () => button(label).click()); }
async function type(label: string, value: string) { await act(async () => { const element = input(label); element.focus(); const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set; assert.ok(setter); setter.call(element, value); element.dispatchEvent(new window.Event("input", { bubbles: true })); }); }
async function key(label: string, key: string, metaKey = false) { await act(async () => input(label).dispatchEvent(new window.KeyboardEvent("keydown", { key, metaKey, bubbles: true, cancelable: true }))); }

try {
  await render();
  await click("Create");
  assert.equal(writes, 0, "Opening Create must not persist an Untitled record");
  await type("Matter name", "Acquisition");
  await type("File number", "2026/042");
  await click("Edit Clients");
  await type("Search Clients…", "ABC");
  await key("Search Clients…", "Enter");
  await key("Search Clients…", "Escape");
  await key("File number", "Enter", true);
  assert.equal(writes, 1);
  const matter = store.records("local", actor, "matters").find(record => record.values.name === "Acquisition"); assert.ok(matter);
  assert.deepEqual(matter.values.clients, [abc.id]);
  assert.equal(matter.values.fileNumber, "2026/042");

  await render(true);
  assert.ok(document.body.textContent?.includes("Witnesses"), "Intentional empty roles remain visible on Home");
  assert.ok(!document.body.textContent?.includes("Not set"));
  await click("Add Matter");
  await type("Search Matters…", "ABC 042");
  assert.ok(document.body.textContent?.includes("ABC GmbH · Ref. 2026/042"));
  await key("Search Matters…", "Enter");
  await key("Search Matters…", "Enter", true);
  assert.equal(projectWrites, 1);
  assert.equal(savedFields[0].value, "Keep me");
  assert.ok(document.body.textContent?.includes("Clients from linked matters"));
  assert.ok(document.body.textContent?.includes("via Acquisition"));
  assert.equal(savedFields.filter(field => field.type === "backoffice" && field.objectId === "clients" && field.value !== null).length, 0, "Inherited clients are displayed, not copied into project data");
  await click("Add Lead");
  await type("Search Lead…", "Alice");
  await key("Search Lead…", "Enter");
  await key("Search Lead…", "Enter", true);
  assert.equal(savedFields.find(field => field.id === "people")?.value, null, "Named role remains unchanged");
  assert.deepEqual(savedFields.find(field => field.id === "lead")?.value, { directoryId: "local:fixture", recordIds: [alice.id] });
  await click("Add Client");
  await type("Search Client…", "New client");
  await key("Search Client…", "Enter");
  assert.ok(![...document.querySelectorAll("button")].some(item => item.textContent?.trim() === t("projects.save")), "Outer action is hidden during nested creation");
  await key("Client name", "Enter", true);
  assert.equal(writes, 2);
  await key("Search Client…", "Enter", true);
  assert.equal(savedFields[0].value, "Keep me");
  assert.equal(savedFields.find(field => field.id === "direct_client")?.type, "backoffice");
  await click("Edit Client: New client");
  await type("Search Client…", "ABC"); await key("Search Client…", "Enter");
  await key("Search Client…", "Enter", true);
  assert.ok(!document.body.textContent?.includes("Clients from linked matters"), "Directly linked clients do not get a duplicate inherited section");

  await click(t("projects.edit_value", { name: "Witnesses" }));
  await type("Search Witnesses…", "Alice"); await key("Search Witnesses…", "Enter");
  await type("Search Witnesses…", "Bob"); await key("Search Witnesses…", "Enter");
  await key("Search Witnesses…", "Enter", true);
  assert.deepEqual(savedFields.find(field => field.id === "people")?.value, { directoryId: "local:fixture", recordIds: [alice.id, bob.id] });
  failProjectSave = true;
  await click(t("projects.remove_reference", { name: "Alice", field: "Witnesses" }));
  assert.ok(document.querySelector('[role="alert"]')?.textContent?.includes(t("projects.failed")));
  assert.deepEqual(savedFields.find(field => field.id === "people")?.value, { directoryId: "local:fixture", recordIds: [alice.id, bob.id] }, "Failed unlink retains both references");
  failProjectSave = false;
  await click(t("projects.remove_reference", { name: "Alice", field: "Witnesses" }));
  assert.deepEqual(savedFields.find(field => field.id === "people")?.value, { directoryId: "local:fixture", recordIds: [bob.id] }, "Each remove button unlinks only its own record");
  assert.deepEqual(savedFields.find(field => field.id === "lead")?.value, { directoryId: "local:fixture", recordIds: [alice.id] }, "Unlinking a role leaves independent references intact");
  await click(t("projects.remove_reference", { name: "Bob", field: "Witnesses" }));
  assert.ok(document.body.textContent?.includes("Witnesses"), "Clearing an intentional role keeps it visible for reuse");
  assert.equal(savedFields.find(field => field.id === "people")?.value, null, "The field definition remains");
  assert.ok(store.records("local", actor, "people").some(record => record.id === bob.id), "Unlinking does not delete the Back Office record");
  await click(t("projects.remove_reference", { name: "ABC GmbH", field: "Client" }));
  assert.ok(document.body.textContent?.includes("Clients from linked matters"), "Removing the direct link reveals the remaining matter relationship");

  const model = store.model("local"), object = model.objects.find(object => object.id === "matters"); assert.ok(object);
  store.saveModel("local", actor, { ...model, objects: model.objects.map(item => item.id === "matters" ? { ...item, quickCreateFields: ["subject"] } : item) }, model.revision);
  await act(async () => cache.invalidateQueries({ queryKey: ["back-office", client.baseUrl] }));
  await render(); await click("Create");
  assert.ok(input("Matter name")); assert.ok(input("Subject"));
  assert.equal(document.querySelector('input[aria-label="File number"]'), null, "Shared quick-form configuration applies to the normal Back Office Create button");
  await click("More details"); assert.ok(input("File number"));
  assert.equal(writes, 2, "Opening or configuring forms does not create records");
  console.log("Simple Back Office flow passed");
} finally { await act(async () => root.unmount()); cache.clear(); store.close(); await window.happyDOM.close(); }
