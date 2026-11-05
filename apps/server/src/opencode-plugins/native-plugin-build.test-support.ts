/** Bun 1.3.14 cannot reliably rebuild packages already imported in the test
 * runner. Compile fixtures in a fresh process, as production builds do. */
export async function buildNativePluginFixture(source: string, output: string, options: { bundleRuntime?: boolean } = {}): Promise<string> {
  const external = options.bundleRuntime ? [] : ["@opencode/plugin", "@opencode/plugin/*", "effect", "effect/*"];
  const build = Bun.spawn([process.execPath, "build", source, "--outfile", output, "--target", "node", "--format", "esm",
    ...external.flatMap(name => ["--external", name])], { stdout: "pipe", stderr: "pipe" });
  const [exit, stdout, stderr] = await Promise.all([build.exited, new Response(build.stdout).text(), new Response(build.stderr).text()]);
  if (exit !== 0) throw new Error(`Native fixture bundle failed:\n${stdout}${stderr}`);
  return output;
}
