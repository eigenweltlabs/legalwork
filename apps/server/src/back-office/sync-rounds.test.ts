import { expect, test } from "bun:test";
import { BackOfficeSyncRounds } from "./sync-rounds.js";

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("a request while an older snapshot is in flight waits for the follow-up snapshot", async () => {
  const rounds = new BackOfficeSyncRounds();
  const firstStarted = gate(),
    firstResponse = gate(),
    followUpStarted = gate(),
    followUpResponse = gate();
  let count = 0,
    settled = false;
  const action = async () => {
    if (++count === 1) {
      firstStarted.release();
      await firstResponse.promise;
    } else {
      followUpStarted.release();
      await followUpResponse.promise;
    }
  };
  const first = rounds.run("firm", action);
  await firstStarted.promise;
  const second = rounds.run("firm", action);
  const third = rounds.run("firm", action);
  void second.then(() => {
    settled = true;
  });
  firstResponse.release();
  await followUpStarted.promise;
  expect(settled).toBe(false);
  expect(count).toBe(2);
  followUpResponse.release();
  await Promise.all([first, second, third]);
  expect(settled).toBe(true);
  expect(count).toBe(2);
});

test("a failed round releases its slot and does not silently retry", async () => {
  const rounds = new BackOfficeSyncRounds();
  let calls = 0;
  await expect(
    rounds.run("firm", async () => {
      calls++;
      throw new Error("Offline");
    }),
  ).rejects.toThrow("Offline");
  expect(calls).toBe(1);
  await rounds.run("firm", async () => {
    calls++;
  });
  expect(calls).toBe(2);
});

test("independent directories do not wait for one another", async () => {
  const rounds = new BackOfficeSyncRounds(),
    blocked = gate();
  const first = rounds.run("firm-a", () => blocked.promise);
  let completed = false;
  await rounds.run("firm-b", async () => {
    completed = true;
  });
  expect(completed).toBe(true);
  blocked.release();
  await first;
});
