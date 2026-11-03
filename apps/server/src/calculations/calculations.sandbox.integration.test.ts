import { expect, test } from "bun:test";
import { executePython } from "./python-runner.js";

const python = `from datetime import date, timedelta

def end(trigger, weeks):
    return (date.fromisoformat(trigger) + timedelta(weeks=weeks)).isoformat()

def calculate(inputs, recorder):
    if inputs["purpose"] == "absolute_cutoff":
        return {"status": "needs_information", "missingFacts": ["Whether and when a Vollstreckungsbescheid was ordered (§694(1) ZPO)."]}
    day = recorder.step("Two-week response period", "Count weeks from the service event", end, inputs["service"], 2)
    return {"status": "calculated", "results": [{"title": "Ordinary response", "date": day, "cutoff": "2026-01-26T23:00:00Z", "timeZone": "Europe/Berlin"}]}
`;
// The sandbox runtime job supplies the VM assets; ordinary unit tests do not.
test.skipIf(process.env.LEGALWORK_SANDBOX_INTEGRATION !== "1")("community code records actual function inputs/outputs; payment-order selection refuses a fabricated longstop", async () => {
  const ordinary = await executePython(python, { purpose: "ordinary_response", service: "2026-01-12" });
  expect(ordinary.result.results[0].date).toBe("2026-01-26");
  expect(ordinary.steps[0].inputs).toEqual({ trigger: "2026-01-12", weeks: 2 });
  expect(ordinary.steps[0].output).toBe("2026-01-26");
  expect(ordinary.steps[0].code).toContain("timedelta(weeks=weeks)");
  const absolute = await executePython(python, { purpose: "absolute_cutoff", service: "2026-01-12" });
  expect(absolute.result.status).toBe("needs_information");
  expect(absolute.result.results).toEqual([]);
  await expect(executePython(`def calculate(inputs, recorder):\n return {"status":"needs_information", "results":[{"title":"Wrong", "date":"2026-01-26", "cutoff":"2026-01-26T23:00:00Z", "timeZone":"Europe/Berlin"}]}`, {})).rejects.toThrow("Missing-information");
// Allow the shared VM cold boot and three isolated commands under software emulation.
}, 600000);

