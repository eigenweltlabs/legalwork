#!/usr/bin/env node
import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { assertNoRetiredBinaryDownloads } from "./retired-binary-downloads.js";
import { retireMessagingTools } from "./retired-messaging-tools.js";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  realpath,
} from "node:fs/promises";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { legacyDeveloperDaemon, retiredDeveloperLauncherMessage } from "./legacy-developer-launcher.js";
import { homedir, hostname, networkInterfaces, platform, tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { once } from "node:events";

import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { opencodeReleaseTarget } from "@legalwork/opencode-release";
import { installSelectedOpencodeEngine, opencodeEngineSelection, stageSelectedOpencodeEngine, verifySelectedOpencodeEngine } from "@legalwork/opencode-release/selection";
import { expectedOpencodeVersion } from "@legalwork/opencode-release/candidate";
import type { TuiHandle } from "./tui/app.js";

type ApprovalMode = "manual" | "auto";

type SandboxMode = "none" | "auto" | "docker" | "container";

type ResolvedSandboxMode = "none" | "docker" | "container";

type LogFormat = "pretty" | "json";

type LogLevel = "debug" | "info" | "warn" | "error";

type LogAttributes = Record<string, unknown>;

type LoggerChild = {
  log: (level: LogLevel, message: string, attributes?: LogAttributes) => void;
  debug: (message: string, attributes?: LogAttributes) => void;
  info: (message: string, attributes?: LogAttributes) => void;
  warn: (message: string, attributes?: LogAttributes) => void;
  error: (message: string, attributes?: LogAttributes) => void;
};

type Logger = {
  format: LogFormat;
  output: "stdout" | "silent";
  log: (
    level: LogLevel,
    message: string,
    attributes?: LogAttributes,
    component?: string,
  ) => void;
  debug: (
    message: string,
    attributes?: LogAttributes,
    component?: string,
  ) => void;
  info: (
    message: string,
    attributes?: LogAttributes,
    component?: string,
  ) => void;
  warn: (
    message: string,
    attributes?: LogAttributes,
    component?: string,
  ) => void;
  error: (
    message: string,
    attributes?: LogAttributes,
    component?: string,
  ) => void;
  child: (component: string, attributes?: LogAttributes) => LoggerChild;
};

type LogEvent = {
  time: number;
  level: LogLevel;
  message: string;
  component?: string;
  attributes?: LogAttributes;
};

type OpencodeHotReload = {
  enabled: boolean;
  debounceMs: number;
  cooldownMs: number;
};

const FALLBACK_VERSION = "0.1.0";

declare const __LEGALWORK_ORCHESTRATOR_VERSION__: string | undefined;
const DEFAULT_LEGALWORK_PORT = 8787;
const DEFAULT_APPROVAL_TIMEOUT = 30000;
const MANAGED_OPENCODE_CREDENTIAL_LENGTH = 512;
const INTERNAL_OPENCODE_CREDENTIALS_ENV =
  "LEGALWORK_INTERNAL_ALLOW_OPENCODE_CREDENTIALS";
const DEFAULT_OPENCODE_HOT_RELOAD_DEBOUNCE_MS = 700;
const DEFAULT_OPENCODE_HOT_RELOAD_COOLDOWN_MS = 1500;
let warnedLegacyHotReload = false;
const DEFAULT_ACTIVITY_WINDOW_MS = 5 * 60_000;
const DEFAULT_ACTIVITY_HEARTBEAT_INTERVAL_MS = 5 * 60_000;

const SANDBOX_INTERNAL_OPENCODE_PORT = 4096;
const SANDBOX_INTERNAL_LEGALWORK_PORT = DEFAULT_LEGALWORK_PORT;

const LEGALWORK_DEV_DATA_DIR = "legalwork-dev-data";

const SANDBOX_OPENCODE_GLOBAL_CONFIG_CONTAINER_PATH =
  "/persist/.config/opencode";
const SANDBOX_OPENCODE_GLOBAL_DATA_IMPORT_CONTAINER_PATH =
  "/persist/.legalwork-host-opencode-data";
const CLI_SOURCE_DIR = dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_ROOT_DIR = resolve(CLI_SOURCE_DIR, "..");
const REPO_ROOT_DIR = resolve(ORCHESTRATOR_ROOT_DIR, "..", "..");

type ParsedArgs = {
  positionals: string[];
  flags: Map<string, string | boolean>;
};

type ChildHandle = {
  name: string;
  child: ReturnType<typeof spawn>;
};

type VersionInfo = {
  version: string;
  sha256: string;
};

type SidecarName = "legalwork-server" | "opencode";

type SidecarTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-x64"
  | "linux-arm64"
  | "windows-x64"
  | "windows-arm64";

type VersionManifest = {
  dir: string;
  entries: Record<string, VersionInfo>;
};

type SidecarConfig = {
  dir: string;
  target: SidecarTarget | null;
};

type BinarySource = "bundled" | "external" | "prepared";

type BinarySourcePreference = "auto" | "bundled" | "external";

type ResolvedBinary = {
  bin: string;
  source: BinarySource;
  expectedVersion?: string;
};

type BinaryDiagnostics = {
  path: string;
  source: BinarySource;
  expectedVersion?: string;
  actualVersion?: string;
};

type RuntimeServiceName = "legalwork-server" | "opencode";

type RuntimeServiceSnapshot = {
  name: RuntimeServiceName;
  enabled: boolean;
  running: boolean;
  source?: BinarySource;
  path?: string;
  targetVersion?: string;
  actualVersion?: string;
  upgradeAvailable: boolean;
};

type RuntimeUpgradeState = {
  status: "idle" | "running" | "failed";
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  operationId: string | null;
  services: RuntimeServiceName[];
};

type SidecarDiagnostics = {
  dir: string;
  target: SidecarTarget | null;
  source: BinarySourcePreference;
  opencodeSource: BinarySourcePreference;
  allowExternal: boolean;
};

type WorkerActivityHeartbeatConfig = {
  enabled: boolean;
  workerId: string;
  url: string;
  token: string;
  intervalMs: number;
  activeWindowMs: number;
};

type OpencodeStateLayout = {
  devMode: boolean;
  rootDir: string;
  configDir: string;
  env: NodeJS.ProcessEnv;
  importConfigDir?: string;
  importDataDir?: string;
};


function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | boolean>();
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "-h") {
      flags.set("help", true);
      continue;
    }
    if (arg === "-v") {
      flags.set("version", true);
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const trimmed = arg.slice(2);
    if (!trimmed) continue;

    if (trimmed.startsWith("no-")) {
      flags.set(trimmed.slice(3), false);
      continue;
    }

    const [key, inlineValue] = trimmed.split("=");
    if (inlineValue !== undefined) {
      flags.set(key, inlineValue);
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, true);
    }
  }

  return { positionals, flags };
}

function parseList(value?: string): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed))
        return parsed.map((item) => String(item)).filter(Boolean);
    } catch {
      return [];
    }
  }
  return trimmed
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readFlag(
  flags: Map<string, string | boolean>,
  key: string,
): string | undefined {
  const value = flags.get(key);
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value ? "true" : "false";
  return value;
}

function readBool(
  flags: Map<string, string | boolean>,
  key: string,
  fallback: boolean,
  envKey?: string,
): boolean {
  const raw = flags.get(key);
  if (raw !== undefined) {
    if (typeof raw === "boolean") return raw;
    const normalized = String(raw).toLowerCase();
    if (["false", "0", "no"].includes(normalized)) return false;
    if (["true", "1", "yes"].includes(normalized)) return true;
  }

  const envValue = envKey ? process.env[envKey] : undefined;
  if (envValue) {
    const normalized = envValue.toLowerCase();
    if (["false", "0", "no"].includes(normalized)) return false;
    if (["true", "1", "yes"].includes(normalized)) return true;
  }

  return fallback;
}

function readOptionalBool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off"].includes(normalized)) return false;
  }
  return undefined;
}

function readNumber(
  flags: Map<string, string | boolean>,
  key: string,
  fallback: number | undefined,
  envKey?: string,
): number | undefined {
  const raw = flags.get(key);
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (envKey) {
    const envValue = process.env[envKey];
    if (envValue) {
      const parsed = Number(envValue);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return fallback;
}

function readOpencodeHotReload(
  flags: Map<string, string | boolean>,
  defaults?: Partial<OpencodeHotReload>,
  env?: {
    enabled?: string;
    debounceMs?: string;
    cooldownMs?: string;
  },
): OpencodeHotReload {
  if (!warnedLegacyHotReload && (["opencode-hot-reload", "opencode-hot-reload-debounce-ms", "opencode-hot-reload-cooldown-ms"].some(name => flags.has(name))
    || Object.values(env ?? {}).some(name => name && process.env[name]?.trim()))) {
    warnedLegacyHotReload = true;
    console.warn("OpenCode 2 uses native configuration watching. Legacy hot-reload/debounce/cooldown options are retained for CLI compatibility and no longer change the engine's watcher.");
  }
  const enabled = readBool(
    flags,
    "opencode-hot-reload",
    defaults?.enabled ?? true,
    env?.enabled,
  );
  const debounceRaw = readNumber(
    flags,
    "opencode-hot-reload-debounce-ms",
    defaults?.debounceMs ?? DEFAULT_OPENCODE_HOT_RELOAD_DEBOUNCE_MS,
    env?.debounceMs,
  );
  const cooldownRaw = readNumber(
    flags,
    "opencode-hot-reload-cooldown-ms",
    defaults?.cooldownMs ?? DEFAULT_OPENCODE_HOT_RELOAD_COOLDOWN_MS,
    env?.cooldownMs,
  );
  const debounceMs =
    typeof debounceRaw === "number" &&
    Number.isFinite(debounceRaw) &&
    debounceRaw >= 50
      ? Math.floor(debounceRaw)
      : DEFAULT_OPENCODE_HOT_RELOAD_DEBOUNCE_MS;
  const cooldownMs =
    typeof cooldownRaw === "number" &&
    Number.isFinite(cooldownRaw) &&
    cooldownRaw >= 100
      ? Math.floor(cooldownRaw)
      : DEFAULT_OPENCODE_HOT_RELOAD_COOLDOWN_MS;
  return {
    enabled,
    debounceMs,
    cooldownMs,
  };
}

function readBinarySource(
  flags: Map<string, string | boolean>,
  key: string,
  fallback: BinarySourcePreference,
  envKey?: string,
): BinarySourcePreference {
  const raw =
    readFlag(flags, key) ?? (envKey ? process.env[envKey] : undefined);
  if (!raw) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (
    normalized === "auto" ||
    normalized === "bundled" ||
    normalized === "external"
  ) {
    return normalized as BinarySourcePreference;
  }
  throw new Error(
    `Invalid ${key} value: ${raw}. Use auto|bundled|external.`,
  );
}

function readLogFormat(
  flags: Map<string, string | boolean>,
  key: string,
  fallback: LogFormat,
  envKey?: string,
): LogFormat {
  const raw =
    readFlag(flags, key) ?? (envKey ? process.env[envKey] : undefined);
  if (!raw) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "json") return "json";
  if (
    normalized === "pretty" ||
    normalized === "text" ||
    normalized === "human"
  )
    return "pretty";
  throw new Error(`Invalid ${key} value: ${raw}. Use pretty|json.`);
}

function readSandboxMode(
  flags: Map<string, string | boolean>,
  key: string,
  fallback: SandboxMode,
  envKey?: string,
): SandboxMode {
  const raw =
    readFlag(flags, key) ?? (envKey ? process.env[envKey] : undefined);
  if (!raw) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (
    normalized === "none" ||
    normalized === "auto" ||
    normalized === "docker" ||
    normalized === "container"
  ) {
    return normalized as SandboxMode;
  }
  throw new Error(
    `Invalid ${key} value: ${raw}. Use none|auto|docker|container.`,
  );
}

type SandboxAllowedRoot = {
  path: string;
  allowReadWrite?: boolean;
  description?: string;
};

type SandboxMountAllowlist = {
  allowedRoots: SandboxAllowedRoot[];
  blockedPatterns?: string[];
};

type SandboxMount = {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
};

const DEFAULT_SANDBOX_BLOCKED_PATTERNS = [
  ".ssh",
  ".gnupg",
  ".gpg",
  ".aws",
  ".azure",
  ".gcloud",
  ".kube",
  ".docker",
  "credentials",
  ".env",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "id_rsa",
  "id_ed25519",
  "private_key",
  ".secret",
];

let cachedSandboxAllowlist: SandboxMountAllowlist | null | undefined;
let cachedSandboxAllowlistError: string | null = null;

function resolveSandboxAllowlistPath(): string {
  const override = process.env.LEGALWORK_SANDBOX_MOUNT_ALLOWLIST?.trim();
  if (override) return resolve(override);
  return join(homedir(), ".config", "legalwork", "sandbox-mount-allowlist.json");
}

function expandTildePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

async function isDir(input: string): Promise<boolean> {
  try {
    return (await stat(input)).isDirectory();
  } catch {
    return false;
  }
}

async function resolveHostOpencodeGlobalConfigDir(): Promise<string | null> {
  const enabled =
    (
      process.env.LEGALWORK_SANDBOX_MOUNT_OPENCODE_CONFIG ??
      (internalDevModeFromEnv() ? "0" : "1")
    ).trim() !== "0";
  if (!enabled) return null;

  const candidates: string[] = [];
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg) candidates.push(join(xdg, "opencode"));
  candidates.push(join(homedir(), ".config", "opencode"));
  if (process.platform === "darwin") {
    candidates.push(
      join(homedir(), "Library", "Application Support", "opencode"),
    );
  }

  const files = ["opencode.jsonc", "opencode.json", "config.json", "AGENTS.md"];
  for (const candidate of Array.from(
    new Set(candidates.map((item) => resolve(expandTildePath(item)))),
  )) {
    if (!(await isDir(candidate))) continue;
    for (const file of files) {
      try {
        await access(join(candidate, file));
        return candidate;
      } catch {
        // keep looking
      }
    }

    // Fall back to any non-empty config directory. Some setups keep
    // provider/auth material in files that are not part of the strict list above.
    try {
      const entries = await readdir(candidate);
      if (entries.length > 0) return candidate;
    } catch {
      // keep looking
    }
  }

  return null;
}

async function resolveHostOpencodeGlobalDataDir(): Promise<string | null> {
  const enabled =
    (
      process.env.LEGALWORK_SANDBOX_MOUNT_OPENCODE_CONFIG ??
      (internalDevModeFromEnv() ? "0" : "1")
    ).trim() !== "0";
  if (!enabled) return null;

  const candidates: string[] = [];
  const xdgData = process.env.XDG_DATA_HOME?.trim();
  if (xdgData) candidates.push(join(xdgData, "opencode"));
  candidates.push(join(homedir(), ".local", "share", "opencode"));
  if (process.platform === "darwin") {
    candidates.push(
      join(homedir(), "Library", "Application Support", "opencode"),
    );
  }

  const files = ["auth.json", "mcp-auth.json"];
  for (const candidate of Array.from(
    new Set(candidates.map((item) => resolve(expandTildePath(item)))),
  )) {
    if (!(await isDir(candidate))) continue;
    for (const file of files) {
      try {
        await access(join(candidate, file));
        return candidate;
      } catch {
        // keep looking
      }
    }
  }

  return null;
}

async function realpathOrNull(input: string): Promise<string | null> {
  try {
    return await realpath(input);
  } catch {
    return null;
  }
}

function matchesBlockedPattern(
  real: string,
  patterns: string[],
): string | null {
  const parts = real.split(sep);
  for (const pattern of patterns) {
    for (const part of parts) {
      if (part === pattern || part.includes(pattern)) return pattern;
    }
    if (real.includes(pattern)) return pattern;
  }
  return null;
}

async function findAllowedRoot(
  real: string,
  roots: SandboxAllowedRoot[],
): Promise<SandboxAllowedRoot | null> {
  for (const root of roots) {
    const expanded = resolve(expandTildePath(root.path));
    const realRoot = await realpathOrNull(expanded);
    if (!realRoot) continue;
    const rel = relative(realRoot, real);
    if (!rel.startsWith("..") && !isAbsolute(rel)) {
      return root;
    }
  }
  return null;
}

async function loadSandboxAllowlist(): Promise<SandboxMountAllowlist | null> {
  if (cachedSandboxAllowlist !== undefined) return cachedSandboxAllowlist;
  if (cachedSandboxAllowlistError) return null;

  const path = resolveSandboxAllowlistPath();
  try {
    if (!(await fileExists(path))) {
      cachedSandboxAllowlistError = `Mount allowlist not found at ${path}`;
      cachedSandboxAllowlist = null;
      return null;
    }
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as SandboxMountAllowlist;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.allowedRoots)
    ) {
      throw new Error("allowedRoots must be an array");
    }
    const blocked = Array.isArray(parsed.blockedPatterns)
      ? parsed.blockedPatterns
      : [];
    parsed.blockedPatterns = [
      ...new Set([...DEFAULT_SANDBOX_BLOCKED_PATTERNS, ...blocked]),
    ];
    cachedSandboxAllowlist = parsed;
    return parsed;
  } catch (error) {
    cachedSandboxAllowlistError =
      error instanceof Error ? error.message : String(error);
    cachedSandboxAllowlist = null;
    return null;
  }
}

function isValidSandboxContainerSubPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.includes("..")) return false;
  if (trimmed.startsWith("/")) return false;
  if (trimmed.includes("\\")) return false;
  const parts = trimmed.split("/").filter(Boolean);
  if (!parts.length) return false;
  if (parts.some((part) => part === "." || part === "..")) return false;
  return true;
}

function parseSandboxMountSpec(spec: string): {
  hostPath: string;
  containerSubPath: string;
  requestedReadWrite: boolean;
} {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new Error("Empty --sandbox-mount entry");
  }

  let requestedReadWrite = true;
  let base = trimmed;
  if (trimmed.endsWith(":ro")) {
    requestedReadWrite = false;
    base = trimmed.slice(0, -3);
  } else if (trimmed.endsWith(":rw")) {
    requestedReadWrite = true;
    base = trimmed.slice(0, -3);
  }

  const idx = base.indexOf(":");
  if (idx <= 0 || idx >= base.length - 1) {
    throw new Error(
      `Invalid --sandbox-mount value: ${spec}. Use hostPath:subpath[:ro|rw].`,
    );
  }

  const hostPath = base.slice(0, idx).trim();
  const containerSubPath = base.slice(idx + 1).trim();
  if (!hostPath)
    throw new Error(
      `Invalid --sandbox-mount value: ${spec}. Host path is empty.`,
    );
  if (!containerSubPath)
    throw new Error(
      `Invalid --sandbox-mount value: ${spec}. Container subpath is empty.`,
    );

  return { hostPath, containerSubPath, requestedReadWrite };
}

function generateSandboxAllowlistTemplate(): string {
  const template: SandboxMountAllowlist = {
    allowedRoots: [
      {
        path: "~/projects",
        allowReadWrite: true,
        description: "Development projects",
      },
      {
        path: "~/Documents",
        allowReadWrite: false,
        description: "Documents (read-only)",
      },
    ],
    blockedPatterns: ["password", "secret", "token"],
  };
  return JSON.stringify(template, null, 2);
}

async function resolveSandboxExtraMounts(
  specs: string[],
  sandboxMode: ResolvedSandboxMode,
): Promise<SandboxMount[]> {
  if (!specs.length) return [];
  const allowlistPath = resolveSandboxAllowlistPath();
  const allowlist = await loadSandboxAllowlist();
  if (!allowlist) {
    const template = generateSandboxAllowlistTemplate();
    throw new Error(
      `Additional sandbox mounts are blocked. Create ${allowlistPath} to enable.\n\nExample:\n${template}`,
    );
  }
  const blocked = allowlist.blockedPatterns ?? DEFAULT_SANDBOX_BLOCKED_PATTERNS;
  const roots = allowlist.allowedRoots;

  const mounts: SandboxMount[] = [];
  for (const spec of specs) {
    const parsed = parseSandboxMountSpec(spec);
    if (!isValidSandboxContainerSubPath(parsed.containerSubPath)) {
      throw new Error(
        `Invalid sandbox container subpath: "${parsed.containerSubPath}". Use a relative path without "/" prefix or "..".`,
      );
    }
    const expanded = resolve(expandTildePath(parsed.hostPath));
    const real = await realpathOrNull(expanded);
    if (!real) {
      throw new Error(
        `Sandbox mount host path does not exist: ${parsed.hostPath} (expanded: ${expanded})`,
      );
    }
    const blockedMatch = matchesBlockedPattern(real, blocked);
    if (blockedMatch) {
      throw new Error(
        `Sandbox mount rejected (blocked pattern "${blockedMatch}"): ${real}`,
      );
    }
    const allowedRoot = await findAllowedRoot(real, roots);
    if (!allowedRoot) {
      const allowedList = roots
        .map((root) => resolve(expandTildePath(root.path)))
        .join(", ");
      throw new Error(
        `Sandbox mount rejected: ${real} is not under any allowed root. Allowed: ${allowedList}`,
      );
    }
    const allowReadWrite = allowedRoot.allowReadWrite === true;
    const readonly = parsed.requestedReadWrite ? !allowReadWrite : true;
    if (sandboxMode === "container") {
      const info = await stat(real);
      if (!info.isDirectory()) {
        throw new Error(
          `Apple container sandbox mounts must be directories: ${real}`,
        );
      }
    }
    mounts.push({
      hostPath: real,
      containerPath: `/workspace/extra/${parsed.containerSubPath}`,
      readonly,
    });
  }
  return mounts;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveCliVersion(): Promise<string> {
  if (
    typeof __LEGALWORK_ORCHESTRATOR_VERSION__ === "string" &&
    __LEGALWORK_ORCHESTRATOR_VERSION__.trim()
  ) {
    return __LEGALWORK_ORCHESTRATOR_VERSION__.trim();
  }
  const candidates = [
    join(dirname(process.execPath), "..", "package.json"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
  ];

  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      try {
        const raw = await readFile(candidate, "utf8");
        const parsed = JSON.parse(raw) as { version?: string };
        if (parsed.version) return parsed.version;
      } catch {
        // ignore
      }
    }
  }

  return FALLBACK_VERSION;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readPathHelperPaths(): Promise<string[]> {
  if (process.platform !== "darwin") return [];
  return await new Promise((resolve) => {
    const child = spawnProcess("/usr/libexec/path_helper", ["-s"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve([]));
    child.on("exit", (code) => {
      if (code !== 0) {
        resolve([]);
        return;
      }
      const match =
        stdout.match(/PATH="([^"]+)"/) ?? stdout.match(/PATH=([^;\n]+)/);
      if (!match) {
        resolve([]);
        return;
      }
      resolve(match[1].split(":").filter(Boolean));
    });
  });
}

async function resolveDockerCandidates(): Promise<string[]> {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };

  for (const key of [
    "LEGALWORK_DOCKER_BIN",
    "OPENWRK_DOCKER_BIN",
    "DOCKER_BIN",
  ]) {
    const value = process.env[key];
    if (value) push(value);
  }

  const addFromPath = (value?: string | null) => {
    if (!value) return;
    for (const dir of value.split(delimiter)) {
      if (!dir.trim()) continue;
      push(join(dir, "docker"));
    }
  };

  addFromPath(process.env.PATH ?? "");

  if (process.platform === "darwin") {
    const helperPaths = await readPathHelperPaths();
    for (const dir of helperPaths) {
      push(join(dir, "docker"));
    }
  }

  for (const raw of [
    "/opt/homebrew/bin/docker",
    "/usr/local/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
  ]) {
    push(raw);
  }

  const valid: string[] = [];
  for (const candidate of out) {
    if (await isExecutable(candidate)) {
      valid.push(candidate);
    }
  }
  return valid;
}

