import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserPasswordActions } from "./browser-passwords.mjs";

function fixture() {
  let url = "https://login.example.org/form", frame = url, generation = 1, kind = true, fail = false;
  const calls = [], saved = { id: "saved", origin: "https://login.example.org", password: "private-value" };
  const target = () => ({ resources: [frame], key: String(generation) });
  const page = { contents: { isDestroyed: () => false, getURL: () => url }, state: () => ({ id: "tab", generation }),
    execute: async command => {
      calls.push(command);
      if (command.inspect) return { value: target() };
      assert.equal(command.generation, generation);
      assert.deepEqual(command.target, target());
      if (command.action.type === "evaluate") return { value: { value: kind } };
      if (fail) throw new Error(saved.password);
      return { value: { unsafe: saved.password } };
    },
  };
  const matchesWebsite = (_saved, website) => ["https://login.example.org", "https://example.org", "https://auth.example.org"].includes(new URL(website).origin);
  const actions = createBrowserPasswordActions(page, async () => ({ get: async () => saved, matchesWebsite,
    list: async website => matchesWebsite(saved.origin, website) ? [{ id: saved.id }] : [] }));
  return { actions, calls, saved, set: value => { url = value.url ?? url; frame = value.frame ?? frame; kind = value.kind ?? kind; fail = value.fail ?? fail; generation = value.generation ?? generation; } };
}
test("fill resolves inside the host, preserves native target checks, returns no secret and never submits", async () => {
  const f = fixture(), signal = new AbortController().signal;
  assert.deepEqual(await f.actions.list(signal), { website: "https://login.example.org", passwords: [{ id: "saved" }] });
  const output = await f.actions.fill({ password_id: "saved", ref: "@e2" }, signal);
  assert.deepEqual(output, { filled: true, password_id: "saved" });
  assert.equal(f.calls.at(-1).action.text, f.saved.password);
  assert.equal(f.calls.filter(call => call.action.type === "fill" && !call.inspect).length, 1);
  assert.equal(JSON.stringify(output).includes(f.saved.password), false);
});
test("the main domain, login subdomains and same-website frames can use the saved password", async () => {
  const f = fixture(); f.set({ url: "https://example.org/login", frame: "https://auth.example.org/frame" });
  assert.deepEqual(await f.actions.list(new AbortController().signal), { website: "https://example.org", passwords: [{ id: "saved" }] });
  assert.deepEqual(await f.actions.fill({ password_id: "saved", ref: "@e2" }, new AbortController().signal), { filled: true, password_id: "saved" });
});
test("other websites, wrong frame websites and non-password fields fail before inserting a value", async () => {
  for (const value of [{ url: "https://evil.example.net" }, { frame: "https://evil.example.net/frame" }, { frame: "https://login.example.org:444/frame" }, { kind: false }]) {
    const f = fixture(); f.set(value);
    await assert.rejects(f.actions.fill({ password_id: "saved", ref: "@e2" }, new AbortController().signal), /could not be confirmed|does not match|different website/);
    assert.equal(f.calls.some(call => call.action.text === f.saved.password), false);
  }
});
test("navigation, cancellation and renderer errors cannot echo the password", async () => {
  const f = fixture(); f.set({ fail: true });
  await assert.rejects(f.actions.fill({ password_id: "saved", ref: "@e2" }, new AbortController().signal), error => error instanceof Error && !error.message.includes(f.saved.password));
  const stopped = fixture(), abort = new AbortController(); abort.abort();
  await assert.rejects(stopped.actions.fill({ password_id: "saved", ref: "@e2" }, abort.signal));
  assert.equal(stopped.calls.length, 0);
  const moved = fixture(), original = moved.actions;
  moved.set({ url: "about:blank" });
  assert.deepEqual(await original.list(new AbortController().signal), { website: null, passwords: [] });
});

function autofillFixture() {
  const messages = [];
  const saved = { id: "saved", label: "Work", username: "lawyer", password: "synthetic-secret", origin: "https://example.org" };
  const contents = { getURL: () => "https://example.org/login", isDestroyed: () => false, mainFrame: { detached: false, send: (...args) => messages.push(args) } };
  const tab = { view: { webContents: contents }, autofillGeneration: 1 };
  const store = { list: async () => [{ id: saved.id, label: saved.label, username: saved.username }], get: async () => saved, matchesWebsite: (origin, url) => new URL(url).origin === origin };
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const details = { document: "document", token: "field", rect: { x: 10, y: 20, width: 200, height: 30 } };
  return { messages, saved, contents, tab, store, event, details };
}

const { prepareBrowserAutofill } = await import("./browser-autofill.mjs");
test("manual suggestions contain account metadata and release values only after a matching choice", async () => {
  const f = autofillFixture();
  const suggestion = await prepareBrowserAutofill(f.tab, f.event, f.details, async () => f.store, () => true);
  assert.deepEqual(suggestion.items, [{ id: "saved", label: "Work", description: "lawyer" }]);
  assert.equal(JSON.stringify(suggestion).includes(f.saved.password), false);
  assert.equal(await suggestion.fill("unknown"), false);
  assert.equal(f.messages.length, 0);
  assert.equal(await suggestion.fill("saved"), true);
  assert.deepEqual(f.messages[0], ["legalwork:autofill:fill", { document: "document", token: "field", url: "https://example.org/login", username: "lawyer", password: "synthetic-secret" }]);
});

test("manual filling rejects hidden tabs, foreign frames, remote contexts and invalid geometry", async () => {
  for (const alter of [f => { f.event.sender = {}; }, f => { f.event.senderFrame = {}; }, f => { f.tab.nativeContext = { remote: true }; }, f => { f.details.rect.x = NaN; }]) {
    const f = autofillFixture(); alter(f);
    assert.equal(await prepareBrowserAutofill(f.tab, f.event, f.details, async () => { throw new Error("Must not read the vault"); }, () => true), null);
  }
  const f = autofillFixture();
  assert.equal(await prepareBrowserAutofill(f.tab, f.event, f.details, async () => f.store, () => false), null);
});

test("navigation during lookup or after selection and changed saved origins never fill", async () => {
  const f = autofillFixture();
  const lookup = { ...f.store, list: async () => { f.tab.autofillGeneration++; return f.store.list(); } };
  assert.equal(await prepareBrowserAutofill(f.tab, f.event, f.details, async () => lookup, () => true), null);
  for (const alter of [() => { f.tab.autofillGeneration++; }, () => { f.saved.origin = "https://other.org"; }, () => { f.contents.getURL = () => "https://other.org"; }]) {
    const suggestion = await prepareBrowserAutofill(f.tab, f.event, f.details, async () => f.store, () => true);
    alter(); assert.equal(await suggestion.fill("saved"), false);
  }
  assert.equal(f.messages.length, 0);
});

test("a navigation while the selected credential is being read invalidates the fill", async () => {
  const f = autofillFixture();
  f.store.get = async () => { f.tab.autofillGeneration++; return f.saved; };
  const suggestion = await prepareBrowserAutofill(f.tab, f.event, f.details, async () => f.store, () => true);
  assert.equal(await suggestion.fill("saved"), false);
  assert.equal(f.messages.length, 0);
});
