import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { ConfigGetOutput } from "@opencode/client";
import { Config } from "@opencode/schema/config";
import { ConfigAgent } from "@opencode/schema/config/agent";
import { Option, Schema } from "effect";
import { parseFrontmatter } from "./frontmatter.js";
import { nativeAgent } from "./native-opencode-config.js";
import { unchangedCoreFile } from "./core-bundle.js";

const decodeAgent = Schema.decodeUnknownOption(ConfigAgent.Info);
const agentKeys = new Set(["variant", ...Object.keys(ConfigAgent.Info.fields)]);
const nativeKeys = ["permissions", "request", "system", "disabled"];

// Same discovery order as the pinned native ConfigAgent plugin: recursive
// agent(s), then flat primary mode(s). Linked libraries retain cycle protection.
async function files(root: string, recursive: boolean, ancestors: ReadonlySet<string> = new Set()): Promise<string[]> {
  try {
    const actual = await realpath(root);
    if (ancestors.has(actual)) return [];
    const next = new Set([...ancestors, actual]);
    return (await Promise.all((await readdir(root, { withFileTypes: true })).map(async entry => {
      const path = join(root, entry.name);
      try {
        const info = entry.isSymbolicLink() ? await stat(path) : entry;
        if (info.isDirectory()) return recursive ? files(path, true, next) : [];
        return info.isFile() && entry.name.endsWith(".md") ? [path] : [];
      } catch { return []; }
    }))).flat();
  } catch { return []; }
}

/** Keep native declarations/overrides in their original order. Only verified,
 * unchanged app copies are omitted; the shared document already supplies them. */
export async function resolveNativeAgentDefinitions(entries: ConfigGetOutput, coreRoot: string) {
  const documents: Array<typeof Config.Info.Type> = [];
  const watchRoots: string[] = [];
  for (const entry of entries) {
    if (entry.type === "document") {
      const { agents, permissions, default_agent } = entry.info;
      documents.push(Schema.decodeUnknownSync(Config.Info)({
        ...(agents === undefined ? {} : { agents }), ...(permissions === undefined ? {} : { permissions }),
        ...(default_agent === undefined ? {} : { default_agent }),
      }));
      continue;
    }
    watchRoots.push(entry.path);
    for (const [names, primary] of [[ ["agent", "agents"], false ], [ ["mode", "modes"], true ]] satisfies Array<[string[], boolean]>) {
      const candidates = (await Promise.all(names.map(name => files(join(entry.path, name), !primary)))).flat().sort();
      for (const file of candidates) {
        if (await unchangedCoreFile(dirname(entry.path), file, coreRoot)) continue;
        try {
          const markdown = parseFrontmatter(await readFile(file, "utf8"));
          const name = relative(entry.path, file).replaceAll("\\", "/").replace(/^(agent|agents|mode|modes)\//, "").replace(/\.md$/, "");
          const data = typeof markdown.data.model === "string" && !markdown.data.model.includes("#")
            && typeof markdown.data.variant === "string" && /^[^#]+$/.test(markdown.data.variant)
            ? { ...markdown.data, model: `${markdown.data.model}#${markdown.data.variant}` } : markdown.data;
          const legacy = Object.keys(data).some(key => !agentKeys.has(key)) && !nativeKeys.some(key => Object.hasOwn(data, key));
          const options = data.options && typeof data.options === "object" && !Array.isArray(data.options) ? Object.fromEntries(Object.entries(data.options)) : {};
          const body = { ...options, ...(data.temperature === undefined ? {} : { temperature: data.temperature }), ...(data.top_p === undefined ? {} : { top_p: data.top_p }) };
          const input = legacy ? { ...nativeAgent({ ...data, variant: undefined, prompt: markdown.body.trim() }),
            ...(Object.keys(body).length ? { request: { body } } : {}),
            ...(typeof data.color === "string" && !data.color.startsWith("#") ? { color: "#aaaaaa" } : {}) }
            : { ...data, system: markdown.body.trim() };
          const agent = decodeAgent(input);
          if (Option.isSome(agent)) documents.push(Config.Info.make({ agents: { [name]: primary ? { ...agent.value, mode: "primary" } : agent.value } }));
        } catch { /* Native discovery ignores malformed/unreadable Markdown. */ }
      }
    }
  }
  return { documents, watchRoots };
}
