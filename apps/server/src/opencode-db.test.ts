import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOpencodeDbPath } from "./opencode-db.js";

describe("resolveOpencodeDbPath", () => {
  test("prefers an existing XDG opencode.db when present", async () => {
    const xdg = await mkdtemp(join(tmpdir(), "legalwork-opencode-xdg-"));
    const dir = join(xdg, "opencode");
    const file = join(dir, "opencode.db");
    await mkdir(dir, { recursive: true });
    await writeFile(file, "", "utf8");

    const previousXdg = process.env.XDG_DATA_HOME;
    const previousChannel = process.env.OPENCODE_CHANNEL;
    const previousDb = process.env.OPENCODE_DB;
    try {
      process.env.XDG_DATA_HOME = xdg;
      process.env.OPENCODE_CHANNEL = "local";
      delete process.env.OPENCODE_DB;

      expect(resolveOpencodeDbPath()).toBe(file);
    } finally {
      if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdg;
      if (previousChannel === undefined) delete process.env.OPENCODE_CHANNEL;
      else process.env.OPENCODE_CHANNEL = previousChannel;
      if (previousDb === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = previousDb;
    }
  });

  test("finds orchestrator-managed OpenCode dbs under LEGALWORK_DATA_DIR", async () => {
    const root = await mkdtemp(join(tmpdir(), "legalwork-orchestrator-data-"));
    const dir = join(root, "legalwork-dev-data", "xdg", "data", "opencode");
    const file = join(dir, "opencode.db");
    await mkdir(dir, { recursive: true });
    await writeFile(file, "", "utf8");

    const previousDataDir = process.env.LEGALWORK_DATA_DIR;
    const previousXdg = process.env.XDG_DATA_HOME;
    const previousChannel = process.env.OPENCODE_CHANNEL;
    const previousDb = process.env.OPENCODE_DB;
    try {
      process.env.LEGALWORK_DATA_DIR = root;
      delete process.env.XDG_DATA_HOME;
      process.env.OPENCODE_CHANNEL = "local";
      delete process.env.OPENCODE_DB;

      expect(resolveOpencodeDbPath()).toBe(file);
    } finally {
      if (previousDataDir === undefined) delete process.env.LEGALWORK_DATA_DIR;
      else process.env.LEGALWORK_DATA_DIR = previousDataDir;
      if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdg;
      if (previousChannel === undefined) delete process.env.OPENCODE_CHANNEL;
      else process.env.OPENCODE_CHANNEL = previousChannel;
      if (previousDb === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = previousDb;
    }
  });

  test("finds legacy orchestrator-managed OpenCode dbs under LEGALWORK_DATA_DIR", async () => {
    const root = await mkdtemp(join(tmpdir(), "legalwork-orchestrator-data-"));
    const dir = join(root, "opencode-dev", "ws-test", "xdg", "data", "opencode");
    const file = join(dir, "opencode.db");
    await mkdir(dir, { recursive: true });
    await writeFile(file, "", "utf8");

    const previousDataDir = process.env.LEGALWORK_DATA_DIR;
    const previousXdg = process.env.XDG_DATA_HOME;
    const previousChannel = process.env.OPENCODE_CHANNEL;
    const previousDb = process.env.OPENCODE_DB;
    try {
      process.env.LEGALWORK_DATA_DIR = root;
      delete process.env.XDG_DATA_HOME;
      process.env.OPENCODE_CHANNEL = "local";
      delete process.env.OPENCODE_DB;

      expect(resolveOpencodeDbPath()).toBe(file);
    } finally {
      if (previousDataDir === undefined) delete process.env.LEGALWORK_DATA_DIR;
      else process.env.LEGALWORK_DATA_DIR = previousDataDir;
      if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdg;
      if (previousChannel === undefined) delete process.env.OPENCODE_CHANNEL;
      else process.env.OPENCODE_CHANNEL = previousChannel;
      if (previousDb === undefined) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = previousDb;
    }
  });
});
