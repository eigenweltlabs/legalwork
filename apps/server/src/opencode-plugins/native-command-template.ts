/** Preserve released v2 arguments/interpolation while supplying a managed executor. */
export async function expandCommandTemplate(template: string, input: string, execute: (source: string) => Promise<string>): Promise<string> {
  const args = (input.match(/(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi) ?? []).map(arg => arg.replace(/^["']|["']$/g, ""));
  const placeholders = template.match(/\$(\d+)/g) ?? [];
  const last = Math.max(0, ...placeholders.map(item => Number(item.slice(1))));
  const expanded = template.replace(/\$(\d+)/g, (_, index: string) => {
    const position = Number(index), argIndex = position - 1;
    if (argIndex >= args.length) return "";
    return position === last ? args.slice(argIndex).join(" ") : args[argIndex] ?? "";
  }).replaceAll("$ARGUMENTS", () => input);
  const text = placeholders.length === 0 && !template.includes("$ARGUMENTS") && input.trim() ? (expanded + "\n\n" + input).trim() : expanded.trim();
  const pattern = /!`([^`]+)`/g;
  const matches = [...text.matchAll(pattern)], outputs: string[] = [];
  let next = 0;
  const worker = async () => {
    while (next < matches.length) {
      const index = next++;
      outputs[index] = await execute(matches[index]![1]!);
    }
  };
  // Two concurrent expansions match upstream; every expansion remains available.
  await Promise.all(Array.from({ length: Math.min(2, matches.length) }, worker));
  let index = 0;
  return text.replace(pattern, () => outputs[index++]!);
}