async function resolveDockerCommand(): Promise<string> {
  const candidates = await resolveDockerCandidates();
  return candidates[0] ?? "docker";
}

async function ensureWorkspace(workspace: string): Promise<string> {
  const resolved = resolve(workspace);
  await mkdir(resolved, { recursive: true });

  // Seed the config in the hidden .opencode/ directory (the engine reads it
  // from there too) so the workspace folder stays free of files the user
  // didn't create. An existing root config is respected and left alone.
  const candidates = [
    join(resolved, "opencode.jsonc"),
    join(resolved, "opencode.json"),
    join(resolved, ".opencode", "opencode.jsonc"),
    join(resolved, ".opencode", "opencode.json"),
  ];
  const existing = await Promise.all(candidates.map((path) => fileExists(path)));

  if (!existing.some(Boolean)) {
    const payload = JSON.stringify(
      { $schema: "https://opencode.ai/config.json" },
      null,
      2,
    );
    const hiddenJsonc = join(resolved, ".opencode", "opencode.jsonc");
    await mkdir(join(resolved, ".opencode"), { recursive: true });
    await writeFile(hiddenJsonc, `${payload}\n`, "utf8");
  }

  return resolved;
}

async function canBind(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createNetServer();
    server.once("error", () => {
      server.close();
      resolve(false);
    });
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once("error", (err) => reject(err));
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate free port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function resolvePort(
  preferred: number | undefined,
  host: string,
  fallback?: number,
): Promise<number> {
  if (preferred && (await canBind(host, preferred))) {
    return preferred;
  }
  if (fallback && fallback !== preferred && (await canBind(host, fallback))) {
    return fallback;
  }
  return findFreePort(host);
}

function isCompiledBunBinary(): boolean {
  try {
    const entryPath = fileURLToPath(import.meta.url);
    return entryPath.startsWith("/$bunfs/");
  } catch {
    return false;
  }
}

function resolveLanIp(): string | null {
  const interfaces = networkInterfaces();
  for (const key of Object.keys(interfaces)) {
    const entries = interfaces[key];
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      return entry.address;
    }
  }
  return null;
}

function resolveConnectUrl(
  port: number,
  overrideHost?: string,
): { connectUrl?: string; lanUrl?: string; mdnsUrl?: string } {
  if (overrideHost) {
    const trimmed = overrideHost.trim();
    if (trimmed) {
      const url = `http://${trimmed}:${port}`;
      return { connectUrl: url, lanUrl: url };
    }
  }

  const host = hostname().trim();
  const mdnsUrl = host
    ? `http://${host.replace(/\.local$/, "")}.local:${port}`
    : undefined;
  const lanIp = resolveLanIp();
  const lanUrl = lanIp ? `http://${lanIp}:${port}` : undefined;
  const connectUrl = lanUrl ?? mdnsUrl;
  return { connectUrl, lanUrl, mdnsUrl };
}

function encodeBasicAuth(username: string, password: string): string {
  return Buffer.from(`${username}:${password}`, "utf8").toString("base64");
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "127.0.0.1" ||
    normalized === "localhost" ||
    normalized === "::1"
  );
}

function randomCredential(length: number): string {
  return randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
}

function generateManagedOpencodeCredentials(): {
  username: string;
  password: string;
} {
  return {
    username: "opencode",
    password: randomCredential(MANAGED_OPENCODE_CREDENTIAL_LENGTH),
  };
}

function resolveManagedOpencodeCredentials(args: ParsedArgs): {
  username: string;
  password: string;
} {
  const explicitUsernameFlag = args.flags.get("opencode-username");
  const explicitPasswordFlag = args.flags.get("opencode-password");
  const requestedUsername =
    typeof explicitUsernameFlag === "string"
      ? explicitUsernameFlag
      : process.env.LEGALWORK_OPENCODE_USERNAME ??
        process.env.OPENCODE_SERVER_USERNAME;
  const requestedPassword =
    typeof explicitPasswordFlag === "string"
      ? explicitPasswordFlag
      : process.env.LEGALWORK_OPENCODE_PASSWORD ??
        process.env.OPENCODE_SERVER_PASSWORD;
  const allowInjectedCredentials =
    (process.env[INTERNAL_OPENCODE_CREDENTIALS_ENV] ?? "").trim() === "1";
  const hasExplicitCredentialFlags =
    typeof explicitUsernameFlag === "string" ||
    typeof explicitPasswordFlag === "string";

  if (
    hasExplicitCredentialFlags &&
    ((requestedUsername && !requestedPassword) ||
      (!requestedUsername && requestedPassword))
  ) {
    throw new Error(
      "OpenCode credentials must include both username and password.",
    );
  }

  if (requestedUsername && requestedPassword && hasExplicitCredentialFlags) {
    if (!allowInjectedCredentials) {
      throw new Error(
        "OpenCode credentials are managed by LegalWork. Custom --opencode-username/--opencode-password values are not supported.",
      );
    }
    if (requestedUsername !== "opencode") throw new Error("OpenCode v2 uses the fixed username opencode; update the injected credentials.");
    return { username: "opencode", password: requestedPassword };
  }

  if (requestedUsername && requestedPassword && allowInjectedCredentials) {
    if (requestedUsername !== "opencode") throw new Error("OpenCode v2 uses the fixed username opencode; update the injected credentials.");
    return { username: "opencode", password: requestedPassword };
  }

  return generateManagedOpencodeCredentials();
}

function assertManagedOpencodeAuth(args: ParsedArgs) {
  const authEnabled = readBool(
    args.flags,
    "opencode-auth",
    true,
    "LEGALWORK_OPENCODE_AUTH",
  );
  if (!authEnabled) {
    throw new Error(
      "OpenCode basic auth is always enabled when LegalWork launches OpenCode.",
    );
  }
}

function resolveManagedOpencodeHost(requestedHost?: string): string {
  const normalized = requestedHost?.trim();
  if (!normalized) return "127.0.0.1";
  if (!isLoopbackHost(normalized)) {
    throw new Error(
      `OpenCode must stay on loopback. Unsupported --opencode-host value: ${normalized}`,
    );
  }
  return normalized === "localhost" ? "127.0.0.1" : normalized;
}

const OPENCODE_LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;

function resolveOpencodeLogLevel(requested?: string): string | undefined {
  const trimmed = requested?.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.toUpperCase();
  if (!(OPENCODE_LOG_LEVELS as readonly string[]).includes(normalized)) {
    throw new Error(
      `Unsupported --opencode-log-level value: ${requested}. Expected one of: ${OPENCODE_LOG_LEVELS.join(", ")}.`,
    );
  }
  return normalized;
}

function resolveLegalworkRemoteAccess(args: ParsedArgs): boolean {
  const explicitHost =
    readFlag(args.flags, "legalwork-host") ?? process.env.LEGALWORK_HOST;
  const remoteAccessRequested =
    readBool(args.flags, "remote-access", false, "LEGALWORK_REMOTE_ACCESS") ||
    explicitHost?.trim() === "0.0.0.0";

  if (explicitHost) {
    const normalized = explicitHost.trim();
    if (!normalized) return remoteAccessRequested;
    if (normalized === "0.0.0.0") return true;
    if (!isLoopbackHost(normalized)) {
      throw new Error(
        `Unsupported --legalwork-host value: ${normalized}. Use loopback by default or --remote-access for shared access.`,
      );
    }
  }

  return remoteAccessRequested;
}


function parsePositiveNumberEnv(
  value: string | undefined,
  fallback: number,
): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseSessionActivityAt(session: unknown): number | null {
  if (!session || typeof session !== "object") return null;
  const record = session as {
    time?: { updated?: number; created?: number };
  };
  const updated = record.time?.updated;
  if (typeof updated === "number" && Number.isFinite(updated) && updated > 0) {
    return updated;
  }
  const created = record.time?.created;
  if (typeof created === "number" && Number.isFinite(created) && created > 0) {
    return created;
  }
  return null;
}

function resolveWorkerActivityHeartbeatConfig(): WorkerActivityHeartbeatConfig {
  const enabled = (process.env.DEN_ACTIVITY_HEARTBEAT_ENABLED ?? "")
    .trim()
    .toLowerCase();
  const workerId = (process.env.DEN_WORKER_ID ?? "").trim();
  const url = (process.env.DEN_ACTIVITY_HEARTBEAT_URL ?? "").trim();
  const token = (process.env.DEN_ACTIVITY_HEARTBEAT_TOKEN ?? "").trim();

  const featureEnabled =
    enabled === "1" || enabled === "true" || enabled === "yes";

  if (!featureEnabled || !workerId || !url || !token) {
    return {
      enabled: false,
      workerId: "",
      url: "",
      token: "",
      intervalMs: DEFAULT_ACTIVITY_HEARTBEAT_INTERVAL_MS,
      activeWindowMs: DEFAULT_ACTIVITY_WINDOW_MS,
    };
  }

  const intervalSeconds = parsePositiveNumberEnv(
    process.env.DEN_ACTIVITY_HEARTBEAT_INTERVAL_SECONDS,
    DEFAULT_ACTIVITY_HEARTBEAT_INTERVAL_MS / 1000,
  );
  const activeWindowSeconds = parsePositiveNumberEnv(
    process.env.DEN_ACTIVITY_WINDOW_SECONDS,
    DEFAULT_ACTIVITY_WINDOW_MS / 1000,
  );

  return {
    enabled: true,
    workerId,
    url,
    token,
    intervalMs: Math.round(intervalSeconds * 1000),
    activeWindowMs: Math.round(activeWindowSeconds * 1000),
  };
}

async function postWorkerActivityHeartbeat(input: {
  config: WorkerActivityHeartbeatConfig;
  opencodeClient: OpenCodeClient;
  logger: Logger;
}) {
  if (!input.config.enabled) return;

  const sessions=[];
  let cursor:string|undefined;
  const seen=new Set<string>();
  do {
    const page=await input.opencodeClient.session.list({cursor});sessions.push(...page.data);cursor=page.cursor.next??undefined;
    if(cursor&&seen.has(cursor))throw new Error("The engine repeated a session page cursor.");if(cursor)seen.add(cursor);
  }while(cursor);
  let latestActivityAt = 0;
  for (const session of sessions) {
    const ts = parseSessionActivityAt(session);
    if (ts && ts > latestActivityAt) {
      latestActivityAt = ts;
    }
  }

  const now = Date.now();
  const isActiveRecently =
    latestActivityAt > 0 && now - latestActivityAt <= input.config.activeWindowMs;

  const payload = {
    sentAt: new Date(now).toISOString(),
    isActiveRecently,
    lastActivityAt:
      latestActivityAt > 0 ? new Date(latestActivityAt).toISOString() : null,
    openSessionCount: sessions.length,
  };

  const response = await fetch(input.config.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.config.token}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`heartbeat_failed:${response.status}`);
  }

  input.logger.debug(
    "Worker activity heartbeat sent",
    {
      workerId: input.config.workerId,
      isActiveRecently,
      lastActivityAt: payload.lastActivityAt,
      openSessionCount: payload.openSessionCount,
    },
    "legalwork-orchestrator",
  );
}

function prefixStream(
  stream: NodeJS.ReadableStream | null,
  label: string,
  level: "stdout" | "stderr",
  logger: Logger,
  pid?: number,
): void {
  if (!stream) return;
  stream.setEncoding("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      if (
        logger.output === "stdout" &&
        logger.format === "json" &&
        looksLikeOtelLogLine(line)
      ) {
        process.stdout.write(`${line}\n`);
        continue;
      }
      const severity: LogLevel = level === "stderr" ? "error" : "info";
      logger.log(severity, line, { stream: level, pid }, label);
    }
  });
  stream.on("end", () => {
    if (!buffer.trim()) return;
    if (
      logger.output === "stdout" &&
      logger.format === "json" &&
      looksLikeOtelLogLine(buffer)
    ) {
      process.stdout.write(`${buffer}\n`);
      return;
    }
    const severity: LogLevel = level === "stderr" ? "error" : "info";
    logger.log(severity, buffer, { stream: level, pid }, label);
  });
}

function resolveBinCommand(bin: string): {
  command: string;
  prefixArgs: string[];
} {
  if (bin.endsWith(".ts")) {
    return { command: "bun", prefixArgs: [bin, "--"] };
  }
  if (bin.endsWith(".js")) {
    return { command: "node", prefixArgs: [bin, "--"] };
  }
  return { command: bin, prefixArgs: [] };
}

async function readVersionManifest(): Promise<VersionManifest | null> {
  const binDir = dirname(process.execPath);
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const envManifestPath = process.env.LEGALWORK_VERSION_MANIFEST?.trim();
  const envSidecarDir = process.env.LEGALWORK_BUNDLED_SIDECAR_DIR?.trim();
  const candidates = [
    ...(envManifestPath
      ? [
          {
            manifestPath: envManifestPath,
            dir: envSidecarDir || dirname(envManifestPath),
          },
        ]
      : []),
    { manifestPath: join(binDir, "versions.json"), dir: binDir },
    // macOS treats files in Contents/MacOS as executable code, so the manifest
    // is bundled as a resource while sidecar binaries remain next to execPath.
    { manifestPath: join(binDir, "..", "Resources", "versions.json"), dir: binDir },
    { manifestPath: join(moduleDir, "versions.json"), dir: moduleDir },
  ];
  for (const { manifestPath, dir } of candidates) {
    if (await fileExists(manifestPath)) {
      try {
        const payload = await readFile(manifestPath, "utf8");
        const entries = JSON.parse(payload) as Record<string, VersionInfo>;
        return { dir, entries };
      } catch {
        return { dir, entries: {} };
      }
    }
  }
  return null;
}

let cachedExtraPathEntries: string[] | null = null;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function splitPathEntries(value?: string): string[] {
  if (!value) return [];
  return value.split(delimiter).map((entry) => entry.trim()).filter(Boolean);
}

function pushPath(entries: string[], path?: string | null) {
  if (!path) return;
  const candidate = resolve(path.trim());
  if (!isDirectory(candidate)) return;
  if (!entries.includes(candidate)) entries.push(candidate);
}

function nvmVersionBinPaths(home: string): string[] {
  const base = join(home, ".nvm", "versions", "node");
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(base, entry.name, "bin"))
      .filter(isDirectory)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

function resolveExtraPathEntries(): string[] {
  if (cachedExtraPathEntries) return cachedExtraPathEntries;

  const entries: string[] = [];
  const sidecarOverride =
    process.env.OPENWRK_SIDECAR_DIR ?? process.env.LEGALWORK_SIDECAR_DIR;
  const sidecarCandidates = [
    sidecarOverride,
    dirname(process.execPath),
    join(dirname(process.execPath), "sidecars"),
    join(ORCHESTRATOR_ROOT_DIR, "dist"),
    resolve(REPO_ROOT_DIR, "apps", "desktop", "resources", "sidecars"),
  ];
  for (const candidate of sidecarCandidates) {
    pushPath(entries, candidate);
  }

  const home = homedir();
  if (process.platform === "darwin") {
    for (const candidate of [
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
      join(home, ".nvm", "current", "bin"),
      ...nvmVersionBinPaths(home),
      join(home, ".fnm", "current", "bin"),
      join(home, ".volta", "bin"),
      join(home, "Library", "pnpm"),
      join(home, ".bun", "bin"),
      join(home, ".cargo", "bin"),
      join(home, ".pyenv", "shims"),
      join(home, ".local", "bin"),
    ]) {
      pushPath(entries, candidate);
    }
  }

  if (process.platform === "linux") {
    for (const candidate of [
      "/usr/local/bin",
      "/usr/local/sbin",
      join(home, ".nvm", "current", "bin"),
      ...nvmVersionBinPaths(home),
      join(home, ".fnm", "current", "bin"),
      join(home, ".volta", "bin"),
      join(home, ".local", "share", "pnpm"),
      join(home, ".bun", "bin"),
      join(home, ".cargo", "bin"),
      join(home, ".pyenv", "shims"),
      join(home, ".local", "bin"),
    ]) {
      pushPath(entries, candidate);
    }
  }

  if (process.platform === "win32") {
    for (const candidate of [
      join(home, ".volta", "bin"),
      join(home, ".bun", "bin"),
      join(home, ".cargo", "bin"),
      process.env.APPDATA ? join(process.env.APPDATA, "npm") : null,
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "pnpm") : null,
    ]) {
      pushPath(entries, candidate);
    }
  }

  cachedExtraPathEntries = entries;
  return entries;
}

// Resolves ~/.config/legalwork/env.json (or %APPDATA%\legalwork\env.json on
// Windows) — must agree byte-for-byte with apps/server/src/env-file.ts and
// apps/desktop/electron/runtime.mjs. Honor LEGALWORK_ENV_STORE override.
function resolveUserEnvFilePath(): string {
  const override = (process.env.LEGALWORK_ENV_STORE ?? "").trim();
  if (override) return resolve(override);
  if (platform() === "win32") {
    const appData = (process.env.APPDATA ?? "").trim();
    const root = appData || join(homedir(), "AppData", "Roaming");
    return join(root, "legalwork", "env.json");
  }
  return join(homedir(), ".config", "legalwork", "env.json");
}

const USER_ENV_RESERVED_PREFIXES = ["LEGALWORK_", "OPENCODE_"] as const;

// Synchronous, best-effort, never throws. Absent or malformed files return {}.
// Reads on every spawn so UI edits are picked up on the next child start.
function loadUserEnvFile(): Record<string, string> {
  try {
    const raw = readFileSync(resolveUserEnvFilePath(), "utf8");
    const parsed = JSON.parse(raw) as { variables?: unknown };
    if (!Array.isArray(parsed.variables)) return {};
    const out: Record<string, string> = {};
    for (const entry of parsed.variables) {
      if (!entry || typeof entry !== "object") continue;
      const { key, value } = entry as { key?: unknown; value?: unknown };
      if (typeof key !== "string" || typeof value !== "string") continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      if (USER_ENV_RESERVED_PREFIXES.some((p) => key.startsWith(p))) continue;
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function buildSpawnEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = env ?? process.env;
  // User env is layered first so existing process.env / caller overrides
  // always win. This is what makes Linux GUI launches work: the shell env
  // is empty for ANTHROPIC_API_KEY, the user file supplies it, but anything
  // the shell or spawn-site already set (LEGALWORK_TOKEN, etc.) is untouched.
  const merged: NodeJS.ProcessEnv = { ...loadUserEnvFile() };
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) merged[key] = value;
  }
  const pathKey =
    Object.prototype.hasOwnProperty.call(merged, "PATH") ||
    !Object.prototype.hasOwnProperty.call(merged, "Path")
      ? "PATH"
      : "Path";
  const currentPath = pathKey === "PATH" ? merged.PATH : merged.Path;
  const entries = [
    ...resolveExtraPathEntries(),
    ...splitPathEntries(currentPath),
  ];
  const deduped = entries.filter((entry, index) => entries.indexOf(entry) === index);
  if (!deduped.length) return merged;
  return { ...merged, [pathKey]: deduped.join(delimiter) };
}

function resolveSidecarTarget(): SidecarTarget | null {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") return "darwin-arm64";
    if (process.arch === "x64") return "darwin-x64";
    return null;
  }
  if (process.platform === "linux") {
    if (process.arch === "arm64") return "linux-arm64";
    if (process.arch === "x64") return "linux-x64";
    return null;
  }
  if (process.platform === "win32") {
    if (process.arch === "arm64") return "windows-arm64";
    if (process.arch === "x64") return "windows-x64";
    return null;
  }
  return null;
}

