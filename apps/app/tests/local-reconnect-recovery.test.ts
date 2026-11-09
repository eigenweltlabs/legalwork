import { expect, test } from "bun:test";
import { createLocalReconnectRecovery } from "../src/react-app/shell/local-reconnect-recovery";

test("failed recovery exposes the real reason and a successful retry clears it", async () => {
  let offline = true;
  const recovery = createLocalReconnectRecovery(async () => {
    if (offline) throw new Error("Local service did not report a base URL.");
  });
  await recovery.getState().retry();
  expect(recovery.getState().error).toBe("Local service did not report a base URL.");
  expect(recovery.getState().pending).toBe(false);
  offline = false;
  await recovery.getState().retry();
  expect(recovery.getState().error).toBeNull();
  expect(recovery.getState().pending).toBe(false);
});

test("repeated clicks share the same attempt and retain failure details while retrying", async () => {
  let finish = () => {};
  let calls = 0;
  const recovery = createLocalReconnectRecovery(async () => {
    calls++;
    if (calls === 1) throw new Error("Connection refused");
    await new Promise<void>(resolve => { finish = resolve; });
  });
  await recovery.getState().retry();
  const attempt = recovery.getState().retry();
  expect(recovery.getState().retry()).toBe(attempt);
  expect(recovery.getState().pending).toBe(true);
  expect(recovery.getState().error).toBe("Connection refused");
  await Promise.resolve();
  expect(calls).toBe(2);
  finish();
  await attempt;
  expect(recovery.getState().error).toBeNull();
});
