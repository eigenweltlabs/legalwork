import { expect, test } from "bun:test";
import { chatModelKey, useSessionModelStore } from "../src/react-app/domains/session/chat/session-model-store";

test("chat models initialize from the default once, then remain isolated through close/reopen and default changes", () => {
  useSessionModelStore.setState({ selections: {} });
  const first = chatModelKey("server", "project", "one");
  const second = chatModelKey("server", "project", "two");
  const defaults = { model: { providerID: "provider", modelID: "initial" }, variant: "medium" };
  const changed = { model: { providerID: "provider", modelID: "other" }, variant: "high" };
  const store = useSessionModelStore.getState();
  store.initialize(first, defaults); store.initialize(second, defaults);
  store.select(first, changed);
  store.initialize(first, defaults); // Remount.
  store.initialize(second, changed); // App default changed.
  expect(useSessionModelStore.getState().selections[first]).toEqual(changed);
  expect(useSessionModelStore.getState().selections[second]).toEqual(defaults);
  const third = chatModelKey("server", "project", "three");
  store.initialize(third, changed);
  expect(useSessionModelStore.getState().selections[third]).toEqual(changed);
  expect(chatModelKey("another-server", "project", "one")).not.toBe(first);
  expect(chatModelKey("server", "another-project", "one")).not.toBe(first);
});