function resolveSandboxSidecarTarget(
  mode: ResolvedSandboxMode,
): SidecarTarget | null {
  if (mode === "none") return resolveSidecarTarget();
  // Sandbox runs inside Linux (docker / container).
  if (process.arch === "arm64") return "linux-arm64";
  if (process.arch === "x64") return "linux-x64";
  return null;
}

function resolveSidecarConfigForTarget(
  flags: Map<string, string | boolean>,
  targetOverride: SidecarTarget | null,
): SidecarConfig {
  return {
    dir: resolveSidecarDir(flags),
    target: targetOverride,
  };
}

function spawnProcess(
  command: string,
  args: string[],
  options: SpawnOptions = {},
) {
  const env = buildSpawnEnv(options.env);
  const resolvedOptions = { ...options, env };
  if (process.platform === "win32") {
    return spawn(command, args, { ...resolvedOptions, windowsHide: true });
  }
  return spawn(command, args, resolvedOptions);
}

async function probeCommand(
  command: string,
  args: string[],
  timeoutMs = 2500,
): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawnProcess(command, args, {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve(false);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.on("exit", (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}

async function resolveSandboxMode(
  mode: SandboxMode,
): Promise<ResolvedSandboxMode> {
  if (mode === "none") return "none";
  if (mode === "docker") return "docker";
  if (mode === "container") return "container";

  // auto
  if (process.platform === "darwin" && process.arch === "arm64") {
    const containerOk = await probeCommand("container", ["--version"]);
    if (containerOk) return "container";
  }

  const dockerCommand = await resolveDockerCommand();
  const dockerOk = await probeCommand(dockerCommand, ["version"]);
  if (dockerOk) return "docker";

  const containerOk = await probeCommand("container", ["--version"]);
  if (containerOk) return "container";
  return "none";
}

function shQuote(value: string): string {
  if (!value) return "''";
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function addEnvPassThroughArgs(args: string[], names: string[]) {
  for (const name of names) {
    args.push("--env", name);
  }
}

const SANDBOX_INTERNAL_ENV_NAMES = [
  "LEGALWORK_TOKEN",
  "LEGALWORK_HOST_TOKEN",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_SERVER_PASSWORD",
  "LEGALWORK_OPENCODE_USERNAME",
  "LEGALWORK_OPENCODE_PASSWORD",
] as const;

function sandboxEnvPassThroughNames(userEnv: Record<string, string>): string[] {
  return [...SANDBOX_INTERNAL_ENV_NAMES, ...Object.keys(userEnv).sort()].filter(
    (name, index, names) => names.indexOf(name) === index,
  );
}

function resolveSidecarDir(flags: Map<string, string | boolean>): string {
  const override =
    readFlag(flags, "sidecar-dir") ?? process.env.LEGALWORK_SIDECAR_DIR;
  if (override && override.trim()) return resolve(override.trim());
  return join(resolveRouterDataDir(flags), "sidecars");
}

async function ensureExecutable(path: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    await chmod(path, 0o755);
  } catch {
    // ignore
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd?: string,
): Promise<void> {
  const child = spawnProcess(command, args, { cwd, stdio: "inherit" });
  const result = await Promise.race([
    once(child, "exit").then(([code]) => ({ type: "exit" as const, code })),
    once(child, "error").then(([error]) => ({ type: "error" as const, error })),
  ]);
  if (result.type === "error") {
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}: ${String(result.error)}`,
    );
  }
  if (result.code !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

async function sha256File(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

async function verifyBinary(
  path: string,
  expected?: VersionInfo,
): Promise<void> {
  if (!expected) return;
  const hash = await sha256File(path);
  if (hash !== expected.sha256) {
    throw new Error(`Integrity check failed for ${path}`);
  }
}

async function resolveBundledBinary(
  manifest: VersionManifest | null,
  name: string,
): Promise<string | null> {
  if (!manifest) return null;
  const candidates = [join(manifest.dir, name)];
  if (process.platform === "win32") {
    candidates.push(join(manifest.dir, `${name}.exe`));
  }
  for (const bundled of candidates) {
    if (!(await isExecutable(bundled))) continue;
    // Desktop bundles may be code-signed after we generate versions.json, which
    // mutates the on-disk bytes and makes a precomputed sha256 unstable.
    // Linux bundles remain byte-stable, so keep integrity verification there.
    if (process.platform === "linux") {
      await verifyBinary(bundled, manifest.entries[name]);
    }
    return bundled;
  }
  return null;
}

async function readPackageVersion(path: string): Promise<string | undefined> {
  try {
    const payload = await readFile(path, "utf8");
    const parsed = JSON.parse(payload) as { version?: string };
    if (typeof parsed.version === "string") return parsed.version;
    return undefined;
  } catch {
    return undefined;
  }
}

async function resolveExpectedVersion(
  manifest: VersionManifest | null,
  name: SidecarName,
): Promise<string | undefined> {
  if (name === "opencode") return opencodeEngineSelection.version;
  const manifestVersion = manifest?.entries[name]?.version;
  if (manifestVersion) return manifestVersion;

  try {
    const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
    if (name === "legalwork-server") {
      const localPath = join(root, "..", "server", "package.json");
      const localVersion = await readPackageVersion(localPath);
      if (localVersion) return localVersion;
    }
  } catch {
    // ignore
  }

  const require = createRequire(import.meta.url);
  if (name === "legalwork-server") {
    try {
      const pkgPath = require.resolve("legalwork-server/package.json");
      const version = await readPackageVersion(pkgPath);
      if (version) return version;
    } catch {
      // ignore
    }
  }

  return undefined;
}

function parseVersion(output: string): string | undefined {
  const match = output.match(/\d+\.\d+\.\d+(?:-[\w.-]+)?/);
  return match?.[0];
}

async function readCliVersion(
  bin: string,
  timeoutMs = 4000,
): Promise<string | undefined> {
  const resolved = resolveBinCommand(bin);
  const child = spawnProcess(
    resolved.command,
    [...resolved.prefixArgs, "--version"],
    {
      // Avoid picking up a local bunfig.toml preload from the caller's cwd.
      // (Notably, packages/orchestrator/bunfig.toml preloads @opentui/solid/preload which
      // breaks running Bun-compiled binaries during version checks.)
      cwd: tmpdir(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });

  const result = await Promise.race([
    once(child, "close").then(() => "close"),
    once(child, "error").then(() => "error"),
    new Promise((resolve) => setTimeout(resolve, timeoutMs, "timeout")),
  ]);

  if (result === "timeout") {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    return undefined;
  }

  if (result === "error") {
    return undefined;
  }

  return parseVersion(output.trim());
}

async function captureCommandOutput(
  bin: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<string> {
  const resolved = resolveBinCommand(bin);
  const child = spawnProcess(
    resolved.command,
    [...resolved.prefixArgs, ...args],
    {
      cwd: tmpdir(),
      stdio: ["ignore", "pipe", "pipe"],
      env: options?.env ?? process.env,
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk.toString();
  });

  type CaptureResult =
    | "timeout"
    | "error"
    | {
        type: "close";
        code: number | null;
        signal: NodeJS.Signals | null;
      };

  const timeoutMs = options?.timeoutMs ?? 30_000;
  const result = await Promise.race<CaptureResult>([
    once(child, "close").then(([code, signal]) => ({
      type: "close" as const,
      code: (code ?? null) as number | null,
      signal: (signal ?? null) as NodeJS.Signals | null,
    })),
    once(child, "error").then(() => "error" as const),
    new Promise<CaptureResult>((resolve) =>
      setTimeout(resolve, timeoutMs, "timeout"),
    ),
  ]);

  if (result === "timeout") {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    throw new Error("Command timed out");
  }

  if (result === "error") {
    throw new Error("Command failed to run");
  }

  const code = result.code;
  if (code !== 0) {
    const suffix = output.trim() ? `\n${output.trim()}` : "";
    throw new Error(`Command failed: ${bin} ${args.join(" ")}${suffix}`);
  }

  return output.trim();
}

function assertVersionMatch(
  name: string,
  expected: string | undefined,
  actual: string | undefined,
  context: string,
): void {
  if (!expected) return;
  if (!actual) {
    throw new Error(
      `Unable to determine ${name} version from ${context}. Expected ${expected}.`,
    );
  }
  if (expected !== actual) {
    throw new Error(
      `${name} version mismatch: expected ${expected}, got ${actual}.`,
    );
  }
}

function resolveBinPath(bin: string): string {
  if (bin.includes("/") || bin.startsWith(".")) {
    return resolve(process.cwd(), bin);
  }
  return bin;
}

function isPathLikeBinary(bin: string): boolean {
  return bin.includes("/") || bin.startsWith(".");
}

async function assertSandboxBinaryFile(
  name: string,
  bin: string,
): Promise<void> {
  const lower = bin.toLowerCase();
  if (lower.endsWith(".js") || lower.endsWith(".ts")) {
    throw new Error(
      `Sandbox mode requires ${name} to be a native binary (got ${bin}). Build local Linux sidecars or pass a Linux binary path.`,
    );
  }
  if (!isPathLikeBinary(bin)) {
    throw new Error(
      `Sandbox mode requires ${name} to be a file path (got ${bin}). Build local Linux sidecars or pass --${name}-bin with a Linux binary path.`,
    );
  }
  const resolved = resolve(process.cwd(), bin);
  if (!(await fileExists(resolved))) {
    throw new Error(
      `Sandbox mode could not find ${name} binary at ${resolved}.`,
    );
  }
}

async function resolveLegalworkServerBin(options: {
  explicit?: string;
  manifest: VersionManifest | null;
  allowExternal: boolean;
  sidecar: SidecarConfig;
  source: BinarySourcePreference;
}): Promise<ResolvedBinary> {
  if (options.explicit && !options.allowExternal) {
    throw new Error("legalwork-server-bin requires --allow-external");
  }
  if (
    options.explicit &&
    options.source !== "auto" &&
    options.source !== "external"
  ) {
    throw new Error(
      "legalwork-server-bin requires --sidecar-source external or auto",
    );
  }

  const expectedVersion = await resolveExpectedVersion(
    options.manifest,
    "legalwork-server",
  );
  const resolveExternal = async (): Promise<ResolvedBinary> => {
    if (!options.allowExternal) {
      throw new Error("External legalwork-server requires --allow-external");
    }
    if (options.explicit) {
      const resolved = resolveBinPath(options.explicit);
      if (
        (resolved.includes("/") || resolved.startsWith(".")) &&
        !(await fileExists(resolved))
      ) {
        throw new Error(`legalwork-server-bin not found: ${resolved}`);
      }
      return { bin: resolved, source: "external", expectedVersion };
    }

    const require = createRequire(import.meta.url);
    try {
      const pkgPath = require.resolve("legalwork-server/package.json");
      const pkgDir = dirname(pkgPath);
      const binaryPath = join(pkgDir, "dist", "bin", "legalwork-server");
      if (await isExecutable(binaryPath)) {
        return { bin: binaryPath, source: "external", expectedVersion };
      }
      const cliPath = join(pkgDir, "dist", "cli.js");
      if (await isExecutable(cliPath)) {
        return { bin: cliPath, source: "external", expectedVersion };
      }
    } catch {
      // ignore
    }

    return { bin: "legalwork-server", source: "external", expectedVersion };
  };

  if (options.source === "bundled") {
    const bundled = await resolveBundledBinary(
      options.manifest,
      "legalwork-server",
    );
    if (!bundled) {
      throw new Error(
        "Bundled legalwork-server binary missing. Build with pnpm --filter legalwork-orchestrator build:bin:bundled.",
      );
    }
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.source === "external") {
    return resolveExternal();
  }

  const bundled = await resolveBundledBinary(
    options.manifest,
    "legalwork-server",
  );
  if (bundled && !(options.allowExternal && options.explicit)) {
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.explicit) {
    return resolveExternal();
  }

  if (!options.allowExternal) {
    throw new Error(
      "Bundled legalwork-server is missing. Build the local bundle or use --allow-external with a local server; standalone binary downloads are retired.",
    );
  }

  return resolveExternal();
}

async function resolveOpencodeBin(options: {
  explicit?: string;
  manifest: VersionManifest | null;
  allowExternal: boolean;
  sidecar: SidecarConfig;
  source: BinarySourcePreference;
}): Promise<ResolvedBinary> {
  if (options.explicit && !options.allowExternal) {
    throw new Error("opencode-bin requires --allow-external");
  }
  if (
    options.explicit &&
    options.source !== "auto" &&
    options.source !== "external"
  ) {
    throw new Error("opencode-bin requires --opencode-source external or auto");
  }

  const expectedVersion = await resolveExpectedVersion(
    options.manifest,
    "opencode",
  );
  if (opencodeEngineSelection.kind === "derivative") {
    const parts = options.sidecar.target?.replace(/^bun-/, "").split("-");
    const target = parts ? opencodeReleaseTarget(parts[0] === "windows" ? "win32" : parts[0], parts[1], parts.includes("musl") ? "musl" : "glibc") : opencodeReleaseTarget();
    // Paths select a location, never its identity: each process verifies the
    // compiled distribution pin before even requesting an executable version.
    if (options.explicit || options.source === "external") {
      if (!options.allowExternal) throw new Error("External opencode requires --allow-external");
      if (!options.explicit) throw new Error("The selected engine requires an explicit verified artifact path; PATH lookup cannot identify its distribution.");
      const bin = resolveBinPath(options.explicit);
      await verifySelectedOpencodeEngine(bin, { target });
      return { bin, source: "external", expectedVersion };
    }
    const binaryName = target.startsWith("windows-") ? "opencode.exe" : "opencode";
    const bundledDirectories = [
      ...(options.manifest ? [join(options.manifest.dir, "..", "opencode-engine", opencodeEngineSelection.artifactId, target), join(options.manifest.dir, "opencode-engine", opencodeEngineSelection.artifactId, target)] : []),
      join(dirname(process.execPath), "opencode-engine", opencodeEngineSelection.artifactId, target),
    ];
    for (const directory of bundledDirectories) {
      const bin = join(directory, binaryName);
      if (!(await fileExists(bin))) continue;
      await verifySelectedOpencodeEngine(bin, { target });
      return { bin, source: "bundled", expectedVersion };
    }
    if (options.source === "bundled") throw new Error("The selected OpenCode distribution is missing from this bundle; rebuild the sidecars for this target.");
    const installed = await installSelectedOpencodeEngine({
      directory: join(options.sidecar.dir, "opencode", opencodeEngineSelection.artifactId, target),
      cacheDirectory: join(options.sidecar.dir, "opencode-archives"),
      archiveDirectory: process.env.LEGALWORK_OPENCODE_ARCHIVES,
      target,
    });
    return { bin: installed.path, source: "prepared", expectedVersion: installed.version };
  }
  const resolveExternal = async (): Promise<ResolvedBinary> => {
    if (!options.allowExternal) {
      throw new Error("External opencode requires --allow-external");
    }
    if (options.explicit) {
      const resolved = resolveBinPath(options.explicit);
      if (
        (resolved.includes("/") || resolved.startsWith(".")) &&
        !(await fileExists(resolved))
      ) {
        throw new Error(`opencode-bin not found: ${resolved}`);
      }
      return { bin: resolved, source: "external", expectedVersion };
    }
    return { bin: "opencode", source: "external", expectedVersion };
  };

  if (options.source === "bundled") {
    const bundled = await resolveBundledBinary(options.manifest, "opencode");
    if (!bundled) {
      throw new Error(
        "Bundled opencode binary missing. Build with pnpm --filter legalwork-orchestrator build:bin:bundled.",
      );
    }
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.source === "external") {
    return resolveExternal();
  }

  const bundled = await resolveBundledBinary(options.manifest, "opencode");
  if (bundled && !(options.allowExternal && options.explicit)) {
    return { bin: bundled, source: "bundled", expectedVersion };
  }

  if (options.explicit) {
    return resolveExternal();
  }

  if (!options.allowExternal) {
    throw new Error(
      "Bundled OpenCode is missing. Use the normal prepared development entrypoint or an explicit verified local engine; standalone binary downloads are retired.",
    );
  }

  return resolveExternal();
}

function resolveRouterDataDir(flags: Map<string, string | boolean>): string {
  const override = readFlag(flags, "data-dir") ?? process.env.LEGALWORK_DATA_DIR;
  if (override && override.trim()) {
    return resolve(override.trim());
  }
  return join(homedir(), ".legalwork", "legalwork-orchestrator");
}

function resolveInternalDevMode(flags: Map<string, string | boolean>): boolean {
  return readBool(flags, "internal-dev-mode", false, "LEGALWORK_DEV_MODE");
}

function internalDevModeFromEnv(): boolean {
  const value = process.env.LEGALWORK_DEV_MODE?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function resolveOpencodeStateLayout(options: {
  dataDir: string;
  workspace: string;
  devMode: boolean;
}): OpencodeStateLayout {
  if (!options.devMode) {
    return {
      devMode: false,
      rootDir: join(options.dataDir, "opencode-config"),
      configDir: join(options.dataDir, "opencode-config"),
      env: {},
    };
  }

  const rootDir = join(options.dataDir, LEGALWORK_DEV_DATA_DIR);
  const homeDir = join(rootDir, "home");
  const xdgConfigHome = join(rootDir, "xdg", "config");
  const xdgDataHome = join(rootDir, "xdg", "data");
  const xdgCacheHome = join(rootDir, "xdg", "cache");
  const xdgStateHome = join(rootDir, "xdg", "state");
  const configDir = join(rootDir, "config", "opencode");

  return {
    devMode: true,
    rootDir,
    configDir,
    importConfigDir:
      process.env.LEGALWORK_DEV_OPENCODE_IMPORT_CONFIG_DIR?.trim() || undefined,
    importDataDir:
      process.env.LEGALWORK_DEV_OPENCODE_IMPORT_DATA_DIR?.trim() || undefined,
    env: {
      LEGALWORK_DEV_MODE: "1",
      OPENCODE_TEST_HOME: homeDir,
      HOME: homeDir,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_CACHE_HOME: xdgCacheHome,
      XDG_STATE_HOME: xdgStateHome,
      OPENCODE_CONFIG_DIR: configDir,
    },
  };
}

async function ensureOpencodeStateLayout(
  layout: OpencodeStateLayout,
): Promise<void> {
  await mkdir(layout.configDir, { recursive: true });
  if (!layout.devMode) return;

  const homeDir = layout.env.HOME;
  const xdgConfigHome = layout.env.XDG_CONFIG_HOME;
  const xdgDataHome = layout.env.XDG_DATA_HOME;
  const xdgCacheHome = layout.env.XDG_CACHE_HOME;
  const xdgStateHome = layout.env.XDG_STATE_HOME;
  const opencodeDataDir = xdgDataHome
    ? join(xdgDataHome, "opencode")
    : undefined;

  for (const dir of [
    layout.rootDir,
    homeDir,
    xdgConfigHome,
    xdgDataHome,
    xdgCacheHome,
    xdgStateHome,
    opencodeDataDir,
  ]) {
    if (!dir) continue;
    await mkdir(dir, { recursive: true });
  }

  if (layout.importConfigDir && (await isDir(layout.importConfigDir))) {
    const entries = await readdir(layout.configDir).catch(() => [] as string[]);
    if (entries.length === 0) {
      await cp(layout.importConfigDir, layout.configDir, {
        recursive: true,
        force: false,
      }).catch(() => undefined);
    }
  }

  if (
    layout.importDataDir &&
    opencodeDataDir &&
    (await isDir(layout.importDataDir))
  ) {
    for (const file of ["auth.json", "mcp-auth.json"]) {
      const dest = join(opencodeDataDir, file);
      if (await fileExists(dest)) continue;
      const source = join(layout.importDataDir, file);
      if (await fileExists(source)) {
        await copyFile(source, dest).catch(() => undefined);
      }
    }
  }
}

function normalizeWorkspacePath(input: string): string {
  return resolve(input).replace(/[\\/]+$/, "");
}

function workspaceIdForLocal(path: string): string {
  return `ws-${createHash("sha1").update(path).digest("hex").slice(0, 12)}`;
}

function isProcessAlive(pid?: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForHealthy(
  url: string,
  timeoutMs = 10_000,
  pollMs = 250,
): Promise<void> {
  const start = Date.now();
  let lastError: string | null = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`${url.replace(/\/$/, "")}/health`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(lastError ?? "Timed out waiting for health check");
}

async function waitForOpencodeHealthy(
  client: OpenCodeClient,
  timeoutMs = 10_000,
  pollMs = 250,
) {
  const start = Date.now();
  let lastError = "No API response";
  while (Date.now()-start<timeoutMs) {
    try {
      const info=await client.server.info({signal:AbortSignal.timeout(Math.max(1,timeoutMs-(Date.now()-start)))});
      if (!info.version.startsWith("2.")) throw new Error(`OpenCode v2 is required, received ${info.version}`);
      // HTTP startup has a watchdog; converting existing history has no overall deadline.
      while(true){
        const migration=await client.migration.v1.status();
        if(migration.status==="completed")return {healthy:true,version:info.version};
        if(migration.status==="error")throw new Error(`OpenCode history migration failed: ${migration.error}`);
        await new Promise(resolve=>setTimeout(resolve,pollMs));
      }
    } catch(error){lastError=error instanceof Error?error.message:String(error);}
    await new Promise(resolve=>setTimeout(resolve,pollMs));
  }
  throw new Error(lastError);
}

/** The managed server owns the HTTP watchdog; history conversion/recovery has
 * no overall task deadline. Stop waiting when that exact owner process exits. */
async function waitForManagedOpencodeHealthy(client: OpenCodeClient, owner: ChildProcess, serverURL: string): Promise<void> {
  while (owner.exitCode === null && owner.signalCode === null) {
    let version: string;
    let ready = false;
    try {
      version = (await client.server.info({ signal: AbortSignal.timeout(10_000) })).version;
      const health: unknown = await (await fetch(`${serverURL}/health`, { signal: AbortSignal.timeout(10_000) })).json();
      ready = Boolean(health && typeof health === "object" && "engine" in health && health.engine && typeof health.engine === "object" && "status" in health.engine && health.engine.status === "ready");
    }
    catch {
      await new Promise(resolve => setTimeout(resolve, 250));
      continue;
    }
    if (!version.startsWith("2.")) throw new Error(`OpenCode v2 is required, received ${version}`);
    if (ready) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("The managed LegalWork server exited before its native engine became ready.");
}

/**
 * In sandbox mode the released legalwork-server binary may not have our latest
 * token/proxy changes.  Instead of relying on the OpenCode SDK client (which
 * sends Bearer auth that the proxy may not understand yet), we do a simple
 * HTTP fetch through the proxy path.  The server's /opencode/* proxy already
 * forwards to the internal opencode port; we just need to check that it
 * returns a 2xx from /opencode/health (or falls through to opencode's own
 * /health endpoint).
 *
 * We try multiple path patterns because:
 * - `/opencode/health` — most common OpenCode health endpoint proxied by the
 *   server's catch-all /opencode/* route.
 * - `/health` on the legalwork-server itself — already verified by the caller,
 *   but serves as a fallback signal.
 */
async function waitForHealthyViaProxy(
  proxyBaseUrl: string,
  token: string,
  timeoutMs = 10_000,
  pollMs = 250,
): Promise<void> {
  const client=OpenCode.make({baseUrl:proxyBaseUrl,headers:token?{Authorization:`Bearer ${token}`}:{}});
  const healthURL = new URL(proxyBaseUrl);
  if (!/\/opencode\/?$/.test(healthURL.pathname)) throw new Error("The LegalWork engine proxy URL must end in /opencode.");
  healthURL.pathname = healthURL.pathname.replace(/\/opencode\/?$/, "/health"); healthURL.search = ""; healthURL.hash = "";
  while (true) {
    const info = await client.server.info({ signal: AbortSignal.timeout(timeoutMs) });
    if (!info.version.startsWith("2.")) throw new Error(`OpenCode v2 is required, received ${info.version}`);
    const response = await fetch(healthURL, { signal: AbortSignal.timeout(timeoutMs) });
    const health: unknown = await response.json();
    if (!response.ok || !health || typeof health !== "object" || !("engine" in health) || !health.engine || typeof health.engine !== "object" || !("status" in health.engine)) {
      throw new Error("The LegalWork server did not return managed engine readiness. Update the server before attaching its engine.");
    }
    if (health.engine.status === "ready") return;
    // The managed server owns HTTP failure and child-exit watchdogs. Native
    // history preparation has no separate overall deadline here.
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
}

function printHelp(): void {
  const message = [
    "legalwork",
    "",
    "Usage:",
    "  legalwork start [--workspace <path>] [options]",
    "  legalwork serve [--workspace <path>] [options]",
    "  legalwork daemon [stop|status] [--data-dir <path>]",
    "  legalwork approvals list --legalwork-url <url> --host-token <token>",
    "  legalwork approvals reply <id> --allow|--deny --legalwork-url <url> --host-token <token>",
    "  legalwork files <action> [options]",
    "  legalwork status [--legalwork-url <url>] [--opencode-url <url>]",
    "",
    "Commands:",

    "  serve                   Start services and stream logs (no TUI)",
    "  daemon stop|status      Inspect/stop an existing retired developer daemon",
    "  approvals list           List pending approval requests",
    "  approvals reply <id>     Approve or deny a request",
    "  files                   Manage file sessions and batch file sync",
    "  status                  Check OpenCode/LegalWork health",
    "",
    "Options:",
    "  --workspace <path>        Workspace directory (default: cwd)",
    "  --data-dir <path>         Private orchestrator data directory",
    "  --opencode-bin <path>     Path to opencode binary (requires --allow-external)",
    "  --opencode-host <host>    Bind host for opencode serve (loopback only, default: 127.0.0.1)",
    "  --opencode-port <port>    Port for opencode serve (default: random)",
    "  --opencode-log-level <l>  Log level for opencode serve (DEBUG, INFO, WARN, ERROR; default: opencode default)",
    "  --opencode-auth           OpenCode basic auth is always enabled",
    "  --opencode-hot-reload     Enable OpenCode hot reload (default: true)",
    "  --opencode-hot-reload-debounce-ms <ms>  Debounce window for hot reload triggers (default: 700)",
    "  --opencode-hot-reload-cooldown-ms <ms>  Minimum interval between hot reloads (default: 1500)",
    "  --opencode-username <u>   Internal-only override for managed OpenCode auth username",
    "  --opencode-password <p>   Internal-only override for managed OpenCode auth password",
    "  --legalwork-host <host>    Bind host for legalwork-server (default: 127.0.0.1)",
    "  --legalwork-port <port>    Port for legalwork-server (default: 8787)",
    "  --remote-access           Expose LegalWork on 0.0.0.0 for remote sharing",
    "  --legalwork-token <token>  Client token for legalwork-server",
    "  --legalwork-host-token <t> Host token for approvals",
    "  --workspace-id <id>       Workspace id for file session commands",
    "  --session-id <id>         File session id for file session commands",
    "  --path <path>             Workspace-relative file path",
    "  --paths <list>            Comma-separated list of workspace-relative file paths",
    "  --ttl-seconds <n>         File session TTL in seconds",
    "  --content <text>          Inline content for file writes",
    "  --content-base64 <b64>    Base64 content for file writes",
    "  --file <path>             Local file path for file writes",
    "  --if-match <revision>     Revision precondition for file writes",
    "  --from <path>             Source path for rename",
    "  --to <path>               Destination path for rename",
    "  --write                   Request writable file session",
    "  --force                   Force write despite revision mismatch",
    "  --recursive               Recursive delete for files delete",
    "  --approval <mode>         manual | auto (default: manual)",
    "  --approval-timeout <ms>   Approval timeout in ms",
    "  --read-only               Start LegalWork server in read-only mode",
    "  --cors <origins>          Comma-separated CORS origins or *",
    "  --connect-host <host>     Override LAN host used for pairing URLs",
    "  --legalwork-server-bin <p> Path to legalwork-server binary (requires --allow-external)",

    "  --allow-external          Allow external sidecar binaries (dev only, required for custom bins)",
    "  --sidecar-dir <path>      Cache directory for locally prepared sidecars",
    "  --sidecar-source <mode>   auto | bundled | external",
    "  --opencode-source <mode>  auto | bundled | external",
    "  --check                   Run health checks then exit",
    "  --check-events            Verify SSE events during check",
    "  --tui                     Force interactive dashboard (TTY only)",
    "  --no-tui                  Disable interactive dashboard",
    "  --detach                  Detach after start and keep services running",
    "  --sandbox <mode>          none | auto | docker | container (default: none)",
    "  --sandbox-image <ref>     Container image for sandbox mode",
    "  --sandbox-persist-dir <p> Persist dir mounted into sandbox (default: per-workspace)",
    "  --sandbox-mount <specs>   Extra mounts (validated): hostPath:subpath[:ro|rw] (requires allowlist)",
    "  --json                    Output JSON when applicable",
    "  --verbose                 Print additional diagnostics",
    "  --log-format <format>     Log output format: pretty | json",
    "  --color                   Force ANSI color output",
    "  --no-color                Disable ANSI color output",
    "  --run-id <id>             Correlation id for logs (default: random UUID)",
    "  --help                    Show help",
    "  --version                 Show version",
  ].join("\n");
  console.log(message);
}

async function stopChild(
  child: ReturnType<typeof spawn>,
  timeoutMs = 2500,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(resolve, timeoutMs, false)),
  ]);
  if (exited) return;
  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }
  await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(resolve, timeoutMs, false)),
  ]);
}

async function startLegalworkServer(options: {
  bin: string;
  host: string;
  port: number;
  workspace: string;
  token: string;
  hostToken: string;
  approvalMode: ApprovalMode;
  approvalTimeoutMs: number;
  readOnly: boolean;
  corsOrigins: string[];
  opencodeBaseUrl?: string;
  opencodeDirectory?: string;
  opencodeUsername?: string;
  opencodePassword?: string;
  managedOpencode?: {
    bin: string;
    port: number;
    storageDirectory: string;
    pluginDirectories: string[];
    dataHome?: string;
    logLevel?: string;
  };
  controlBaseUrl?: string;
  controlToken?: string;
  logger: Logger;
  runId: string;
  logFormat: LogFormat;
}) {
  const args = [
    "--host",
    options.host,
    "--port",
    String(options.port),
    "--workspace",
    options.workspace,
    "--approval",
    options.approvalMode,
    "--approval-timeout",
    String(options.approvalTimeoutMs),
  ];

  if (options.readOnly) {
    args.push("--read-only");
  }

  if (options.corsOrigins.length) {
    args.push("--cors", options.corsOrigins.join(","));
  }

  if (options.opencodeBaseUrl) {
    args.push("--opencode-base-url", options.opencodeBaseUrl);
  }
  if (options.opencodeDirectory) {
    args.push("--opencode-directory", options.opencodeDirectory);
  }
  if (options.logFormat) {
    args.push("--log-format", options.logFormat);
  }

  const resolved = resolveBinCommand(options.bin);
  const child = spawnProcess(
    resolved.command,
    [...resolved.prefixArgs, ...args],
    {
      cwd: options.workspace,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(options.managedOpencode ? {
          LEGALWORK_MANAGE_OPENCODE: "1",
          LEGALWORK_MANAGED_OPENCODE_SANDBOX: "0",
          LEGALWORK_OPENCODE_BIN: options.managedOpencode.bin,
          LEGALWORK_MANAGED_OPENCODE_PORT: String(options.managedOpencode.port),
          LEGALWORK_ENGINE_STORAGE_DIR: options.managedOpencode.storageDirectory,
          LEGALWORK_ENGINE_PLUGIN_DIRECTORIES: JSON.stringify(options.managedOpencode.pluginDirectories),
          ...(options.managedOpencode.dataHome ? { LEGALWORK_ENGINE_DATA_HOME: options.managedOpencode.dataHome } : {}),
          ...(options.managedOpencode.logLevel ? { LEGALWORK_MANAGED_OPENCODE_LOG_LEVEL: options.managedOpencode.logLevel } : {}),
          // The server owns a fresh authenticated native endpoint. An inherited
          // attach target must not silently bypass its managed lifecycle.
          LEGALWORK_OPENCODE_BASE_URL: "",
          LEGALWORK_OPENCODE_USERNAME: "",
          LEGALWORK_OPENCODE_PASSWORD: "",
        } : {}),
        LEGALWORK_TOKEN: options.token,
        LEGALWORK_HOST_TOKEN: options.hostToken,
        LEGALWORK_RUN_ID: options.runId,
        LEGALWORK_LOG_FORMAT: options.logFormat,
        OTEL_RESOURCE_ATTRIBUTES: mergeResourceAttributes(
          {
            "service.name": "legalwork-server",
            "service.instance.id": options.runId,
          },
          process.env.OTEL_RESOURCE_ATTRIBUTES,
        ),

        ...(options.opencodeBaseUrl
          ? { LEGALWORK_OPENCODE_BASE_URL: options.opencodeBaseUrl }
          : {}),
        ...(options.opencodeDirectory
          ? { LEGALWORK_OPENCODE_DIRECTORY: options.opencodeDirectory }
          : {}),
        ...(options.opencodeUsername
          ? { LEGALWORK_OPENCODE_USERNAME: options.opencodeUsername }
          : {}),
        ...(options.opencodePassword
          ? { LEGALWORK_OPENCODE_PASSWORD: options.opencodePassword }
          : {}),
        ...(options.controlBaseUrl
          ? { LEGALWORK_CONTROL_BASE_URL: options.controlBaseUrl }
          : {}),
        ...(options.controlToken
          ? { LEGALWORK_CONTROL_TOKEN: options.controlToken }
          : {}),
      },
    },
  );

  prefixStream(
    child.stdout,
    "legalwork-server",
    "stdout",
    options.logger,
    child.pid ?? undefined,
  );
  prefixStream(
    child.stderr,
    "legalwork-server",
    "stderr",
    options.logger,
    child.pid ?? undefined,
  );

  return child;
}

async function stopDockerContainer(
  name: string,
  dockerCommand: string,
): Promise<void> {
  if (!name.trim()) return;
  await new Promise<void>((resolve) => {
    const child = spawnProcess(dockerCommand, ["stop", name], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
}

async function stopAppleContainer(name: string): Promise<void> {
  if (!name.trim()) return;
  await new Promise<void>((resolve) => {
    const child = spawnProcess("container", ["stop", name], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("error", () => resolve());
    child.on("exit", () => resolve());
  });
}

async function runQuiet(
  command: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<void> {
  const child = spawnProcess(command, args, {
    stdio: ["ignore", "ignore", "ignore"],
  });
  type QuietResult =
    | { type: "exit"; code: number | null }
    | { type: "error"; error: unknown }
    | { type: "timeout" };

  const result = await Promise.race<QuietResult>([
    once(child, "exit").then(([code]) => ({
      type: "exit" as const,
      code: (code ?? null) as number | null,
    })),
    once(child, "error").then(([error]) => ({ type: "error" as const, error })),
    new Promise<QuietResult>((resolve) =>
      setTimeout(resolve, timeoutMs, { type: "timeout" as const }),
    ),
  ]);
  if (result.type === "timeout") {
    try {
      child.kill("SIGKILL");
    } catch {
      // ignore
    }
    throw new Error(`Command timed out: ${command} ${args.join(" ")}`);
  }
  if (result.type === "error") {
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}: ${String(result.error)}`,
    );
  }
  if (result.code !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

async function ensureAppleContainerSystemReady(): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("Apple container backend is only supported on macOS");
  }
  if (process.arch !== "arm64") {
    throw new Error("Apple container backend requires Apple silicon (arm64)");
  }
  if (!(await probeCommand("container", ["--version"]))) {
    throw new Error(
      "Apple container CLI not found. Install https://github.com/apple/container",
    );
  }
  // Best-effort: start the background system service.
  try {
    await runQuiet("container", ["system", "start"], 90_000);
  } catch {
    // Ignore; older versions may not require an explicit start.
  }
}

async function stageSandboxRuntime(options: {
  persistDir: string;
  containerName: string;
  sidecars: {
    opencode: string;
    legalworkServer: string;

  };
  detach: boolean;
}): Promise<{
  baseDir: string;
  rootInContainer: string;
  opencodeBinInContainer: string;
  entrypointHostPath: string;
  cleanup: () => Promise<void>;
}> {
  const baseDir = join(
    options.persistDir,
    "legalwork-orchestrator-sandbox",
    options.containerName,
  );
  await mkdir(baseDir, { recursive: true });

  const sidecarsDir = join(baseDir, "sidecars");
  await mkdir(sidecarsDir, { recursive: true });
  const entrypointHostPath = join(baseDir, "entrypoint.sh");

  const rootInContainer = `/persist/legalwork-orchestrator-sandbox/${options.containerName}`;
  let stagedOpencode = join(sidecarsDir, "opencode");
  if (opencodeEngineSelection.kind === "derivative") {
    const target = opencodeReleaseTarget("linux", process.arch);
    stagedOpencode = await stageSelectedOpencodeEngine({
      binary: options.sidecars.opencode,
      directory: join(baseDir, "opencode-engine", opencodeEngineSelection.artifactId, target),
      target,
    });
  } else {
    await copyFile(options.sidecars.opencode, stagedOpencode);
  }
  const opencodeBinInContainer = `${rootInContainer}/${relative(baseDir, stagedOpencode).split(sep).join("/")}`;
  const stagedLegalwork = join(sidecarsDir, "legalwork-server");
  await copyFile(options.sidecars.legalworkServer, stagedLegalwork);
  await ensureExecutable(stagedOpencode);
  await ensureExecutable(stagedLegalwork);

  const cleanup = async () => {
    if (options.detach) return;
    try {
      await rm(baseDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { baseDir, rootInContainer, opencodeBinInContainer, entrypointHostPath, cleanup };
}

async function writeSandboxEntrypoint(options: {
  entrypointHostPath: string;
  rootInContainer: string;
  opencodeBinInContainer: string;
  opencodeConfigDirInContainer: string;
  backend: "docker" | "container";
  opencode: {
    corsOrigins: string[];
    username?: string;
    password?: string;
    hotReload: OpencodeHotReload;
    logLevel?: string;
  };
  legalwork: {
    token: string;
    hostToken: string;
    approvalMode: ApprovalMode;
    approvalTimeoutMs: number;
    readOnly: boolean;
    corsOrigins: string[];
    opencodeUsername?: string;
    opencodePassword?: string;
    logFormat: LogFormat;

  };
  runId: string;
  logFormat: LogFormat;
}): Promise<void> {
  const opencodeBin = options.opencodeBinInContainer;
  const legalworkBin = `${options.rootInContainer}/sidecars/legalwork-server`;

  const workspaceDir = "/workspace";
  const opencodeConfigDir = options.opencodeConfigDirInContainer;
  const hostOpencodeConfigDir = SANDBOX_OPENCODE_GLOBAL_CONFIG_CONTAINER_PATH;
  const hostOpencodeDataDir =
    SANDBOX_OPENCODE_GLOBAL_DATA_IMPORT_CONTAINER_PATH;

  const opencodeCors = options.opencode.corsOrigins
    .map((origin) => `--cors ${shQuote(origin)}`)
    .join(" ");

  const opencodeLogLevelArg = options.opencode.logLevel
    ? `--log-level ${shQuote(options.opencode.logLevel)}`
    : "";

  const legalworkCors = options.legalwork.corsOrigins.length
    ? `--cors ${shQuote(options.legalwork.corsOrigins.join(","))}`
    : "";

  const requiredSecretEnv = [
    ': "${LEGALWORK_TOKEN:?LEGALWORK_TOKEN is required}"',
    ': "${LEGALWORK_HOST_TOKEN:?LEGALWORK_HOST_TOKEN is required}"',
  ].join("\n");

  const legalworkDevMode = (process.env.LEGALWORK_DEV_MODE ?? "").trim() === "1";
  const sandboxHomeDir = legalworkDevMode ? "/persist/legalwork-dev-data/home" : "/persist";

  const script = [
    "set -eu",
    `export HOME=${shQuote(sandboxHomeDir)}`,
    `export OPENCODE_TEST_HOME=${shQuote(sandboxHomeDir)}`,
    'export XDG_CONFIG_HOME="$HOME/.config"',
    'export XDG_CACHE_HOME="$HOME/.cache"',
    'export XDG_DATA_HOME="$HOME/.local/share"',
    'export XDG_STATE_HOME="$HOME/.local/state"',
    `export PATH=${shQuote(`${options.rootInContainer}/sidecars`)}:"\${PATH:-}"`,
    'mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"',
    // Do not `cd` into the mounted workspace: bun-compiled sidecars read bunfig.toml
    // from cwd, and user workspaces may include preloads that break startup.
    `cd ${shQuote("/persist")}`,
    `export OPENCODE_DIRECTORY=${shQuote(workspaceDir)}`,
    `export OPENCODE_CONFIG_DIR=${shQuote(opencodeConfigDir)}`,
    `mkdir -p ${shQuote(opencodeConfigDir)}`,
    `if [ -d ${shQuote(hostOpencodeConfigDir)} ]; then cp -R ${shQuote(`${hostOpencodeConfigDir}/.`)} ${shQuote(opencodeConfigDir)} 2>/dev/null || true; fi`,
    'mkdir -p "$XDG_DATA_HOME/opencode"',
    `if [ -d ${shQuote(hostOpencodeDataDir)} ]; then cp ${shQuote(`${hostOpencodeDataDir}/auth.json`)} \"$XDG_DATA_HOME/opencode/auth.json\" 2>/dev/null || true; cp ${shQuote(`${hostOpencodeDataDir}/mcp-auth.json`)} \"$XDG_DATA_HOME/opencode/mcp-auth.json\" 2>/dev/null || true; fi`,
    `export OPENCODE_URL=${shQuote(`http://127.0.0.1:${SANDBOX_INTERNAL_LEGALWORK_PORT}/opencode`)}`,
    'export OPENCODE_BEARER_TOKEN="$LEGALWORK_TOKEN"',
    "export LEGALWORK_MANAGE_OPENCODE=1",
    "export LEGALWORK_MANAGED_OPENCODE_SANDBOX=0",
    `export LEGALWORK_OPENCODE_BIN=${shQuote(opencodeBin)}`,
    `export LEGALWORK_MANAGED_OPENCODE_PORT=${shQuote(String(SANDBOX_INTERNAL_OPENCODE_PORT))}`,
    `export LEGALWORK_ENGINE_STORAGE_DIR=${shQuote("/persist/managed-engine-v2")}`,
    "export LEGALWORK_ENGINE_PLUGIN_DIRECTORIES='[]'",
    "export LEGALWORK_OPENCODE_BASE_URL=''",
    "export LEGALWORK_OPENCODE_USERNAME=''",
    "export LEGALWORK_OPENCODE_PASSWORD=''",
    ...(options.opencode.logLevel ? [`export LEGALWORK_MANAGED_OPENCODE_LOG_LEVEL=${shQuote(options.opencode.logLevel)}`] : []),
    `export LEGALWORK=1`,
    `export LEGALWORK_DEV_MODE=${shQuote(legalworkDevMode ? "1" : "0")}`,
    `export LEGALWORK_RUN_ID=${shQuote(options.runId)}`,
    `export LEGALWORK_LOG_FORMAT=${shQuote(options.logFormat)}`,
    `export LEGALWORK_SANDBOX_ENABLED=1`,
    `export LEGALWORK_SANDBOX_BACKEND=${shQuote(options.backend)}`,

    requiredSecretEnv,
    `exec ${shQuote(legalworkBin)} --host 0.0.0.0 --port ${shQuote(String(SANDBOX_INTERNAL_LEGALWORK_PORT))}` +
      ` --workspace ${shQuote(workspaceDir)}` +
      ` --approval ${shQuote(options.legalwork.approvalMode)}` +
      ` --approval-timeout ${shQuote(String(options.legalwork.approvalTimeoutMs))}` +
      (options.legalwork.readOnly ? " --read-only" : "") +
      ` --log-format ${shQuote(options.legalwork.logFormat)}` +
      (legalworkCors ? ` ${legalworkCors}` : ""),
  ]
    .filter(Boolean)
    .join("\n");

  await writeFile(options.entrypointHostPath, `${script}\n`, "utf8");
}

async function startDockerSandbox(options: {
  image: string;
  dockerCommand: string;
  containerName: string;
  workspace: string;
  persistDir: string;
  opencodeConfigDir: string;
  extraMounts: SandboxMount[];
  sidecars: {
    opencode: string;
    legalworkServer: string;

  };
  ports: { legalwork: number };
  opencode: {
    corsOrigins: string[];
    username?: string;
    password?: string;
    hotReload: OpencodeHotReload;
    logLevel?: string;
  };
  legalwork: {
    token: string;
    hostToken: string;
    approvalMode: ApprovalMode;
    approvalTimeoutMs: number;
    readOnly: boolean;
    corsOrigins: string[];
    opencodeUsername?: string;
    opencodePassword?: string;
    logFormat: LogFormat;
  };
  runId: string;
  logFormat: LogFormat;
  detach: boolean;
  logger: Logger;
}): Promise<{ child: ReturnType<typeof spawn>; cleanup: () => Promise<void> }> {
  const staged = await stageSandboxRuntime({
    persistDir: options.persistDir,
    containerName: options.containerName,
    sidecars: options.sidecars,
    detach: options.detach,
  });

  await writeSandboxEntrypoint({
    entrypointHostPath: staged.entrypointHostPath,
    rootInContainer: staged.rootInContainer,
    opencodeBinInContainer: staged.opencodeBinInContainer,
    opencodeConfigDirInContainer: "/opencode-config",
    backend: "docker",
    opencode: options.opencode,
    legalwork: {
      token: options.legalwork.token,
      hostToken: options.legalwork.hostToken,
      approvalMode: options.legalwork.approvalMode,
      approvalTimeoutMs: options.legalwork.approvalTimeoutMs,
      readOnly: options.legalwork.readOnly,
      corsOrigins: options.legalwork.corsOrigins,
      opencodeUsername: options.legalwork.opencodeUsername,
      opencodePassword: options.legalwork.opencodePassword,
      logFormat: options.legalwork.logFormat,

    },
    runId: options.runId,
    logFormat: options.logFormat,
  });

  const args: string[] = [
    "run",
    "--rm",
    "--name",
    options.containerName,
    "-p",
    `127.0.0.1:${options.ports.legalwork}:${SANDBOX_INTERNAL_LEGALWORK_PORT}`,
    "-v",
    `${options.workspace}:/workspace`,
    "-v",
    `${options.persistDir}:/persist`,
    "-v",
    `${options.opencodeConfigDir}:/opencode-config`,
  ];

  const hostOpencodeConfig = await resolveHostOpencodeGlobalConfigDir();
  const hasOpencodeConfigMount = options.extraMounts.some(
    (mount) =>
      mount.containerPath === SANDBOX_OPENCODE_GLOBAL_CONFIG_CONTAINER_PATH,
  );
  if (hostOpencodeConfig && !hasOpencodeConfigMount) {
    args.push(
      "-v",
      `${hostOpencodeConfig}:${SANDBOX_OPENCODE_GLOBAL_CONFIG_CONTAINER_PATH}:ro`,
    );
    options.logger.debug("sandbox: mounted host opencode config", {
      hostPath: hostOpencodeConfig,
      containerPath: SANDBOX_OPENCODE_GLOBAL_CONFIG_CONTAINER_PATH,
    });
  }

  const hostOpencodeData = await resolveHostOpencodeGlobalDataDir();
  const hasOpencodeDataMount = options.extraMounts.some(
    (mount) =>
      mount.containerPath ===
      SANDBOX_OPENCODE_GLOBAL_DATA_IMPORT_CONTAINER_PATH,
  );
  if (hostOpencodeData && !hasOpencodeDataMount) {
    args.push(
      "-v",
      `${hostOpencodeData}:${SANDBOX_OPENCODE_GLOBAL_DATA_IMPORT_CONTAINER_PATH}:ro`,
    );
    options.logger.debug("sandbox: mounted host opencode data", {
      hostPath: hostOpencodeData,
      containerPath: SANDBOX_OPENCODE_GLOBAL_DATA_IMPORT_CONTAINER_PATH,
    });
  }

  const userEnv = loadUserEnvFile();
  addEnvPassThroughArgs(args, sandboxEnvPassThroughNames(userEnv));

  for (const mount of options.extraMounts) {
    const suffix = mount.readonly ? ":ro" : "";
    args.push("-v", `${mount.hostPath}:${mount.containerPath}${suffix}`);
  }

  if (options.detach) {
    args.push("-d");
  }

  const scriptInContainer = `${staged.rootInContainer}/entrypoint.sh`;
  args.push(options.image, "sh", scriptInContainer);

  options.logger.debug("sandbox: docker run", {
    dockerCommand: options.dockerCommand,
    args,
    containerName: options.containerName,
    workspace: options.workspace,
    persistDir: options.persistDir,
  });

  const child = spawnProcess(options.dockerCommand, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...userEnv,
      ...process.env,
      LEGALWORK_TOKEN: options.legalwork.token,
      LEGALWORK_HOST_TOKEN: options.legalwork.hostToken,
      ...(options.opencode.username
        ? { OPENCODE_SERVER_USERNAME: options.opencode.username }
        : {}),
      ...(options.opencode.password
        ? { OPENCODE_SERVER_PASSWORD: options.opencode.password }
        : {}),
      ...(options.legalwork.opencodeUsername
        ? { LEGALWORK_OPENCODE_USERNAME: options.legalwork.opencodeUsername }
        : {}),
      ...(options.legalwork.opencodePassword
        ? { LEGALWORK_OPENCODE_PASSWORD: options.legalwork.opencodePassword }
        : {}),
    },
  });
  prefixStream(
    child.stdout,
    "sandbox",
    "stdout",
    options.logger,
    child.pid ?? undefined,
  );
  prefixStream(
    child.stderr,
    "sandbox",
    "stderr",
    options.logger,
    child.pid ?? undefined,
  );

  return { child, cleanup: staged.cleanup };
}

async function startAppleContainerSandbox(options: {
  image: string;
  containerName: string;
  workspace: string;
  persistDir: string;
  opencodeConfigDir: string;
  extraMounts: SandboxMount[];
  sidecars: {
    opencode: string;
    legalworkServer: string;

  };
  ports: { legalwork: number };
  opencode: {
    corsOrigins: string[];
    username?: string;
    password?: string;
    hotReload: OpencodeHotReload;
    logLevel?: string;
  };
  legalwork: {
    token: string;
    hostToken: string;
    approvalMode: ApprovalMode;
    approvalTimeoutMs: number;
    readOnly: boolean;
    corsOrigins: string[];
    opencodeUsername?: string;
    opencodePassword?: string;
    logFormat: LogFormat;
  };
  runId: string;
  logFormat: LogFormat;
  detach: boolean;
  logger: Logger;
}): Promise<{ child: ReturnType<typeof spawn>; cleanup: () => Promise<void> }> {
  await ensureAppleContainerSystemReady();

  const staged = await stageSandboxRuntime({
    persistDir: options.persistDir,
    containerName: options.containerName,
    sidecars: options.sidecars,
    detach: options.detach,
  });

  await writeSandboxEntrypoint({
    entrypointHostPath: staged.entrypointHostPath,
    rootInContainer: staged.rootInContainer,
    opencodeBinInContainer: staged.opencodeBinInContainer,
    opencodeConfigDirInContainer: "/opencode-config",
    backend: "container",
    opencode: options.opencode,
    legalwork: {
      token: options.legalwork.token,
      hostToken: options.legalwork.hostToken,
      approvalMode: options.legalwork.approvalMode,
      approvalTimeoutMs: options.legalwork.approvalTimeoutMs,
      readOnly: options.legalwork.readOnly,
      corsOrigins: options.legalwork.corsOrigins,
      opencodeUsername: options.legalwork.opencodeUsername,
      opencodePassword: options.legalwork.opencodePassword,
      logFormat: options.legalwork.logFormat,

    },
    runId: options.runId,
    logFormat: options.logFormat,
  });

  const args: string[] = [
    "run",
    "--rm",
    "--name",
    options.containerName,
    "-p",
    `127.0.0.1:${options.ports.legalwork}:${SANDBOX_INTERNAL_LEGALWORK_PORT}`,
    "-v",
    `${options.workspace}:/workspace`,
    "-v",
    `${options.persistDir}:/persist`,
    "-v",
    `${options.opencodeConfigDir}:/opencode-config`,
  ];

  const hostOpencodeConfig = await resolveHostOpencodeGlobalConfigDir();
  const hasOpencodeConfigMount = options.extraMounts.some(
    (mount) =>
      mount.containerPath === SANDBOX_OPENCODE_GLOBAL_CONFIG_CONTAINER_PATH,
  );
  if (hostOpencodeConfig && !hasOpencodeConfigMount) {
    args.push(
      "--mount",
      `type=bind,source=${hostOpencodeConfig},target=${SANDBOX_OPENCODE_GLOBAL_CONFIG_CONTAINER_PATH},readonly`,
    );
    options.logger.debug("sandbox: mounted host opencode config", {
      hostPath: hostOpencodeConfig,
      containerPath: SANDBOX_OPENCODE_GLOBAL_CONFIG_CONTAINER_PATH,
    });
  }

  const hostOpencodeData = await resolveHostOpencodeGlobalDataDir();
  const hasOpencodeDataMount = options.extraMounts.some(
    (mount) =>
      mount.containerPath ===
      SANDBOX_OPENCODE_GLOBAL_DATA_IMPORT_CONTAINER_PATH,
  );
  if (hostOpencodeData && !hasOpencodeDataMount) {
    args.push(
      "--mount",
      `type=bind,source=${hostOpencodeData},target=${SANDBOX_OPENCODE_GLOBAL_DATA_IMPORT_CONTAINER_PATH},readonly`,
    );
    options.logger.debug("sandbox: mounted host opencode data", {
      hostPath: hostOpencodeData,
      containerPath: SANDBOX_OPENCODE_GLOBAL_DATA_IMPORT_CONTAINER_PATH,
    });
  }

  const userEnv = loadUserEnvFile();
  addEnvPassThroughArgs(args, sandboxEnvPassThroughNames(userEnv));

  for (const mount of options.extraMounts) {
    if (mount.readonly) {
      args.push(
        "--mount",
        `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`,
      );
    } else {
      args.push("-v", `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  if (options.detach) {
    args.push("-d");
  }

  const scriptInContainer = `${staged.rootInContainer}/entrypoint.sh`;
  args.push(options.image, "sh", scriptInContainer);

  const child = spawnProcess("container", args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...userEnv,
      ...process.env,
      LEGALWORK_TOKEN: options.legalwork.token,
      LEGALWORK_HOST_TOKEN: options.legalwork.hostToken,
      ...(options.opencode.username
        ? { OPENCODE_SERVER_USERNAME: options.opencode.username }
        : {}),
      ...(options.opencode.password
        ? { OPENCODE_SERVER_PASSWORD: options.opencode.password }
        : {}),
      ...(options.legalwork.opencodeUsername
        ? { LEGALWORK_OPENCODE_USERNAME: options.legalwork.opencodeUsername }
        : {}),
      ...(options.legalwork.opencodePassword
        ? { LEGALWORK_OPENCODE_PASSWORD: options.legalwork.opencodePassword }
        : {}),
    },
  });
  prefixStream(
    child.stdout,
    "sandbox",
    "stdout",
    options.logger,
    child.pid ?? undefined,
  );
  prefixStream(
    child.stderr,
    "sandbox",
    "stderr",
    options.logger,
    child.pid ?? undefined,
  );

  return { child, cleanup: staged.cleanup };
}

async function verifyOpencodeVersion(
  binary: ResolvedBinary,
): Promise<string | undefined> {
  const expectedVersion = await expectedOpencodeVersion(binary.bin);
  const actual = await readCliVersion(binary.bin);
  assertVersionMatch("opencode", expectedVersion, actual, binary.bin);
  return actual;
}

async function verifyLegalworkServer(input: {
  baseUrl: string;
  token: string;
  hostToken: string;
  expectedVersion?: string;
  expectedWorkspace: string;
  expectedOpencodeBaseUrl?: string;
  expectedOpencodeDirectory?: string;
  expectedOpencodeUsername?: string;
  expectedOpencodePassword?: string;
}): Promise<string | undefined> {
  const health = await fetchJson(`${input.baseUrl}/health`);
  const actualVersion =
    typeof health?.version === "string" ? health.version : undefined;
  assertVersionMatch(
    "legalwork-server",
    input.expectedVersion,
    actualVersion,
    `${input.baseUrl}/health`,
  );

  const headers = { Authorization: `Bearer ${input.token}` };
  const workspaces = await fetchJson(`${input.baseUrl}/workspaces`, {
    headers,
  });
  const items = Array.isArray(workspaces?.items)
    ? (workspaces.items as Array<Record<string, unknown>>)
    : [];
  if (!items.length) {
    throw new Error("LegalWork server returned no workspaces");
  }

  const expectedPath = normalizeWorkspacePath(input.expectedWorkspace);
  const matched = items.find((item) => {
    const candidate = item as { path?: string };
    const path = typeof candidate.path === "string" ? candidate.path : "";
    return path && normalizeWorkspacePath(path) === expectedPath;
  }) as
    | {
        id?: string;
        path?: string;
        opencode?: {
          baseUrl?: string;
          directory?: string;
          username?: string;
          password?: string;
        };
      }
    | undefined;

  if (!matched) {
    throw new Error(
      `LegalWork server workspace mismatch. Expected ${expectedPath}.`,
    );
  }

  const opencode = matched.opencode;
  if (
    input.expectedOpencodeBaseUrl &&
    opencode?.baseUrl !== input.expectedOpencodeBaseUrl
  ) {
    throw new Error(
      `LegalWork server OpenCode base URL mismatch: expected ${input.expectedOpencodeBaseUrl}, got ${opencode?.baseUrl ?? "<missing>"}.`,
    );
  }
  if (
    input.expectedOpencodeDirectory &&
    opencode?.directory !== input.expectedOpencodeDirectory
  ) {
    throw new Error(
      `LegalWork server OpenCode directory mismatch: expected ${input.expectedOpencodeDirectory}, got ${opencode?.directory ?? "<missing>"}.`,
    );
  }
  if (
    input.expectedOpencodeUsername &&
    opencode?.username !== input.expectedOpencodeUsername
  ) {
    throw new Error("LegalWork server OpenCode username mismatch.");
  }
  if (
    input.expectedOpencodePassword &&
    opencode?.password !== input.expectedOpencodePassword
  ) {
    throw new Error("LegalWork server OpenCode password mismatch.");
  }

  const hostHeaders = { "X-LegalWork-Host-Token": input.hostToken };
  await fetchJson(`${input.baseUrl}/approvals`, { headers: hostHeaders });

  return actualVersion;
}

async function installGlobalPackages(packages: string[]): Promise<void> {
  if (!packages.length) return;
  await captureCommandOutput("npm", ["install", "-g", ...packages], {
    timeoutMs: 5 * 60_000,
  });
}

function buildRuntimeServiceSnapshot(input: {
  name: RuntimeServiceName;
  enabled: boolean;
  running: boolean;
  binary?: ResolvedBinary | null;
  actualVersion?: string;
}): RuntimeServiceSnapshot {
  const targetVersion = input.binary?.expectedVersion;
  const actualVersion = input.actualVersion;
  return {
    name: input.name,
    enabled: input.enabled,
    running: input.enabled ? input.running : false,
    source: input.binary?.source,
    path: input.binary?.bin,
    targetVersion,
    actualVersion,
    upgradeAvailable: Boolean(
      input.enabled &&
      targetVersion &&
      actualVersion &&
      targetVersion !== actualVersion,
    ),
  };
}

async function runChecks(input: {
  opencodeClient: OpenCodeClient;
  legalworkUrl: string;
  legalworkToken: string;
  hostToken: string;
  checkEvents: boolean;
  directory: string;
}) {
  const baseUrl = input.legalworkUrl.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${input.legalworkToken}` };
  const hostHeaders = { "X-LegalWork-Host-Token": input.hostToken };
  const workspaces = await fetchJson(`${baseUrl}/workspaces`, { headers });
  if (!workspaces?.items?.length) {
    throw new Error("LegalWork server returned no workspaces");
  }

  const workspaceId = workspaces.items[0].id as string;
  await fetchJson(`${baseUrl}/workspace/${workspaceId}/config`, { headers });

  const created = await input.opencodeClient.session.create({
    title: "LegalWork headless check",
    location: {directory:input.directory},
  });
  const createdSession = created;
  await input.opencodeClient.message.list({sessionID:createdSession.id});

  if (input.checkEvents) {
    const events: { type: string }[] = [];
    const controller = new AbortController();
    const subscription = input.opencodeClient.event.subscribe({signal:controller.signal});
    const reader = (async () => {
      try {
        for await (const raw of subscription) {
          const normalized = normalizeEvent(raw);
          if (!normalized) continue;
          events.push(normalized);
          if (events.length >= 10) break;
        }
      } catch {
        // ignore
      }
    })();

    await input.opencodeClient.session.create({title:"LegalWork headless check events",location:{directory:input.directory}});
    await new Promise((resolve) => setTimeout(resolve, 1200));
    controller.abort();
    await Promise.race([
      reader,
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);

    if (!events.length) {
      throw new Error("No SSE events observed during check");
    }
  }
}

/**
 * Lighter check suite for sandbox mode.  Uses only raw HTTP against the
 * legalwork-server endpoints — no OpenCode SDK calls that rely on Bearer
 * auth through the proxy (since the released server binary may predate our
 * token/proxy changes).
 */
async function runSandboxChecks(input: {
  legalworkUrl: string;
  legalworkToken: string;
  hostToken: string;
}) {
  const baseUrl = input.legalworkUrl.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${input.legalworkToken}` };
  const hostHeaders = { "X-LegalWork-Host-Token": input.hostToken };

  // 1. Server health
  const health = await fetchJson(`${baseUrl}/health`);
  if (!health || typeof health !== "object") {
    throw new Error("legalwork-server /health returned invalid payload");
  }

  // 2. Workspaces list
  const workspaces = await fetchJson(`${baseUrl}/workspaces`, { headers });
  if (!workspaces?.items?.length) {
    throw new Error("legalwork-server returned no workspaces");
  }
  const workspaceId = workspaces.items[0].id as string;

  // 3. Workspace config
  await fetchJson(`${baseUrl}/workspace/${workspaceId}/config`, { headers });

  // 4. Approvals endpoint (host auth)
  await fetchJson(`${baseUrl}/approvals`, { headers: hostHeaders });

  // Authenticated native API readiness; a 4xx is never evidence of a usable engine.
  await waitForHealthyViaProxy(`${baseUrl}/opencode`,input.legalworkToken);

}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  let payload: any = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const message = payload?.message ? ` ${payload.message}` : "";
    throw new Error(`HTTP ${response.status}${message}`);
  }
  return payload;
}

function normalizeEvent(raw: unknown): { type: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.type === "string") return { type: record.type };
  const payload = record.payload as Record<string, unknown> | undefined;
  if (payload && typeof payload.type === "string")
    return { type: payload.type };
  return null;
}

function outputResult(payload: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (typeof payload === "string") {
    console.log(payload);
    return;
  }
  console.log(JSON.stringify(payload, null, 2));
}

function outputError(error: unknown, json: boolean): void {
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    return;
  }
  console.error(message);
}

function createVerboseLogger(
  enabled: boolean,
  logger?: Logger,
  component = "legalwork-orchestrator",
) {
  return (message: string) => {
    if (!enabled) return;
    if (logger) {
      logger.debug(message, undefined, component);
      return;
    }
    console.log(`[${component}] ${message}`);
  };
}

const LOG_LEVEL_NUMBERS: Record<LogLevel, number> = {
  debug: 5,
  info: 9,
  warn: 13,
  error: 17,
};

const ANSI = {
  reset: "\x1b[0m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

function colorize(input: string, color: string, enabled: boolean): string {
  if (!enabled) return input;
  return `${color}${input}${ANSI.reset}`;
}

function toUnixNano(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function mergeResourceAttributes(
  additional: Record<string, string>,
  existing?: string,
): string {
  const entries = new Map<string, string>();
  if (existing) {
    for (const part of existing.split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const [key, ...rest] = trimmed.split("=");
      if (!key || rest.length === 0) continue;
      entries.set(key, rest.join("=").replace(/,/g, ";"));
    }
  }
  for (const [key, value] of Object.entries(additional)) {
    if (!key) continue;
    if (value === undefined || value === null) continue;
    entries.set(key, String(value).replace(/,/g, ";"));
  }
  return Array.from(entries.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

const REDACTED_LOG_VALUE = "[REDACTED]";

const SENSITIVE_FLAG_NAMES = [
  "--token",
  "--host-token",
  "--legalwork-token",
  "--legalwork-host-token",
  "--opencode-password",
  "--opencode-username",
];

const SENSITIVE_ATTRIBUTE_KEYS = new Set([
  "token",
  "hosttoken",
  "ownertoken",
  "collaboratortoken",
  "controltoken",
  "authorization",
  "password",
  "opencodepassword",
  "opencodeusername",
  "bottoken",
  "apptoken",
]);

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSensitiveAttributeKey(key?: string): boolean {
  const trimmed = key?.trim() ?? "";
  if (!trimmed) return false;
  const normalized = trimmed.toLowerCase();
  if (SENSITIVE_ATTRIBUTE_KEYS.has(normalized)) return true;
  return (
    (trimmed.startsWith("LEGALWORK_") ||
      trimmed.startsWith("OPENCODE_") ||
      trimmed.startsWith("DEN_")) &&
    /TOKEN|PASSWORD|USERNAME|AUTHORIZATION/.test(trimmed)
  );
}

function redactSensitiveString(input: string): string {
  let redacted = input;
  redacted = redacted.replace(/\b(Bearer)\s+[^\s"']+/gi, "$1 [REDACTED]");
  redacted = redacted.replace(/\b(Basic)\s+[A-Za-z0-9+/=]+/g, "$1 [REDACTED]");
  redacted = redacted.replace(
    /((?:LEGALWORK|OPENCODE|DEN)_[A-Z0-9_]*(?:TOKEN|PASSWORD|USERNAME|AUTHORIZATION)[A-Z0-9_]*=)([^\s]+)/g,
    `$1${REDACTED_LOG_VALUE}`,
  );
  redacted = redacted.replace(
    /("?(?:token|hostToken|ownerToken|collaboratorToken|controlToken|password|authorization|opencodePassword|opencodeUsername|botToken|appToken)"?\s*[:=]\s*")([^"]*)(")/g,
    `$1${REDACTED_LOG_VALUE}$3`,
  );
  redacted = redacted.replace(
    /("?(?:token|hostToken|ownerToken|collaboratorToken|controlToken|password|authorization|opencodePassword|opencodeUsername|botToken|appToken)"?\s*[:=]\s*)([^,\s}]+)/g,
    `$1${REDACTED_LOG_VALUE}`,
  );
  for (const flag of SENSITIVE_FLAG_NAMES) {
    redacted = redacted.replace(
      new RegExp(`(${escapeRegExp(flag)}\\s+)([^\\s]+)`, "g"),
      `$1${REDACTED_LOG_VALUE}`,
    );
  }
  return redacted;
}

function redactLogValue(value: unknown, key?: string): unknown {
  if (isSensitiveAttributeKey(key)) {
    return REDACTED_LOG_VALUE;
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactSensitiveString(value);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactLogValue(item, key));
  }
  if (value instanceof Error) {
    return `${value.name}: ${redactSensitiveString(value.message)}`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([entryKey, entryValue]) => [
        entryKey,
        redactLogValue(entryValue, entryKey),
      ],
    );
    return Object.fromEntries(entries);
  }
  return redactSensitiveString(String(value));
}

function createLogger(options: {
  format: LogFormat;
  runId: string;
  serviceName: string;
  serviceVersion?: string;
  output?: "stdout" | "silent";
  color?: boolean;
  onLog?: (event: LogEvent) => void;
}): Logger {
  const host = hostname().trim();
  const resource: Record<string, string> = {
    "service.name": options.serviceName,
    "service.instance.id": options.runId,
  };
  if (options.serviceVersion) {
    resource["service.version"] = options.serviceVersion;
  }
  if (host) {
    resource["host.name"] = host;
  }
  const baseAttributes: LogAttributes = {
    "run.id": options.runId,
    "process.pid": process.pid,
  };
  const output = options.output ?? "stdout";
  const colorEnabled = options.color ?? false;
  const componentColors: Record<string, string> = {
    "legalwork-orchestrator": ANSI.gray,
    opencode: ANSI.cyan,
    "legalwork-server": ANSI.green,

    "legalwork-orchestrator-router": ANSI.cyan,
  };
  const levelColors: Record<LogLevel, string> = {
    debug: ANSI.gray,
    info: ANSI.gray,
    warn: ANSI.yellow,
    error: ANSI.red,
  };

  const emit = (
    level: LogLevel,
    message: string,
    attributes?: LogAttributes,
    component?: string,
  ) => {
    const mergedAttributes: LogAttributes = {
      ...baseAttributes,
      ...(component ? { "service.component": component } : {}),
      ...(attributes ?? {}),
    };
    const redactedMessage = redactSensitiveString(message);
    const redactedAttributes = redactLogValue(mergedAttributes) as LogAttributes;
    options.onLog?.({
      time: Date.now(),
      level,
      message: redactedMessage,
      component,
      attributes: redactedAttributes,
    });
    if (output === "silent") return;
    if (options.format === "json") {
      const record = {
        timeUnixNano: toUnixNano(),
        severityText: level.toUpperCase(),
        severityNumber: LOG_LEVEL_NUMBERS[level],
        body: redactedMessage,
        attributes: redactedAttributes,
        resource,
      };
      process.stdout.write(`${JSON.stringify(record)}\n`);
      return;
    }
    const label = component ?? options.serviceName;
    const tagLabel = label ? `[${label}]` : "";
    const levelTag = level === "info" ? "" : level.toUpperCase();
    const coloredLabel = tagLabel
      ? colorize(tagLabel, componentColors[label] ?? ANSI.gray, colorEnabled)
      : "";
    const coloredLevel = levelTag
      ? colorize(levelTag, levelColors[level] ?? ANSI.gray, colorEnabled)
      : "";
    const tag = [coloredLabel, coloredLevel].filter(Boolean).join(" ");
    const line = tag ? `${tag} ${redactedMessage}` : redactedMessage;
    process.stdout.write(`${line}\n`);
  };

  const child = (
    component: string,
    attributes?: LogAttributes,
  ): LoggerChild => ({
    log: (level, message, attrs) =>
      emit(
        level,
        message,
        { ...(attributes ?? {}), ...(attrs ?? {}) },
        component,
      ),
    debug: (message, attrs) =>
      emit(
        "debug",
        message,
        { ...(attributes ?? {}), ...(attrs ?? {}) },
        component,
      ),
    info: (message, attrs) =>
      emit(
        "info",
        message,
        { ...(attributes ?? {}), ...(attrs ?? {}) },
        component,
      ),
    warn: (message, attrs) =>
      emit(
        "warn",
        message,
        { ...(attributes ?? {}), ...(attrs ?? {}) },
        component,
      ),
    error: (message, attrs) =>
      emit(
        "error",
        message,
        { ...(attributes ?? {}), ...(attrs ?? {}) },
        component,
      ),
  });

  return {
    format: options.format,
    output,
    log: emit,
    debug: (message, attrs, component) =>
      emit("debug", message, attrs, component),
    info: (message, attrs, component) =>
      emit("info", message, attrs, component),
    warn: (message, attrs, component) =>
      emit("warn", message, attrs, component),
    error: (message, attrs, component) =>
      emit("error", message, attrs, component),
    child,
  };
}

function looksLikeOtelLogLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return false;
    return (
      typeof parsed.timeUnixNano === "string" &&
      typeof parsed.severityText === "string"
    );
  } catch {
    return false;
  }
}

function buildAttachCommand(input: {
  url: string;
  workspace: string;
  username?: string;
  password?: string;
}): string {
  const parts: string[] = [];
  if (input.username && input.password) {
    parts.push(`OPENCODE_SERVER_USERNAME=${input.username}`);
  }
  if (input.password) {
    parts.push(`OPENCODE_SERVER_PASSWORD=${input.password}`);
  }
  parts.push("opencode", "attach", input.url, "--dir", input.workspace);
  return parts.join(" ");
}

async function runClipboardCommand(
  command: string,
  args: string[],
  text: string,
): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawnProcess(command, args, {
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.on("error", () => resolve(false));
    child.stdin?.write(text);
    child.stdin?.end();
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function copyToClipboard(
  text: string,
): Promise<{ copied: boolean; error?: string }> {
  const platform = process.platform;
  const commands: Array<{ command: string; args: string[] }> = [];
  if (platform === "darwin") {
    commands.push({ command: "pbcopy", args: [] });
  } else if (platform === "win32") {
    commands.push({ command: "clip", args: [] });
  } else {
    commands.push({ command: "wl-copy", args: [] });
    commands.push({ command: "xclip", args: ["-selection", "clipboard"] });
    commands.push({ command: "xsel", args: ["--clipboard", "--input"] });
  }
  for (const entry of commands) {
    try {
      const ok = await runClipboardCommand(entry.command, entry.args, text);
      if (ok) return { copied: true };
    } catch {
      // ignore
    }
  }
  return { copied: false, error: "Clipboard unavailable" };
}

async function runDaemonCommand(args: ParsedArgs) {
  const outputJson = readBool(args.flags, "json", false);
  const subcommand = args.positionals[1];
  try {
    if (subcommand !== "status" && subcommand !== "stop") throw new Error(retiredDeveloperLauncherMessage);
    outputResult(await legacyDeveloperDaemon(resolveRouterDataDir(args.flags), subcommand === "stop"), outputJson);
  } catch (error) {
    outputError(error, outputJson);
    process.exitCode = 1;
  }
}

function readLegalworkClientAuth(args: ParsedArgs): {
  legalworkUrl: string;
  token: string;
} {
  const legalworkUrl =
    readFlag(args.flags, "legalwork-url") ??
    process.env.LEGALWORK_URL ??
    process.env.LEGALWORK_SERVER_URL ??
    "";
  const token =
    readFlag(args.flags, "token") ??
    readFlag(args.flags, "legalwork-token") ??
    process.env.LEGALWORK_TOKEN ??
    "";

  if (!legalworkUrl || !token) {
    throw new Error("legalwork-url and token are required");
  }

  return { legalworkUrl, token };
}

function readSessionId(args: ParsedArgs, fallbackIndex: number): string {
  const sessionId =
    readFlag(args.flags, "session-id") ?? args.positionals[fallbackIndex] ?? "";
  const trimmed = sessionId.trim();
  if (!trimmed) {
    throw new Error("session-id is required");
  }
  return trimmed;
}

async function runFiles(args: ParsedArgs) {
  const outputJson = readBool(args.flags, "json", false);
  const subcommand = args.positionals[1] ?? "";
  const { legalworkUrl, token } = readLegalworkClientAuth(args);
  const baseUrl = legalworkUrl.replace(/\/$/, "");
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  try {
    if (subcommand === "session") {
      const action = args.positionals[2] ?? "create";
      if (action === "create") {
        const workspaceId =
          readFlag(args.flags, "workspace-id") ?? args.positionals[3] ?? "";
        if (!workspaceId.trim()) {
          throw new Error("workspace-id is required for files session create");
        }
        const ttlSeconds = readNumber(args.flags, "ttl-seconds", undefined);
        const writeRequested = readBool(args.flags, "write", true);
        const result = await fetchJson(
          `${baseUrl}/workspace/${encodeURIComponent(workspaceId.trim())}/files/sessions`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              ...(typeof ttlSeconds === "number" ? { ttlSeconds } : {}),
              write: writeRequested,
            }),
          },
        );
        outputResult(result, outputJson);
        return;
      }
      if (action === "renew") {
        const sessionId = readSessionId(args, 3);
        const ttlSeconds = readNumber(args.flags, "ttl-seconds", undefined);
        const result = await fetchJson(
          `${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/renew`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              ...(typeof ttlSeconds === "number" ? { ttlSeconds } : {}),
            }),
          },
        );
        outputResult(result, outputJson);
        return;
      }
      if (action === "close" || action === "delete") {
        const sessionId = readSessionId(args, 3);
        const result = await fetchJson(
          `${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}`,
          {
            method: "DELETE",
            headers,
          },
        );
        outputResult(result, outputJson);
        return;
      }
      throw new Error("files session requires create|renew|close");
    }

    if (subcommand === "catalog") {
      const sessionId = readSessionId(args, 2);
      const params = new URLSearchParams();
      const prefix = readFlag(args.flags, "prefix");
      const after = readFlag(args.flags, "after");
      const limit = readNumber(args.flags, "limit", undefined);
      const includeDirs = readBool(args.flags, "include-dirs", true);
      if (prefix?.trim()) params.set("prefix", prefix.trim());
      if (after?.trim()) params.set("after", after.trim());
      if (typeof limit === "number") params.set("limit", String(limit));
      if (!includeDirs) params.set("includeDirs", "false");
      const query = params.toString();
      const result = await fetchJson(
        `${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/catalog/snapshot${query ? `?${query}` : ""}`,
        {
          headers,
        },
      );
      outputResult(result, outputJson);
      return;
    }

    if (subcommand === "events") {
      const sessionId = readSessionId(args, 2);
      const since = readNumber(args.flags, "since", undefined);
      const query =
        typeof since === "number"
          ? `?since=${encodeURIComponent(String(since))}`
          : "";
      const result = await fetchJson(
        `${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/catalog/events${query}`,
        {
          headers,
        },
      );
      outputResult(result, outputJson);
      return;
    }

    if (subcommand === "read") {
      const sessionId = readSessionId(args, 2);
      const pathsRaw = readFlag(args.flags, "paths");
      const singlePath = readFlag(args.flags, "path") ?? args.positionals[3];
      const paths = pathsRaw
        ? parseList(pathsRaw)
        : singlePath
          ? [singlePath]
          : [];
      if (!paths.length) {
        throw new Error("path or paths is required for files read");
      }
      const result = await fetchJson(
        `${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/read-batch`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ paths }),
        },
      );
      outputResult(result, outputJson);
      return;
    }

    if (subcommand === "write") {
      const sessionId = readSessionId(args, 2);
      const path = readFlag(args.flags, "path") ?? args.positionals[3] ?? "";
      if (!path.trim()) {
        throw new Error("path is required for files write");
      }

      let contentBase64 = readFlag(args.flags, "content-base64") ?? "";
      if (!contentBase64) {
        const inlineContent = readFlag(args.flags, "content");
        if (inlineContent !== undefined) {
          contentBase64 = Buffer.from(inlineContent, "utf8").toString("base64");
        }
      }
      if (!contentBase64) {
        const filePath = readFlag(args.flags, "file");
        if (filePath?.trim()) {
          const fileBytes = await readFile(resolve(filePath.trim()));
          contentBase64 = Buffer.from(fileBytes).toString("base64");
        }
      }
      if (!contentBase64) {
        throw new Error(
          "provide one of --content, --content-base64, or --file",
        );
      }

      const ifMatchRevision = readFlag(args.flags, "if-match");
      const force = readBool(args.flags, "force", false);
      const result = await fetchJson(
        `${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/write-batch`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            writes: [
              {
                path: path.trim(),
                contentBase64,
                ...(ifMatchRevision?.trim()
                  ? { ifMatchRevision: ifMatchRevision.trim() }
                  : {}),
                ...(force ? { force: true } : {}),
              },
            ],
          }),
        },
      );
      outputResult(result, outputJson);
      return;
    }

    if (subcommand === "mkdir") {
      const sessionId = readSessionId(args, 2);
      const path = readFlag(args.flags, "path") ?? args.positionals[3] ?? "";
      if (!path.trim()) throw new Error("path is required for files mkdir");
      const result = await fetchJson(
        `${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/ops`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            operations: [{ type: "mkdir", path: path.trim() }],
          }),
        },
      );
      outputResult(result, outputJson);
      return;
    }

    if (subcommand === "delete") {
      const sessionId = readSessionId(args, 2);
      const path = readFlag(args.flags, "path") ?? args.positionals[3] ?? "";
      if (!path.trim()) throw new Error("path is required for files delete");
      const recursive = readBool(args.flags, "recursive", false);
      const result = await fetchJson(
        `${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/ops`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            operations: [
              {
                type: "delete",
                path: path.trim(),
                ...(recursive ? { recursive: true } : {}),
              },
            ],
          }),
        },
      );
      outputResult(result, outputJson);
      return;
    }

    if (subcommand === "rename") {
      const sessionId = readSessionId(args, 2);
      const from = readFlag(args.flags, "from") ?? args.positionals[3] ?? "";
      const to = readFlag(args.flags, "to") ?? args.positionals[4] ?? "";
      if (!from.trim() || !to.trim()) {
        throw new Error("from and to are required for files rename");
      }
      const result = await fetchJson(
        `${baseUrl}/files/sessions/${encodeURIComponent(sessionId)}/ops`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            operations: [{ type: "rename", from: from.trim(), to: to.trim() }],
          }),
        },
      );
      outputResult(result, outputJson);
      return;
    }

    throw new Error(
      "files requires session|catalog|events|read|write|mkdir|delete|rename",
    );
  } catch (error) {
    outputError(error, outputJson);
    process.exitCode = 1;
  }
}

async function runApprovals(args: ParsedArgs) {
  const subcommand = args.positionals[1];
  if (!subcommand || (subcommand !== "list" && subcommand !== "reply")) {
    throw new Error("approvals requires 'list' or 'reply'");
  }

  const legalworkUrl =
    readFlag(args.flags, "legalwork-url") ??
    process.env.LEGALWORK_URL ??
    process.env.LEGALWORK_SERVER_URL ??
    "";
  const hostToken =
    readFlag(args.flags, "host-token") ?? process.env.LEGALWORK_HOST_TOKEN ?? "";

  if (!legalworkUrl || !hostToken) {
    throw new Error("legalwork-url and host-token are required for approvals");
  }

  const headers = {
    "Content-Type": "application/json",
    "X-LegalWork-Host-Token": hostToken,
  };

  if (subcommand === "list") {
    const response = await fetch(
      `${legalworkUrl.replace(/\/$/, "")}/approvals`,
      { headers },
    );
    if (!response.ok) {
      throw new Error(`Failed to list approvals: ${response.status}`);
    }
    const body = await response.json();
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  const approvalId = args.positionals[2];
  if (!approvalId) {
    throw new Error("approval id is required for approvals reply");
  }

  const allow = readBool(args.flags, "allow", false);
  const deny = readBool(args.flags, "deny", false);
  if (allow === deny) {
    throw new Error("use --allow or --deny");
  }

  const payload = { reply: allow ? "allow" : "deny" };
  const response = await fetch(
    `${legalworkUrl.replace(/\/$/, "")}/approvals/${approvalId}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok) {
    throw new Error(`Failed to reply to approval: ${response.status}`);
  }
  const body = await response.json();
  console.log(JSON.stringify(body, null, 2));
}

async function runStatus(args: ParsedArgs) {
  const legalworkUrl =
    readFlag(args.flags, "legalwork-url") ?? process.env.LEGALWORK_URL ?? "";
  const opencodeUrl =
    readFlag(args.flags, "opencode-url") ?? process.env.OPENCODE_URL ?? "";
  const username =
    readFlag(args.flags, "opencode-username") ??
    process.env.OPENCODE_SERVER_USERNAME;
  const password =
    readFlag(args.flags, "opencode-password") ??
    process.env.OPENCODE_SERVER_PASSWORD;
  const legalworkToken = readFlag(args.flags, "legalwork-token") ?? process.env.LEGALWORK_TOKEN;
  const outputJson = readBool(args.flags, "json", false);

  const status: Record<string, unknown> = {};

  if (legalworkUrl) {
    try {
      await waitForHealthy(legalworkUrl, 5000, 400);
      status.legalwork = { ok: true, url: legalworkUrl };
    } catch (error) {
      status.legalwork = { ok: false, url: legalworkUrl, error: String(error) };
    }
  }

  if (opencodeUrl) {
    try {
      const headers: Record<string, string> = {};
      const proxy = new URL(opencodeUrl);
      const managedProxy = /\/(?:w\/[^/]+\/)?opencode\/?$/.test(proxy.pathname);
      if (managedProxy && legalworkToken) {
        headers.Authorization = `Bearer ${legalworkToken}`;
      } else if (username && password) {
        headers.Authorization = `Basic ${encodeBasicAuth(username, password)}`;
      }
      const client = OpenCode.make({
        baseUrl: opencodeUrl,
        headers,
      });
      if (managedProxy && legalworkToken) {
        const info = await client.server.info({ signal: AbortSignal.timeout(5000) });
        if (!info.version.startsWith("2.") || !Number.isInteger(info.pid) || info.pid <= 0) throw new Error("The managed engine did not return a native v2 process identity.");
        proxy.pathname = proxy.pathname.replace(/\/(?:w\/[^/]+\/)?opencode\/?$/, "/health"); proxy.search = ""; proxy.hash = "";
        const response = await fetch(proxy, { signal: AbortSignal.timeout(5000) });
        const readiness: unknown = await response.json();
        if (!response.ok || !readiness || typeof readiness !== "object" || !("engine" in readiness) || !readiness.engine || typeof readiness.engine !== "object" || !("status" in readiness.engine)) throw new Error("The LegalWork server did not return managed engine readiness.");
        const healthy = readiness.engine.status === "ready";
        status.opencode = { ok: healthy, url: opencodeUrl, health: { healthy, version: info.version, pid: info.pid, status: readiness.engine.status } };
      } else {
        const health = await waitForOpencodeHealthy(client, 5000, 400);
        status.opencode = { ok: true, url: opencodeUrl, health };
      }
    } catch (error) {
      status.opencode = { ok: false, url: opencodeUrl, error: String(error) };
    }
  }

  if (outputJson) {
    console.log(JSON.stringify(status, null, 2));
  } else {
    if (status.legalwork) {
      const legalwork = status.legalwork as {
        ok: boolean;
        url: string;
        error?: string;
      };
      console.log(
        `LegalWork server: ${legalwork.ok ? "ok" : "error"} (${legalwork.url})`,
      );
      if (legalwork.error) console.log(`  ${legalwork.error}`);
    }
    if (status.opencode) {
      const opencode = status.opencode as {
        ok: boolean;
        url: string;
        error?: string;
      };
      console.log(
        `OpenCode server: ${opencode.ok ? "ok" : "error"} (${opencode.url})`,
      );
      if (opencode.error) console.log(`  ${opencode.error}`);
    }
  }
}

async function runStart(args: ParsedArgs) {
  if ([...args.flags.keys()].some((name) => /^opencode-router(?:-|$)/.test(name))) {
    throw new Error("Messaging connectors have been removed. Remove the opencode-router options.");
  }

  const outputJson = readBool(args.flags, "json", false);
  const checkOnly = readBool(args.flags, "check", false);
  const checkEvents = readBool(args.flags, "check-events", false);
  const verbose = readBool(args.flags, "verbose", false, "LEGALWORK_VERBOSE");
  const logFormat = readLogFormat(
    args.flags,
    "log-format",
    "pretty",
    "LEGALWORK_LOG_FORMAT",
  );
  const detachRequested = readBool(
    args.flags,
    "detach",
    false,
    "LEGALWORK_DETACH",
  );
  const defaultTui =
    process.stdout.isTTY && !outputJson && !checkOnly && !checkEvents;
  const tuiRequested = readBool(args.flags, "tui", defaultTui);
  let useTui =
    tuiRequested &&
    !detachRequested &&
    !outputJson &&
    !checkOnly &&
    !checkEvents &&
    logFormat === "pretty";
  const colorPreferred =
    readBool(args.flags, "color", process.stdout.isTTY, "LEGALWORK_COLOR") &&
    !process.env.NO_COLOR;
  const runId =
    readFlag(args.flags, "run-id") ??
    process.env.LEGALWORK_RUN_ID ??
    randomUUID();
  const cliVersion = await resolveCliVersion();
  const compiledBinary = isCompiledBunBinary();
  let tui: TuiHandle | undefined;
  let restoreConsoleError: (() => void) | undefined;
  const baseLoggerOptions = {
    format: logFormat,
    runId,
    serviceName: "legalwork-orchestrator",
    serviceVersion: cliVersion,
    onLog: (event: LogEvent) => {
      if (!tui) return;
      const component = event.component ?? "legalwork-orchestrator";
      tui.pushLog({
        time: event.time,
        level: event.level,
        component,
        message: event.message,
      });
    },
  };
  let logger = createLogger({
    ...baseLoggerOptions,
    output: useTui ? "silent" : "stdout",
    color: useTui ? false : colorPreferred,
  });
  let logVerbose = createVerboseLogger(
    verbose && !outputJson,
    logger,
    "legalwork-orchestrator",
  );
  const switchToPlainOutput = (error: string) => {
    if (!useTui) return;
    useTui = false;
    restoreConsoleError?.();
    restoreConsoleError = undefined;
    tui?.stop();
    tui = undefined;
    logger = createLogger({
      ...baseLoggerOptions,
      output: "stdout",
      color: colorPreferred,
    });
    logVerbose = createVerboseLogger(
      verbose && !outputJson,
      logger,
      "legalwork-orchestrator",
    );
    logger.warn(
      "TUI failed to start; falling back to plain output. Use `legalwork serve` for explicit non-TUI mode.",
      { error },
      "legalwork-orchestrator",
    );
  };
  const sidecarSourceInput = readBinarySource(
    args.flags,
    "sidecar-source",
    "auto",
    "LEGALWORK_SIDECAR_SOURCE",
  );
  const opencodeSourceInput = readBinarySource(
    args.flags,
    "opencode-source",
    "auto",
    "LEGALWORK_OPENCODE_SOURCE",
  );

  const workspace =
    readFlag(args.flags, "workspace") ??
    process.env.LEGALWORK_WORKSPACE ??
    process.cwd();
  const resolvedWorkspace = await ensureWorkspace(workspace);
  logger.info(
    "Run starting",
    { workspace: resolvedWorkspace, logFormat, runId },
    "legalwork-orchestrator",
  );

  const sandboxRequested = readSandboxMode(
    args.flags,
    "sandbox",
    "none",
    "LEGALWORK_SANDBOX",
  );
  const sandboxMode = await resolveSandboxMode(sandboxRequested);
  const sandboxImage =
    readFlag(args.flags, "sandbox-image") ??
    process.env.LEGALWORK_SANDBOX_IMAGE ??
    "debian:bookworm-slim";
  const sandboxPersistOverride =
    readFlag(args.flags, "sandbox-persist-dir") ??
    process.env.LEGALWORK_SANDBOX_PERSIST_DIR;
  const dataDir = resolveRouterDataDir(args.flags);
  const devMode = resolveInternalDevMode(args.flags);
  const opencodeStateLayout = resolveOpencodeStateLayout({
    dataDir,
    workspace: resolvedWorkspace,
    devMode,
  });
  const opencodeConfigDir = opencodeStateLayout.configDir;
  await ensureOpencodeStateLayout(opencodeStateLayout);
  await retireMessagingTools(opencodeConfigDir);

  const sandboxPersistDir = resolve(
    sandboxPersistOverride?.trim()
      ? sandboxPersistOverride.trim()
      : join(dataDir, "sandbox", workspaceIdForLocal(resolvedWorkspace)),
  );
  if (sandboxMode !== "none") {
    await mkdir(sandboxPersistDir, { recursive: true });
  }

  const sandboxMountValue =
    readFlag(args.flags, "sandbox-mount") ?? process.env.LEGALWORK_SANDBOX_MOUNT;
  const sandboxMountSpecs = parseList(sandboxMountValue);
  const sandboxExtraMounts =
    sandboxMode !== "none" && sandboxMountSpecs.length
      ? await resolveSandboxExtraMounts(sandboxMountSpecs, sandboxMode)
      : [];

  const explicitOpencodeBin =
    readFlag(args.flags, "opencode-bin") ?? process.env.LEGALWORK_OPENCODE_BIN;
  const explicitLegalworkServerBin =
    readFlag(args.flags, "legalwork-server-bin") ??
    process.env.LEGALWORK_SERVER_BIN;

  assertManagedOpencodeAuth(args);
  const opencodeBindHost = resolveManagedOpencodeHost(
    readFlag(args.flags, "opencode-host") ??
      process.env.LEGALWORK_OPENCODE_BIND_HOST,
  );
  const opencodePort =
    sandboxMode !== "none"
      ? SANDBOX_INTERNAL_OPENCODE_PORT
      : await resolvePort(
          readNumber(
            args.flags,
            "opencode-port",
            undefined,
            "LEGALWORK_OPENCODE_PORT",
          ),
          "127.0.0.1",
        );
  const opencodeLogLevel = resolveOpencodeLogLevel(
    readFlag(args.flags, "opencode-log-level") ??
      process.env.LEGALWORK_OPENCODE_LOG_LEVEL,
  );
  const opencodeHotReload = readOpencodeHotReload(
    args.flags,
    {
      enabled: true,
      debounceMs: DEFAULT_OPENCODE_HOT_RELOAD_DEBOUNCE_MS,
      cooldownMs: DEFAULT_OPENCODE_HOT_RELOAD_COOLDOWN_MS,
    },
    {
      enabled: "LEGALWORK_OPENCODE_HOT_RELOAD",
      debounceMs: "LEGALWORK_OPENCODE_HOT_RELOAD_DEBOUNCE_MS",
      cooldownMs: "LEGALWORK_OPENCODE_HOT_RELOAD_COOLDOWN_MS",
    },
  );
  const opencodeCredentials = resolveManagedOpencodeCredentials(args);
  const opencodeUsername = opencodeCredentials.username;
  const opencodePassword = opencodeCredentials.password;

  const remoteAccessEnabled = resolveLegalworkRemoteAccess(args);
  const legalworkHost = remoteAccessEnabled ? "0.0.0.0" : "127.0.0.1";
  const legalworkPort = await resolvePort(
    readNumber(args.flags, "legalwork-port", undefined, "LEGALWORK_PORT"),
    "127.0.0.1",
  );

  const legalworkToken =
    readFlag(args.flags, "legalwork-token") ??
    process.env.LEGALWORK_TOKEN ??
    randomUUID();
  const legalworkHostToken =
    readFlag(args.flags, "legalwork-host-token") ??
    process.env.LEGALWORK_HOST_TOKEN ??
    randomUUID();
  const approvalMode =
    (readFlag(args.flags, "approval") as ApprovalMode | undefined) ??
    (process.env.LEGALWORK_APPROVAL_MODE as ApprovalMode | undefined) ??
    "manual";
  const approvalTimeoutMs = readNumber(
    args.flags,
    "approval-timeout",
    DEFAULT_APPROVAL_TIMEOUT,
    "LEGALWORK_APPROVAL_TIMEOUT_MS",
  ) as number;
  const readOnly = readBool(
    args.flags,
    "read-only",
    false,
    "LEGALWORK_READONLY",
  );
  const corsValue =
    readFlag(args.flags, "cors") ?? process.env.LEGALWORK_CORS_ORIGINS ?? "*";
  const corsOrigins = parseList(corsValue);
  const connectHost = readFlag(args.flags, "connect-host");

  const manifest = await readVersionManifest();
  const allowExternal = readBool(
    args.flags,
    "allow-external",
    false,
    "LEGALWORK_ALLOW_EXTERNAL",
  );
  const sidecarTarget = resolveSandboxSidecarTarget(sandboxMode);
  const sidecar = resolveSidecarConfigForTarget(
    args.flags,
    sidecarTarget,
  );

  let sidecarSource = sidecarSourceInput;
  let opencodeSource = opencodeSourceInput;
  if (sandboxMode !== "none") {
    if (sidecarSourceInput === "bundled") {
      throw new Error("Sandbox mode does not support --sidecar-source bundled");
    }
    if (opencodeSourceInput === "bundled") {
      throw new Error(
        "Sandbox mode does not support --opencode-source bundled",
      );
    }
    // In sandbox mode, we must run Linux binaries inside the container. When
    // custom *-bin paths are provided, treat the source as external so we don't
    // accidentally pick host (darwin) bundled binaries.
    if (sidecarSourceInput === "auto") {
      sidecarSource = explicitLegalworkServerBin ? "external" : "auto";
    }
    if (opencodeSourceInput === "auto") {
      opencodeSource = explicitOpencodeBin ? "external" : "auto";
    }
  }
  const dockerCommand =
    sandboxMode === "docker" ? await resolveDockerCommand() : null;
  logVerbose(`cli version: ${cliVersion}`);
  logVerbose(`sandbox: ${sandboxMode}`);
  if (dockerCommand) {
    logVerbose(`docker bin: ${dockerCommand}`);
  }
  if (sandboxMode !== "none") {
    logVerbose(`sandbox image: ${sandboxImage}`);
    logVerbose(`sandbox persist dir: ${sandboxPersistDir}`);
    if (sandboxExtraMounts.length) {
      logVerbose(`sandbox mounts: ${sandboxExtraMounts.length}`);
    }
  }
  logVerbose(`sidecar target: ${sidecar.target ?? "unknown"}`);
  logVerbose(`sidecar dir: ${sidecar.dir}`);
  logVerbose(`sidecar source: ${sidecarSource}`);
  logVerbose(`opencode source: ${opencodeSource}`);
  logVerbose(
    `opencode hot reload: ${opencodeHotReload.enabled ? "on" : "off"} (debounce=${opencodeHotReload.debounceMs}ms cooldown=${opencodeHotReload.cooldownMs}ms)`,
  );
  logVerbose(`allow external: ${allowExternal ? "true" : "false"}`);
  let opencodeBinary = await resolveOpencodeBin({
    explicit: explicitOpencodeBin,
    manifest,
    allowExternal,
    sidecar,
    source: opencodeSource,
  });

  if (sandboxMode !== "none") {
    if (sandboxMode === "docker") {
      if (!(await probeCommand(dockerCommand ?? "docker", ["version"]))) {
        throw new Error(
          `Docker is required for --sandbox docker. Install Docker Desktop and ensure '${dockerCommand ?? "docker"}' is available.`,
        );
      }
    }
    if (sandboxMode === "container") {
      if (process.platform !== "darwin") {
        throw new Error("Apple container backend is only supported on macOS");
      }
      if (process.arch !== "arm64") {
        throw new Error(
          "Apple container backend requires Apple silicon (arm64)",
        );
      }
      if (!(await probeCommand("container", ["--version"]))) {
        throw new Error(
          "Apple container CLI not found. Install https://github.com/apple/container",
        );
      }
    }
  }

  if (sandboxMode !== "none" && sidecarTarget !== resolveSidecarTarget() && !explicitLegalworkServerBin) {
    throw new Error("Sandbox mode requires a locally built Linux server via --legalwork-server-bin and --allow-external; automatic standalone downloads are retired.");
  }
  let legalworkServerBinary = await resolveLegalworkServerBin({
    explicit: explicitLegalworkServerBin,
    manifest: sandboxMode !== "none" && sidecarTarget !== resolveSidecarTarget() ? null : manifest,
    allowExternal,
    sidecar,
    source: sidecarSource,
  });

  if (sandboxMode !== "none") {
    // Ensure the binaries we stage into the container are actual files.
    await assertSandboxBinaryFile("opencode", opencodeBinary.bin);
    await assertSandboxBinaryFile("legalwork-server", legalworkServerBinary.bin);

  }

  logVerbose(`opencode bin: ${opencodeBinary.bin} (${opencodeBinary.source})`);
  logVerbose(
    `legalwork-server bin: ${legalworkServerBinary.bin} (${legalworkServerBinary.source})`,
  );

  const legalworkBaseUrl = `http://127.0.0.1:${legalworkPort}`;
  const legalworkConnect = remoteAccessEnabled
    ? resolveConnectUrl(legalworkPort, connectHost)
    : {};
  const legalworkConnectUrl = legalworkConnect.connectUrl ?? legalworkBaseUrl;

  const opencodeBaseUrl = `${legalworkBaseUrl}/opencode`;
  const opencodeConnectUrl = `${legalworkConnectUrl.replace(/\/$/, "")}/opencode`;
  const attachCommand = `OpenCode is proxied via ${opencodeConnectUrl} (requires LegalWork token)`;
  const managedEngineStorageDirectory = join(opencodeStateLayout.rootDir, "managed-engine-v2");
  const managedOpencodeOptions = {
    bin: opencodeBinary.bin,
    port: opencodePort,
    storageDirectory: managedEngineStorageDirectory,
    pluginDirectories: [],
    dataHome: opencodeStateLayout.env.XDG_DATA_HOME,
    logLevel: opencodeLogLevel,
  };

  const children: ChildHandle[] = [];
  const lifecycleAbort = new AbortController();
  let shuttingDown = false;
  let detached = false;
  let sandboxContainerName: string | null = null;
  let sandboxStop: ((name: string) => Promise<void>) | null = null;
  let sandboxStopCommand: string | null = null;
  let sandboxCleanup: (() => Promise<void>) | null = null;
  let opencodeChild: ChildProcess | null = null;
  let legalworkChild: ChildProcess | null = null;

  let controlServer: ReturnType<typeof createHttpServer> | null = null;
  const controlPort = await resolvePort(undefined, "127.0.0.1");
  const controlToken = randomUUID();
  const controlBaseUrl = `http://127.0.0.1:${controlPort}`;
  let opencodeActualVersion: string | undefined;
  let legalworkActualVersion: string | undefined;

  const startedAt = Date.now();

  const workerActivityHeartbeat = resolveWorkerActivityHeartbeatConfig();
  let workerActivityHeartbeatInterval: NodeJS.Timeout | null = null;
  const restartingServices = new Set<string>();
  const runtimeUpgradeState: RuntimeUpgradeState = {
    status: "idle",
    startedAt: null,
    finishedAt: null,
    error: null,
    operationId: null,
    services: [],
  };
  const removeChildHandle = (name: string) => {
    const index = children.findIndex((handle) => handle.name === name);
    if (index >= 0) children.splice(index, 1);
  };
  const getRuntimeSnapshot = async () => {
    let engineRunning = false;
    if (legalworkChild && isProcessAlive(legalworkChild.pid)) {
      try {
        const info = await OpenCode.make({ baseUrl: opencodeBaseUrl, headers: { Authorization: `Bearer ${legalworkToken}` } }).server.info({ signal: AbortSignal.timeout(3000) });
        engineRunning = info.version.startsWith("2.");
      } catch { /* A running owner alone does not prove its engine is healthy. */ }
    }
    const services = [
      buildRuntimeServiceSnapshot({
        name: "legalwork-server",
        enabled: true,
        running: Boolean(legalworkChild && isProcessAlive(legalworkChild.pid)),
        binary: legalworkServerBinary,
        actualVersion: legalworkActualVersion,
      }),
      buildRuntimeServiceSnapshot({
        name: "opencode",
        enabled: true,
        running: engineRunning,
        binary: opencodeBinary,
        actualVersion: opencodeActualVersion,
      }),

    ];
    return {
      ok: true,
      orchestrator: {
        version: cliVersion,
        startedAt,
      },
      worker: {
        workspace: resolvedWorkspace,
        sandboxMode,
      },
      upgrade: {
        ...runtimeUpgradeState,
      },
      services,
    };
  };
  const restartLegalworkServer = async () => {
    if (sandboxMode !== "none") {
      throw new Error(
        "Runtime upgrade is not supported while sandbox mode is enabled",
      );
    }
    if (legalworkChild) {
      restartingServices.add("legalwork-server");
      removeChildHandle("legalwork-server");
      await stopChild(legalworkChild, 10_000);
      legalworkChild = null;
    }
    const child = await startLegalworkServer({
      bin: legalworkServerBinary.bin,
      host: legalworkHost,
      port: legalworkPort,
      workspace: resolvedWorkspace,
      token: legalworkToken,
      hostToken: legalworkHostToken,
      approvalMode: approvalMode === "auto" ? "auto" : "manual",
      approvalTimeoutMs,
      readOnly,
      corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
      managedOpencode: { ...managedOpencodeOptions, bin: opencodeBinary.bin },
      logger,
      runId,
      logFormat,
      controlBaseUrl,
      controlToken,
    });
    legalworkChild = child;
    children.push({ name: "legalwork-server", child });
    logger.info(
      "Process spawned",
      { pid: child.pid ?? 0, cause: "runtime-upgrade" },
      "legalwork-server",
    );
    child.on("exit", (code, signal) =>
      handleExit("legalwork-server", code, signal),
    );
    child.on("error", (error) => handleSpawnError("legalwork-server", error));
    await waitForHealthy(legalworkBaseUrl);
    await waitForManagedOpencodeHealthy(OpenCode.make({ baseUrl: opencodeBaseUrl, headers: { Authorization: `Bearer ${legalworkToken}` } }), child, legalworkBaseUrl);
    legalworkActualVersion = await verifyLegalworkServer({
      baseUrl: legalworkBaseUrl,
      token: legalworkToken,
      hostToken: legalworkHostToken,
      expectedVersion: legalworkServerBinary.expectedVersion,
      expectedWorkspace: resolvedWorkspace,
      expectedOpencodeDirectory: resolvedWorkspace,
    });
  };

  const performRuntimeUpgrade = async (services: RuntimeServiceName[]) => {
    const opId = randomUUID();
    runtimeUpgradeState.status = "running";
    runtimeUpgradeState.startedAt = Date.now();
    runtimeUpgradeState.finishedAt = null;
    runtimeUpgradeState.error = null;
    runtimeUpgradeState.operationId = opId;
    runtimeUpgradeState.services = services;
    try {
      if (sandboxMode !== "none") {
        throw new Error(
          "Runtime upgrade is only supported for non-sandbox workers",
        );
      }
      if (
        services.includes("legalwork-server") &&
        legalworkServerBinary.source === "external" &&
        legalworkServerBinary.expectedVersion
      ) {
        await installGlobalPackages([
          `legalwork-server@${legalworkServerBinary.expectedVersion}`,
        ]);
      }

      if (services.includes("legalwork-server")) {
        legalworkServerBinary = await resolveLegalworkServerBin({
          explicit: explicitLegalworkServerBin,
          manifest,
          allowExternal,
          sidecar,
          source: sidecarSource,
        });
      }
      if (services.includes("opencode")) {
        opencodeBinary = await resolveOpencodeBin({
          explicit: explicitOpencodeBin,
          manifest,
          allowExternal,
          sidecar,
          source: opencodeSource,
        });
      }

      if (services.includes("opencode")) {
        opencodeActualVersion = await verifyOpencodeVersion(opencodeBinary);
      }

      if (
        services.includes("legalwork-server") ||
        services.includes("opencode")
      ) {
        await restartLegalworkServer();
      }
      runtimeUpgradeState.status = "idle";
      runtimeUpgradeState.finishedAt = Date.now();
    } catch (error) {
      runtimeUpgradeState.status = "failed";
      runtimeUpgradeState.finishedAt = Date.now();
      runtimeUpgradeState.error =
        error instanceof Error ? error.message : String(error);
      logger.error(
        "Runtime upgrade failed",
        { error: runtimeUpgradeState.error, services },
        "legalwork-orchestrator",
      );
    }
  };
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => shutdownPromise ??= (async () => {
    shuttingDown = true;
    lifecycleAbort.abort();
    restoreConsoleError?.();
    restoreConsoleError = undefined;

    if (workerActivityHeartbeatInterval) {
      clearInterval(workerActivityHeartbeatInterval);
      workerActivityHeartbeatInterval = null;
    }
    if (controlServer) {
      await new Promise<void>((resolve) =>
        controlServer?.close(() => resolve()),
      );
      controlServer = null;
    }
    logger.info(
      "Shutting down",
      { children: children.map((handle) => handle.name) },
      "legalwork-orchestrator",
    );
    if (sandboxContainerName && sandboxStop) {
      await sandboxStop(sandboxContainerName);
    }
    await Promise.all(children.map((handle) => stopChild(handle.child, handle.name === "legalwork-server" ? 10_000 : 2500)));
    if (sandboxCleanup) {
      await sandboxCleanup();
      sandboxCleanup = null;
    }
  })();

  const detachChildren = () => {
    detached = true;
    for (const handle of children) {
      try {
        handle.child.unref();
      } catch {
        // ignore
      }
      handle.child.stdout?.removeAllListeners();
      handle.child.stderr?.removeAllListeners();
      handle.child.stdout?.destroy();
      handle.child.stderr?.destroy();
    }
  };

  const handleQuit = async () => {
    tui?.stop();
    await shutdown();
    process.exit(0);
  };

  const handleDetach = async () => {
    if (detached) return;
    restoreConsoleError?.();
    restoreConsoleError = undefined;

    if (workerActivityHeartbeatInterval) {
      clearInterval(workerActivityHeartbeatInterval);
      workerActivityHeartbeatInterval = null;
    }
    tui?.stop();
    detachChildren();
    const summary = [
      "Detached. Services still running:",
      ...children.map(
        (handle) => `- ${handle.name} (pid ${handle.child.pid ?? "unknown"})`,
      ),
      ...(sandboxContainerName && sandboxStopCommand
        ? [
            `- sandbox (${sandboxStopCommand.split(" ")[0]} container ${sandboxContainerName})`,
            `Stop: ${sandboxStopCommand} ${sandboxContainerName}`,
          ]
        : []),
      `LegalWork URL: ${legalworkConnectUrl}`,
      "Credentials withheld from detached stdout.",
      `OpenCode URL: ${opencodeConnectUrl}`,
      `Attach: ${redactSensitiveString(attachCommand)}`,
      "Use `--json` only when you explicitly need the raw tokens or passwords in command output.",
    ].join("\n");
    process.stdout.write(`${summary}\n`);
    process.exit(0);
  };

  if (useTui) {
    if (compiledBinary) {
      const originalConsoleError = console.error.bind(console);
      restoreConsoleError = () => {
        console.error = originalConsoleError;
      };
      console.error = (...items: unknown[]) => {
        const text = items
          .map((item) => {
            if (typeof item === "string") return item;
            if (item instanceof Error) return `${item.name}: ${item.message}`;
            return String(item);
          })
          .join(" ");
        if (
          text.includes("React is not defined") ||
          text.includes("/$bunfs/root/legalwork-orchestrator") ||
          text.includes("/$bunfs/root/legalwork")
        ) {
          switchToPlainOutput(text);
        }
        originalConsoleError(...items);
      };
    }
    try {
      const { startOrchestratorTui } = await import("./tui/app.js");
      tui = startOrchestratorTui({
        version: cliVersion,
        connect: {
          runId,
          workspace: resolvedWorkspace,
          legalworkUrl: legalworkConnectUrl,
          legalworkToken,

          hostToken: legalworkHostToken,
          opencodeUrl: opencodeConnectUrl,

          attachCommand,
        },
        services: [
          {
            name: "opencode",
            label: "opencode",
            status: "starting",
            port: opencodePort,
          },
          {
            name: "legalwork-server",
            label: "legalwork-server",
            status: "starting",
            port: legalworkPort,
          },

        ],
        onQuit: handleQuit,
        onDetach: handleDetach,
        onCopyAttach: async () => {
          const result = await copyToClipboard(attachCommand);
          return { command: attachCommand, ...result };
        },
        onCopySelection: async (text) => copyToClipboard(text),

      });
      tui.setUptimeStart(startedAt);
    } catch (error) {
      switchToPlainOutput(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const handleExit = (
    name: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ) => {
    if (shuttingDown || detached) return;
    if (restartingServices.has(name)) {
      restartingServices.delete(name);
      return;
    }
    const reason =
      code !== null ? `code ${code}` : signal ? `signal ${signal}` : "unknown";
    const services =
      name === "sandbox"
        ? ["opencode", "legalwork-server"]
        : [name];
    for (const service of services) {
      tui?.updateService(service, { status: "stopped", message: reason });
    }
    logger.error("Process exited", { reason, code, signal }, name);
    void shutdown().then(() => process.exit(code ?? 1));
  };

  const handleSpawnError = (name: string, error: unknown) => {
    if (shuttingDown || detached) return;
    tui?.updateService(name, {
      status: "error",
      message: String(error),
    });
    logger.error("Process failed to start", { error: String(error) }, name);
    void shutdown().then(() => process.exit(1));
  };

  // Cancellation during startup owns the same cleanup as cancellation after
  // readiness; it must not leave the managed server/native engine orphaned.
  process.once("SIGINT", () => { void shutdown().then(() => process.exit(0)); });
  process.once("SIGTERM", () => { void shutdown().then(() => process.exit(0)); });
  try {
    opencodeActualVersion =
      sandboxMode !== "none"
        ? opencodeBinary.expectedVersion
        : await verifyOpencodeVersion(opencodeBinary);
    let opencodeClient: OpenCodeClient;

    controlServer = createHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", controlBaseUrl);
      res.setHeader("Content-Type", "application/json");
      const authHeader = req.headers.authorization ?? "";
      if (authHeader !== `Bearer ${controlToken}`) {
        res.statusCode = 401;
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      if (method === "GET" && url.pathname === "/runtime/versions") {
        res.statusCode = 200;
        res.end(JSON.stringify(await getRuntimeSnapshot()));
        return;
      }
      if (method === "POST" && url.pathname === "/runtime/upgrade") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        let body: { services?: RuntimeServiceName[] } | null = null;
        try {
          body = chunks.length
            ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                services?: RuntimeServiceName[];
              })
            : null;
        } catch {
          body = null;
        }
        const requested = Array.isArray(body?.services)
          ? body.services
          : ["legalwork-server", "opencode"];
        const services = Array.from(
          new Set(
            requested.filter(
              (item): item is RuntimeServiceName =>
                item === "legalwork-server" ||
                item === "opencode",
            ),
          ),
        );
        if (!services.length) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: "invalid_services" }));
          return;
        }
        if (runtimeUpgradeState.status === "running") {
          res.statusCode = 409;
          res.end(
            JSON.stringify({
              ok: false,
              error: "upgrade_in_progress",
              upgrade: runtimeUpgradeState,
            }),
          );
          return;
        }
        res.statusCode = 202;
        res.end(
          JSON.stringify({
            ok: true,
            started: true,
            services,
            upgrade: { ...runtimeUpgradeState, status: "running" },
          }),
        );
        void performRuntimeUpgrade(services);
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
    });
    await new Promise<void>((resolve, reject) => {
      controlServer?.once("error", reject);
      controlServer?.listen(controlPort, "127.0.0.1", () => resolve());
    });

    if (sandboxMode !== "none") {
      const containerName = `legalwork-orchestrator-${runId.replace(/[^a-zA-Z0-9_.-]+/g, "-").slice(0, 24)}`;
      sandboxContainerName = containerName;

      sandboxStop =
        sandboxMode === "container"
          ? stopAppleContainer
          : (name: string) =>
              stopDockerContainer(name, dockerCommand ?? "docker");
      sandboxStopCommand =
        sandboxMode === "container" ? "container stop" : "docker stop";
      const opencodeInternalBaseUrl = `http://127.0.0.1:${SANDBOX_INTERNAL_OPENCODE_PORT}`;

      const sandboxChild =
        sandboxMode === "container"
          ? await startAppleContainerSandbox({
              image: sandboxImage,
              containerName,
              workspace: resolvedWorkspace,
              persistDir: sandboxPersistDir,
              opencodeConfigDir,
              extraMounts: sandboxExtraMounts,
              sidecars: {
                opencode: opencodeBinary.bin,
                legalworkServer: legalworkServerBinary.bin,

              },
              ports: {
                legalwork: legalworkPort,

              },
              opencode: {
                corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
                username: opencodeUsername,
                password: opencodePassword,
                hotReload: opencodeHotReload,
                logLevel: opencodeLogLevel,
              },
              legalwork: {
                token: legalworkToken,
                hostToken: legalworkHostToken,
                approvalMode: approvalMode === "auto" ? "auto" : "manual",
                approvalTimeoutMs,
                readOnly,
                corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
                opencodeUsername,
                opencodePassword,
                logFormat,
              },
              runId,
              logFormat,
              detach: detachRequested,
              logger,
            })
          : await startDockerSandbox({
              image: sandboxImage,
              dockerCommand: dockerCommand ?? "docker",
              containerName,
              workspace: resolvedWorkspace,
              persistDir: sandboxPersistDir,
              opencodeConfigDir,
              extraMounts: sandboxExtraMounts,
              sidecars: {
                opencode: opencodeBinary.bin,
                legalworkServer: legalworkServerBinary.bin,

              },
              ports: {
                legalwork: legalworkPort,

              },
              opencode: {
                corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
                username: opencodeUsername,
                password: opencodePassword,
                hotReload: opencodeHotReload,
                logLevel: opencodeLogLevel,
              },
              legalwork: {
                token: legalworkToken,
                hostToken: legalworkHostToken,
                approvalMode: approvalMode === "auto" ? "auto" : "manual",
                approvalTimeoutMs,
                readOnly,
                corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
                opencodeUsername,
                opencodePassword,
                logFormat,
              },
              runId,
              logFormat,
              detach: detachRequested,
              logger,
            });

      sandboxCleanup = sandboxChild.cleanup;
      tui?.updateService("opencode", {
        status: "running",
        port: SANDBOX_INTERNAL_OPENCODE_PORT,
      });
      tui?.updateService("legalwork-server", {
        status: "running",
        port: legalworkPort,
      });

      if (!detachRequested) {
        children.push({ name: "sandbox", child: sandboxChild.child });
        logger.info(
          "Process spawned",
          { pid: sandboxChild.child.pid ?? 0, containerName },
          "sandbox",
        );
        sandboxChild.child.on("exit", (code, signal) =>
          handleExit("sandbox", code, signal),
        );
        sandboxChild.child.on("error", (error) =>
          handleSpawnError("sandbox", error),
        );
      } else {
        // docker run -d exits quickly; the container continues to run.
        logger.info("Sandbox detached", { containerName }, "sandbox");
      }

      logger.info(
        "Waiting for health",
        { url: legalworkBaseUrl },
        "legalwork-server",
      );
      await waitForHealthy(legalworkBaseUrl);
      logger.info("Healthy", { url: legalworkBaseUrl }, "legalwork-server");
      tui?.updateService("legalwork-server", { status: "healthy" });

      opencodeClient = OpenCode.make({
        baseUrl: `${legalworkBaseUrl.replace(/\/$/, "")}/opencode`,
        headers: { Authorization: `Bearer ${legalworkToken}` },
      });

      // In sandbox mode, the released legalwork-server binary may not have our
      // latest proxy/auth changes yet.  Instead of using the OpenCode SDK client
      // (which relies on the proxy handling Bearer tokens), do a direct health
      // check against the legalwork-server's own /opencode proxy path.  If the
      // server is healthy *and* is proxying to a healthy opencode, we're good.
      logger.info(
        "Waiting for health (proxy)",
        { url: `${legalworkBaseUrl}/opencode` },
        "opencode",
      );
      await waitForHealthyViaProxy(
        `${legalworkBaseUrl.replace(/\/$/, "")}/opencode`,
        legalworkToken,
      );
      logger.info(
        "Healthy (proxy)",
        { url: `${legalworkBaseUrl}/opencode` },
        "opencode",
      );
      tui?.updateService("opencode", { status: "healthy" });

      try {
        legalworkActualVersion = await verifyLegalworkServer({
          baseUrl: legalworkBaseUrl,
          token: legalworkToken,
          hostToken: legalworkHostToken,
          expectedVersion: legalworkServerBinary.expectedVersion,
          expectedWorkspace: "/workspace",
          expectedOpencodeDirectory: "/workspace",
        });
      } catch (verifyError) {
        // In sandbox mode the released server binary may differ from the
        // expected version or lack capabilities we just added locally.  Log
        // the mismatch but don't abort — the health checks above already
        // proved the server is running and proxying correctly.
        logger.warn(
          "Sandbox server verification warning (non-fatal)",
          { error: String(verifyError) },
          "legalwork-server",
        );
      }

      logVerbose(
        `legalwork-server version: ${legalworkActualVersion ?? "unknown"}`,
      );
    } else {
      const startedLegalworkChild = await startLegalworkServer({
        bin: legalworkServerBinary.bin,
        host: legalworkHost,
        port: legalworkPort,
        workspace: resolvedWorkspace,
        token: legalworkToken,
        hostToken: legalworkHostToken,
        approvalMode: approvalMode === "auto" ? "auto" : "manual",
        approvalTimeoutMs,
        readOnly,
        corsOrigins: corsOrigins.length ? corsOrigins : ["*"],
        managedOpencode: managedOpencodeOptions,
        logger,
        runId,
        logFormat,
        controlBaseUrl,
        controlToken,
      });
      legalworkChild = startedLegalworkChild;
      children.push({ name: "legalwork-server", child: startedLegalworkChild });
      tui?.updateService("legalwork-server", {
        status: "running",
        pid: startedLegalworkChild.pid ?? undefined,
        port: legalworkPort,
      });
      logger.info(
        "Process spawned",
        { pid: startedLegalworkChild.pid ?? 0 },
        "legalwork-server",
      );
      startedLegalworkChild.on("exit", (code, signal) =>
        handleExit("legalwork-server", code, signal),
      );
      startedLegalworkChild.on("error", (error) =>
        handleSpawnError("legalwork-server", error),
      );

      logger.info(
        "Waiting for health",
        { url: legalworkBaseUrl },
        "legalwork-server",
      );
      await waitForHealthy(legalworkBaseUrl);
      logger.info("Healthy", { url: legalworkBaseUrl }, "legalwork-server");
      tui?.updateService("legalwork-server", { status: "healthy" });

      legalworkActualVersion = await verifyLegalworkServer({
        baseUrl: legalworkBaseUrl,
        token: legalworkToken,
        hostToken: legalworkHostToken,
        expectedVersion: legalworkServerBinary.expectedVersion,
        expectedWorkspace: resolvedWorkspace,
        expectedOpencodeDirectory: resolvedWorkspace,
      });
      logVerbose(
        `legalwork-server version: ${legalworkActualVersion ?? "unknown"}`,
      );

      opencodeClient = OpenCode.make({ baseUrl: opencodeBaseUrl, headers: { Authorization: `Bearer ${legalworkToken}` } });
      await waitForManagedOpencodeHealthy(opencodeClient, startedLegalworkChild, legalworkBaseUrl);
      opencodeActualVersion = (await opencodeClient.server.info()).version;
      tui?.updateService("opencode", { status: "healthy", port: opencodePort });

    }

    if (workerActivityHeartbeat.enabled && !checkOnly) {
      logger.info(
        "Worker activity heartbeat enabled",
        {
          workerId: workerActivityHeartbeat.workerId,
          intervalMs: workerActivityHeartbeat.intervalMs,
          activeWindowMs: workerActivityHeartbeat.activeWindowMs,
        },
        "legalwork-orchestrator",
      );
      const runHeartbeat = () => {
        void postWorkerActivityHeartbeat({
          config: workerActivityHeartbeat,
          opencodeClient,
          logger,
        }).catch((error) => {
          logger.warn(
            "Worker activity heartbeat failed",
            { error: error instanceof Error ? error.message : String(error) },
            "legalwork-orchestrator",
          );
        });
      };
      runHeartbeat();
      workerActivityHeartbeatInterval = setInterval(
        runHeartbeat,
        workerActivityHeartbeat.intervalMs,
      );
    }

    const payload = {
      runId,
      workspace: resolvedWorkspace,
      approval: {
        mode: approvalMode,
        timeoutMs: approvalTimeoutMs,
        readOnly,
      },
      opencode: {
        baseUrl: opencodeBaseUrl,
        connectUrl: opencodeConnectUrl,
        authentication: "legalwork-bearer",
        bindHost: opencodeBindHost,
        port: opencodePort,
        hotReload: opencodeHotReload,
        version: opencodeActualVersion,
      },
      legalwork: {
        baseUrl: legalworkBaseUrl,
        connectUrl: legalworkConnectUrl,
        host: legalworkHost,
        port: legalworkPort,
        collaboratorToken: legalworkToken,

        token: legalworkToken,
        hostToken: legalworkHostToken,
        version: legalworkActualVersion,
      },

      diagnostics: {
        cliVersion,
        sidecar: {
          dir: sidecar.dir,
          target: sidecar.target,
          source: sidecarSource,
          opencodeSource,
          allowExternal,
        } as SidecarDiagnostics,
        binaries: {
          opencode: {
            path: opencodeBinary.bin,
            source: opencodeBinary.source,
            expectedVersion: opencodeBinary.expectedVersion,
            actualVersion: opencodeActualVersion,
          } as BinaryDiagnostics,
          legalworkServer: {
            path: legalworkServerBinary.bin,
            source: legalworkServerBinary.source,
            expectedVersion: legalworkServerBinary.expectedVersion,
            actualVersion: legalworkActualVersion,
          } as BinaryDiagnostics,
        },
      },
    };

    if (outputJson) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (useTui) {
      logger.info(
        "Ready",
        {
          workspace: payload.workspace,
          opencode: payload.opencode,
          legalwork: payload.legalwork,
        },
        "legalwork-orchestrator",
      );
    } else if (logFormat === "json") {
      logger.info(
        "Ready",
        {
          workspace: payload.workspace,
          opencode: payload.opencode,
          legalwork: payload.legalwork,
        },
        "legalwork-orchestrator",
      );
    } else {
      console.log("LegalWork orchestrator running");
      console.log(`Run ID: ${runId}`);
      console.log(`Workspace: ${payload.workspace}`);
      console.log(`OpenCode: ${payload.opencode.baseUrl}`);
      console.log(`OpenCode connect URL: ${payload.opencode.connectUrl}`);
      console.log("OpenCode auth: LegalWork token through its scoped proxy");
      console.log(`LegalWork server: ${payload.legalwork.baseUrl}`);
      console.log(`LegalWork connect URL: ${payload.legalwork.connectUrl}`);
      console.log("LegalWork collaborator token: issued (withheld from stdout)");
      console.log("  Routine remote access for shared workers.");
      console.log("LegalWork host admin token: issued (withheld from stdout)");
      console.log(
        "  Internal host/admin token for approvals CLI and host-only APIs.",
      );
      console.log(
        "Use `--json` only when you explicitly need raw credentials in command output.",
      );
    }

    if (detachRequested) {
      await handleDetach();
    }

    if (checkOnly) {
      try {
        if (sandboxMode !== "none") {
          // In sandbox mode the released server binary may not support the
          // Bearer-through-proxy auth that the OpenCode SDK client expects.
          // Run a lighter set of checks: legalwork-server endpoints + proxy
          // health.  Full SDK checks (session create, SSE events) are deferred
          // until the modified server binary is released.
          await runSandboxChecks({
            legalworkUrl: legalworkBaseUrl,
            legalworkToken,
            hostToken: legalworkHostToken,
          });
        } else {
          await runChecks({
            directory:resolvedWorkspace,
            opencodeClient,
            legalworkUrl: legalworkBaseUrl,
            legalworkToken,
            hostToken: legalworkHostToken,
            checkEvents,
          });
        }
        logger.info("Checks ok", { checkEvents }, "legalwork-orchestrator");
        if (!outputJson && logFormat === "pretty") {
          console.log("Checks: ok");
        }
      } catch (error) {
        logger.error(
          "Checks failed",
          { error: String(error) },
          "legalwork-orchestrator",
        );
        await shutdown();
        tui?.stop();
        process.exit(1);
      }
      await shutdown();
      tui?.stop();
      process.exit(0);
    }

    await new Promise(() => undefined);
  } catch (error) {
    await shutdown();
    tui?.stop();
    logger.error(
      "Run failed",
      { error: error instanceof Error ? error.message : String(error) },
      "legalwork-orchestrator",
    );
    process.exit(1);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertNoRetiredBinaryDownloads(args.flags);
  if (readBool(args.flags, "help", false) || args.flags.get("help") === true) {
    printHelp();
    return;
  }
  if (
    readBool(args.flags, "version", false) ||
    args.flags.get("version") === true
  ) {
    console.log(await resolveCliVersion());
    return;
  }

  const command = args.positionals[0] ?? "start";
  if (command === "start") {
    await runStart(args);
    return;
  }
  if (command === "serve") {
    args.flags.set("tui", false);
    await runStart(args);
    return;
  }
  if (command === "daemon") {
    await runDaemonCommand(args);
    return;
  }
  if (command === "workspace" || command === "workspaces" || command === "instance") {
    outputError(new Error(retiredDeveloperLauncherMessage), readBool(args.flags, "json", false));
    process.exitCode = 1;
    return;
  }
  if (command === "approvals") {
    await runApprovals(args);
    return;
  }
  if (command === "files") {
    await runFiles(args);
    return;
  }
  if (command === "status") {
    await runStatus(args);
    return;
  }

  printHelp();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
