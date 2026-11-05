import { describe, expect, test } from "bun:test";
import { appLinkDestination, parseAppLink } from "../src/lib/app-link";
import { readFile, readdir } from "node:fs/promises";

describe("app links in help answers", () => {
  test("every app link shipped in the manual resolves to a real router destination", async () => {
    const root = new URL("../../../", import.meta.url);
    const router = await readFile(new URL("apps/app/src/react-app/shell/app-root.tsx", root), "utf8");
    const routes = [...router.matchAll(/\bpath="([^"]+)"/g)].map(match => match[1]);
    const docs = new URL("docs/user-guide/", root);
    let count = 0;
    for (const name of await readdir(docs)) {
      if (!name.endsWith(".md")) continue;
      for (const match of (await readFile(new URL(name, docs), "utf8")).matchAll(/\]\((legalwork:\/\/[^)]+)\)/g)) {
        const route = parseAppLink(match[1]);
        expect(route).not.toBeNull();
        expect(routes.some(path => path === route || path.endsWith("/*") && route?.startsWith(path.slice(0, -1)))).toBe(true);
        count++;
      }
    }
    expect(count).toBeGreaterThan(20);
  });
  test("opens the intended settings section and preserves project context", () => {
    expect(parseAppLink("legalwork://app/settings")).toBe("/settings/general");
    expect(appLinkDestination("legalwork://app/settings/extensions/mcp", "/workspace/matter-1/session/chat-2"))
      .toBe("/workspace/matter-1/settings/extensions/mcp");
    expect(appLinkDestination("legalwork://app/settings/recorder", "/home")).toBe("/settings/recorder");
    expect(appLinkDestination("legalwork://app/calendar", "/workspace/matter-1/session/chat-2")).toBe("/calendar");
  });

  test("only routes to supported app pages, with no actions or external targets", () => {
    for (const href of [
      "https://app/settings", "legalwork://other/settings", "legalwork://app.evil/settings",
      "legalwork://user@app/settings", "legalwork://app/settings/../account", "legalwork://app/settings/%2e%2e/account",
      "legalwork://app/settings?connect=outlook", "legalwork://app/settings#script", "legalwork://app/settings/reset",
      "legalwork://app/settings/ai/delete", "legalwork://app/calendar/delete", "javascript:alert(1)",
    ]) expect(parseAppLink(href)).toBeNull();
  });
});
