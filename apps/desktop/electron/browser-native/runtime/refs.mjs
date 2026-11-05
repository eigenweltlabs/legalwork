// @ts-nocheck
// Generated from ../upstream/refs.ts; OpenCode v2.1.4, MIT. Run scripts/build-browser-controller.mjs.
// Reserving in blocks keeps storage writes rare while refs stay short.
const block = 10_000;
/**
 * Element refs for every page of the pane. A composer chip or an agent's message can still name a ref from
 * before the pane's main entry reloaded, so a new pane starts past every ref the previous one could hand out.
 */
export function createRefs(reserved) {
    const state = { next: reserved.value, end: reserved.value };
    return () => {
        if (state.next >= state.end) {
            state.end = state.next + block;
            reserved.set(state.end);
        }
        return `e${++state.next}`;
    };
}
