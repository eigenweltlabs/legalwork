import { expect, test } from "bun:test";
import { deriveSessionRenderModel } from "../src/react-app/domains/session/sync/transition-controller";

const loaded = { intendedSessionId: "chat", renderedSessionId: "chat", hasSnapshot: true, isFetching: false, isError: false };

test("background refreshes and their errors keep a loaded same-chat composer usable", () => {
  for (const isFetching of [false, true]) for (const isError of [false, true]) {
    expect(deriveSessionRenderModel({ ...loaded, isFetching, isError })).toEqual({
      intendedSessionId: "chat", renderedSessionId: "chat", transitionState: "idle", renderSource: isError ? "cache" : "live",
    });
  }
});

test("initial loading and real navigation still hold the composer", () => {
  expect(deriveSessionRenderModel({ ...loaded, renderedSessionId: null, hasSnapshot: false, isFetching: true }).transitionState).toBe("switching");
  expect(deriveSessionRenderModel({ ...loaded, renderedSessionId: null, hasSnapshot: false, isError: true }).transitionState).toBe("failed");
  expect(deriveSessionRenderModel({ ...loaded, renderedSessionId: "previous" }).transitionState).toBe("switching");
  expect(deriveSessionRenderModel({ ...loaded, renderedSessionId: "previous", isError: true }).transitionState).toBe("recovering");
});

test("cached chat data does not bypass revoked access, deletion or a recovery hold", () => {
  for (const errorStatus of [401, 403, 404, 409]) expect(deriveSessionRenderModel({ ...loaded, isError: true, errorStatus }).transitionState).toBe("failed");
  expect(deriveSessionRenderModel({ ...loaded, isError: true, errorStatus: 503 }).transitionState).toBe("idle");
});
