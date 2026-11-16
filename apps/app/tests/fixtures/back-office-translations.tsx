import assert from "node:assert/strict";
import { Window } from "happy-dom";
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
const { MemoryRouter } = await import("react-router-dom");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { createLegalworkServerClient } = await import("../../src/app/lib/legalwork-server");
const { BackOfficePage } = await import("../../src/react-app/domains/back-office/back-office-page");
const { setLocale } = await import("../../src/i18n");
const { BackOfficeModelSchema } = await import("@legalwork/types/back-office");
const store = new BackOfficeStore(await openSqlite(":memory:"));
const actor = { userId: "owner", model: true, edit: true, finance: true };
const model = store.model("local");
model.objects[0].label = "Akte";
model.objects[0].plural = "Akten";
model.objects[0].fields.find(field => field.id === "fileNumber")!.label = "Aktenzeichen";
const original = structuredClone(model);
let writes = 0;
let modelWrites = 0;
const client = {
  ...createLegalworkServerClient({ baseUrl: "http://localhost" }),
  backOffice: async (path: string, options?: { body?: unknown }) => {
    if (path.startsWith("?")) return { scope: "local", directoryId: "local:translations", model, records: store.records("local", actor), views: [], permissions: actor, sync: { enabled: false, cursor: 0, pending: 0, error: null } };
    if (path === "/projects") return { projects: [] };
    if (path === "/records") { writes++; return { record: store.saveRecord("local", actor, options?.body) }; }
    if (path === "/model/preview") return { valid: true, changes: [], errors: [] };
    if (path === "/model") {
      const saved = BackOfficeModelSchema.parse(Reflect.get(Object(options?.body), "model"));
      assert.equal(saved.objects[0].label, original.objects[0].label);
      assert.equal(saved.objects[0].plural, original.objects[0].plural);
      assert.deepEqual(saved.objects[0].fields, original.objects[0].fields);
      modelWrites++;
      return {};
    }
    throw new Error(`Unexpected request ${path}`);
  },
};
const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const host = document.createElement("div"); document.body.append(host);
const root = createRoot(host);
function button(label: string) {
  const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent?.trim() === label || item.getAttribute("aria-label") === label);
  assert.ok(element, `Missing ${label}: ${document.body.textContent?.slice(-1800)}`);
  return element;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function language(locale: "en" | "de") { await act(async () => setLocale(locale)); }
try {
  setLocale("en");
  await act(async () => root.render(<QueryClientProvider client={cache}><MemoryRouter initialEntries={["/back-office/matters"]}><BackOfficePage client={client} /></MemoryRouter></QueryClientProvider>));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  button("Create Matter");
  assert.ok(document.body.textContent?.includes("File number"));
  assert.ok(!document.body.textContent?.includes("Create Akte"));
  await language("de");
  button("Akte erstellen");
  button("Sortieren");
  assert.ok(document.body.textContent?.includes("Aktenzeichen"));
  assert.ok(document.body.textContent?.includes("Mandanten"));
  assert.ok(!document.body.textContent?.includes("File number"));
  await click("Erstellen");
  assert.ok(document.querySelector('input[aria-label="Name: Akte"]'));
  assert.ok(document.querySelector("aside")?.textContent?.includes("Erstellt am"));
  assert.ok(document.querySelector("aside")?.textContent?.includes("Zuletzt aktualisiert"));
  await click("Status bearbeiten");
  button("Aktiv");
  await click("Abgeschlossen");
  assert.equal(store.records("local", actor, "matters")[0].values.status, "Closed");
  await language("en");
  assert.ok(document.querySelector('input[aria-label="Matter name"]'));
  assert.ok(document.querySelector("aside")?.textContent?.includes("Closed"));
  assert.ok(document.body.textContent?.includes("File number"));
  assert.deepEqual(model, original, "Language changes and record edits preserve the original schema");
  assert.equal(writes, 2, "Only creating the record and changing its status write data");
  await click("Data model");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const objectButton = [...document.querySelectorAll<HTMLButtonElement>(".bo-model .bo-field-list button")].find(item => item.textContent?.includes("Matters"));
  assert.ok(objectButton, document.body.textContent?.slice(-1800));
  await act(async () => objectButton.click());
  await language("de");
  assert.ok(document.querySelector(".bo-model")?.textContent?.includes("Aktenzeichen"));
  await click("Einstellungen");
  const form = document.querySelector<HTMLFormElement>(".bo-model form.bo-form");
  assert.ok(form);
  assert.deepEqual([...form.querySelectorAll<HTMLInputElement>('input:not([type="checkbox"])')].map(input => input.value), ["Akte", "Akten"]);
  await act(async () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(modelWrites, 1, "Saving unrelated settings preserves the stored model names and field labels");
  console.log("Bilingual matter flow passed");
} finally {
  await act(async () => root.unmount());
  cache.clear();
  window.happyDOM.abort();
}
