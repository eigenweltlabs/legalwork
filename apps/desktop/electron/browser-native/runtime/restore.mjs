// @ts-nocheck
// Generated from ../upstream/restore.ts; OpenCode v2.1.4, MIT. Run scripts/build-browser-controller.mjs.
import { Browser } from "@opencode/plugin-browser/rpc";
import { Schema } from "effect";
const Stored = Schema.Struct({
    tabs: Schema.Array(Schema.Struct({ id: Browser.TabID, url: Browser.Tab.fields.url })),
    focusedTabID: Schema.NullOr(Browser.TabID),
});
const empty = { tabs: [], focusedTabID: null };
/** Tab URLs and focus per `${server}\n${session}`, imported once from the desktop's own `opencode.browser.dat` rows. */
export function createBrowserRestoreStore(storage) {
    const from = (key) => ({ state: ["opencode.browser.dat", key] });
    const open = (key) => storage.store(`restore:${key}`, { schema: Stored, initial: empty, from: from(key) });
    const stores = new Map();
    const store = (key) => {
        const existing = stores.get(key);
        if (existing)
            return existing;
        const created = open(key);
        stores.set(key, created);
        return created;
    };
    return {
        load: (key) => store(key).value,
        save(key, state) {
            const target = store(key);
            const value = { tabs: state.tabs.map((tab) => ({ id: tab.id, url: tab.url })), focusedTabID: state.focusedTabID };
            if (JSON.stringify(target.value) !== JSON.stringify(value))
                target.set(value);
        },
        // Also drops the unimported desktop row, as the pane's own close always did.
        remove(key) {
            storage.remove(`restore:${key}`, { from: from(key) });
            stores.delete(key);
        },
    };
}
