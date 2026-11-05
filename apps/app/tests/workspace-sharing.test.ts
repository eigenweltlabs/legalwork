import { expect, test } from "bun:test";
import { readLegalworkServerSettings, writeLegalworkServerSettings } from "../src/app/lib/legalwork-server";

test("retired desktop sharing stays disabled when old preferences request remote access", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const stored = new Map([["legalwork.server.remoteAccessEnabled", "1"]]);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    } },
  });
  try {
    expect(readLegalworkServerSettings().remoteAccessEnabled).toBe(false);
    expect(writeLegalworkServerSettings({ remoteAccessEnabled: true }).remoteAccessEnabled).toBe(false);
    expect(stored.has("legalwork.server.remoteAccessEnabled")).toBe(false);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
