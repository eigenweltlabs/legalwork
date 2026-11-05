import { expect, test } from "bun:test";
import { safeStringify } from "../src/app/utils";

test("the runtime report serializer removes nested native passwords while preserving diagnostics", () => {
  const report = {
    collectedAt: "2026-10-26T21:30:00.000Z",
    app: { version: "0.2.19", gitSha: "test-revision" },
    engine: {
      running: true,
      baseUrl: "http://127.0.0.1:4096",
      opencodeUsername: "opencode",
      opencodePassword: "synthetic-native-password",
      pid: 123,
      execution: { version: "2.1.4", target: "aarch64-apple-darwin" },
    },
    legalworkServer: {
      settings: { connection: { PASSWORD: "synthetic-nested-password" } },
      status: { connected: true, clientToken: "synthetic-client-token" },
    },
    runtimeWorkspaceId: "ws_test",
    selectedWorkspaceRoot: "/tmp/debug-report-project",
  };

  const serialized = safeStringify(report);
  expect(JSON.parse(serialized)).toEqual({
    ...report,
    engine: { ...report.engine, opencodePassword: "[redacted]" },
    legalworkServer: {
      settings: { connection: { PASSWORD: "[redacted]" } },
      status: { connected: true, clientToken: "[redacted]" },
    },
  });
  expect(serialized).not.toContain("synthetic-native-password");
  expect(serialized).not.toContain("synthetic-nested-password");
  expect(serialized).not.toContain("synthetic-client-token");
  expect(report.engine.opencodePassword).toBe("synthetic-native-password");
});
