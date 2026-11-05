import { expect, test } from "bun:test";
import { expandCommandTemplate } from "./native-command-template.js";

test("native command argument contract keeps quoted arguments and the last placeholder's remaining arguments", async () => {
  const noShell = async () => { throw new Error("Unexpected executable expansion"); };
  expect(await expandCommandTemplate("First $1; remaining $2", '"one two" three four', noShell)).toBe("First one two; remaining three four");
  expect(await expandCommandTemplate("Raw: $ARGUMENTS", '"one two" three', noShell)).toBe('Raw: "one two" three');
  expect(await expandCommandTemplate("Review", "the contract", noShell)).toBe("Review\n\nthe contract");
  expect(await expandCommandTemplate("Missing $2", "one", noShell)).toBe("Missing");
});
test("command interpolation keeps full ordered output and does not recursively execute its contents", async () => {
  const tick = String.fromCharCode(96), interpolation = (source: string) => "!" + tick + source + tick;
  const full = "§".repeat(1100000) + interpolation("never-run");
  const called: string[] = [];
  const output = await expandCommandTemplate("Result " + interpolation("first") + "; " + interpolation("second"), "", async source => {
    called.push(source);
    if (source === "first") { await Bun.sleep(10); return full; }
    return "tail";
  });
  expect(called).toEqual(["first", "second"]);
  expect(output).toBe("Result " + full + "; tail");
});
test("shell expansion introduced by arguments also uses the managed executor and denial is never swallowed", async () => {
  const input = "!" + String.fromCharCode(96) + "denied" + String.fromCharCode(96);
  await expect(expandCommandTemplate("$ARGUMENTS", input, async source => {
    expect(source).toBe("denied"); throw new Error("Permission denied");
  })).rejects.toThrow("Permission denied");
});
