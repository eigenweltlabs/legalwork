import { describe, expect, test } from "bun:test";
import { createDocumentAutosave } from "../src/react-app/domains/session/artifacts/document-autosave";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("original-file autosave", () => {
  test("off never writes; enabling saves an existing draft; disabling cancels queued work", async () => {
    let dirty = true, writes = 0;
    const auto = createDocumentAutosave({ delay: 10, save: async () => { writes++; dirty = false; return true; }, isDirty: () => dirty, onError: () => {} });
    auto.changed();
    await wait(35);
    expect(writes).toBe(0);
    auto.setEnabled(true);
    await wait(35);
    expect(writes).toBe(1);
    dirty = true;
    auto.changed();
    auto.setEnabled(false);
    await wait(35);
    expect(writes).toBe(1);
    expect(dirty).toBe(true);
  });

  test("a later edit waits for the in-flight write and is then saved separately", async () => {
    let version = 1, saved = 0, concurrent = 0, maximum = 0;
    let finish: (() => void) | undefined;
    const versions: number[] = [];
    const auto = createDocumentAutosave({ delay: 10, isDirty: () => saved !== version, onError: () => {}, save: async () => {
      const writing = version;
      maximum = Math.max(maximum, ++concurrent);
      versions.push(writing);
      if (versions.length === 1) await new Promise<void>((resolve) => { finish = resolve; });
      saved = writing;
      concurrent--;
      return true;
    } });
    auto.setEnabled(true);
    await wait(35);
    version = 2;
    auto.changed();
    await auto.flush();
    expect(versions).toEqual([1]);
    finish?.();
    await wait(35);
    auto.setEnabled(false);
    expect(versions).toEqual([1, 2]);
    expect(maximum).toBe(1);
    expect(saved).toBe(2);
  });

  test("a conflict pauses retries, retaining edits until explicit retry", async () => {
    let fail = true, dirty = true, writes = 0;
    const errors: unknown[] = [];
    const auto = createDocumentAutosave({ delay: 10, isDirty: () => dirty, onError: (error) => errors.push(error), save: async () => {
      writes++;
      if (fail) throw new Error("File changed externally");
      dirty = false;
      return true;
    } });
    auto.setEnabled(true);
    await wait(35);
    auto.changed();
    await auto.flush();
    await wait(35);
    expect(writes).toBe(1);
    expect(dirty).toBe(true);
    expect(errors).toHaveLength(1);
    fail = false;
    auto.setEnabled(false);
    auto.setEnabled(true);
    await wait(35);
    auto.setEnabled(false);
    expect(writes).toBe(2);
    expect(dirty).toBe(false);
  });

  test("continuous typing cannot postpone saving indefinitely", async () => {
    let writes = 0;
    const auto = createDocumentAutosave({ delay: 30, maxWait: 50, isDirty: () => true, onError: () => {}, save: async () => { writes++; return true; } });
    auto.setEnabled(true);
    for (let i = 0; i < 8; i++) { await wait(10); auto.changed(); }
    auto.setEnabled(false);
    expect(writes).toBeGreaterThanOrEqual(1);
  });
});

test("ownership suspension never resumes failure retries; explicit autosave toggle does", async () => {
  let writes = 0;
  const errors: unknown[] = [];
  const auto = createDocumentAutosave({ delay: 5, isDirty: () => true, onError: error => errors.push(error), save: async () => { writes++; throw new Error("Conflict"); } });
  auto.setEnabled(true);
  await auto.flush();
  expect(writes).toBe(1);
  auto.setSuspended(true);
  auto.setEnabled(true); // Effect replay is not a user preference change.
  auto.setSuspended(false);
  auto.changed();
  await auto.flush();
  expect(writes).toBe(1);
  expect(errors).toHaveLength(1);
  auto.setEnabled(false);
  auto.setEnabled(true);
  await auto.flush();
  expect(writes).toBe(2);
  auto.setSuspended(true);
});

test("ownership suspension cancels pending autosave and resumes a healthy draft", async () => {
  let writes = 0;
  const auto = createDocumentAutosave({ delay: 5, isDirty: () => true, onError: () => {}, save: async () => { writes++; return true; } });
  auto.setEnabled(true);
  auto.setSuspended(true);
  await auto.flush();
  expect(writes).toBe(0);
  auto.setSuspended(false);
  await auto.flush();
  expect(writes).toBe(1);
  auto.setSuspended(true);
});
