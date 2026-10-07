import { expect, test } from "bun:test";
import { unwrap } from "../src/app/lib/opencode";

const failure = (error: unknown) => ({ error, request: new Request("http://localhost/test"), response: new Response(null, { status: 404 }) });

test("server errors display their message instead of raw JSON", () => {
  expect(() => unwrap(failure({ code: "workspace_not_found", message: "Workspace not found" }))).toThrow("Workspace not found");
  try { unwrap(failure({ code: "workspace_not_found", message: "Workspace not found" })); }
  catch (error) { expect(error instanceof Error && error.message).toBe("Workspace not found"); }
});

test("plain errors and successful SDK responses keep their behavior", () => {
  expect(() => unwrap(failure(new Error("Connection failed")))).toThrow("Connection failed");
  expect(() => unwrap(failure("Connection failed"))).toThrow("Connection failed");
  expect(unwrap({ ...failure(undefined), data: { value: 42 } })).toEqual({ value: 42 });
});
