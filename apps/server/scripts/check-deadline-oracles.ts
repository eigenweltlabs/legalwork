/** HTTP-only comparisons; never starts a browser or touches LegalWork UI. */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { z } from "zod";
import { calculateDeadline } from "../src/calendar/deadline-rules.js";

const widgetUrl = "https://load.smart-rechner.de/widget/fristen.js";
// Reviewed on 2026-09-30. A changed widget requires review before execution.
const widgetHash = "562fec3956279990ee12bb364988a71d041be6b094c4c5e4ef29c11d9330f06f";
const endpoint = "https://gebuehren-portal.de/api/backend/fristen/calculate_fristen";
const fixtureUrl = new URL("../src/calendar/fixtures/deadline-oracles.json", import.meta.url);
const cases = [
  { triggerDate: "2026-01-31", duration: 1, unit: "months", region: "NW" },
  { triggerDate: "2024-01-31", duration: 1, unit: "months", region: "NW" },
  { triggerDate: "2025-01-31", duration: 1, unit: "months", region: "NW" },
  { triggerDate: "2026-03-31", duration: 1, unit: "months", region: "NW" },
  { triggerDate: "2026-04-02", duration: 1, unit: "days", region: "NW" },
  { triggerDate: "2025-06-18", duration: 1, unit: "days", region: "NW" },
  { triggerDate: "2025-11-18", duration: 1, unit: "days", region: "SN" },
  { triggerDate: "2025-05-07", duration: 1, unit: "days", region: "BE" },
  { triggerDate: "2026-12-24", duration: 1, unit: "days", region: "NW" },
  { triggerDate: "2026-09-30", duration: 1, unit: "weeks", region: "NW" },
] as const;

async function request(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Oracle returned ${response.status}: ${url}`);
  return response;
}
function ltoOracle(packed: string) {
  const match = packed.match(/}\('((?:\\.|[^'])*)',(\d+),(\d+),'((?:\\.|[^'])*)'\.split\('\|'\),0,\{\}\)\)/);
  if (!match) throw new Error("LTO widget format changed; review the adapter.");
  // Decode string literals only. The widget initialization/ads/DOM code never executes.
  const literal = (text: string): string => z.string().parse(vm.runInNewContext(`'${text}'`, {}, { timeout: 1000 }));
  const payload = literal(match[1]), words = literal(match[4]).split("|"), radix = Number(match[2]);
  const digits = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const encode = (n: number): string => n < radix ? digits[n] : encode(Math.floor(n / radix)) + digits[n % radix];
  const dictionary = new Map<string, string>();
  for (let i = 0; i < Number(match[3]); i++) if (words[i]) dictionary.set(encode(i), words[i]);
  const text = payload.replace(/\b\w+\b/g, key => dictionary.get(key) ?? key);
  const source = ts.createSourceFile("widget.js", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const functions = new Map<string, ts.FunctionDeclaration>();
  function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node); ts.forEachChild(node, visit); }
  visit(source);
  const supplied = new Set(["myParseDate", "str2num", "formatFromISODate", "render", "two"]), selected = new Map<string, string>();
  function select(name: string) {
    if (supplied.has(name) || selected.has(name)) return;
    const node = functions.get(name); if (!node) throw new Error(`Missing reviewed calculator helper ${name}`);
    selected.set(name, node.getText(source));
    function calls(child: ts.Node) {
      if (ts.isCallExpression(child) && ts.isIdentifier(child.expression) && functions.has(child.expression.text)) select(child.expression.text);
      ts.forEachChild(child, calls);
    }
    calls(node);
  }
  select("calc"); select("date");
  const realm = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(`
    var value, value_array, feiertage=[], lastYear=0, lastBula='', last_is_only_official=[], list_official_in;
    var frist_anfang, frist_art, bundesland, willenserklaerung, fristdauer_zeitraum, fristdauer_anzahl;
    var $={each(array,fn){for(var i=0;i<array.length;i++)if(fn(i,array[i])===false)break;}};
    Date.prototype.addDays=function(n){this.setDate(this.getDate()+n);return this;};
    function two(n){return String(n).padStart(2,'0')}
    function myParseDate(s){return new Date(s.year,s.month-1,s.day)}
    function str2num(n){return Number(n)}
    function formatFromISODate(format,d){return d.getFullYear()+'-'+two(d.getMonth()+1)+'-'+two(d.getDate())}
    function render(){return value.frist_ende_iso}
  `, realm, { timeout: 1000 });
  vm.runInContext([...selected.values()].join("\n"), realm, { timeout: 1000 });
  return (input: typeof cases[number]) => {
    const [year, month, day] = input.triggerDate.split("-").map(Number), units = { months: "Monate", days: "Tage", weeks: "Wochen" };
    const fields = JSON.stringify({ year, month, day, region: input.region, unit: units[input.unit], duration: input.duration });
    return z.iso.date().parse(vm.runInContext(`var input=${fields}; frist_anfang=input;
      frist_art={val:()=> 'Ereignisfrist'};bundesland={val:()=>input.region};
      willenserklaerung={find:()=>({val:()=> 'ja'})};fristdauer_zeitraum={val:()=>input.unit};
      fristdauer_anzahl={val:()=>input.duration};calc()`, realm, { timeout: 1000 }));
  };
}

const packed = await (await request(widgetUrl)).text();
if (createHash("sha256").update(packed).digest("hex") !== widgetHash) throw new Error("LTO executable changed; review it before updating its pinned hash.");
const lto = ltoOracle(packed), captured = [];
for (const input of cases) {
  const calculated = calculateDeadline({ ...input, rule: "de-zpo-period", source: "Synthetic oracle test; no client data" }).deadlineDay;
  const ltoDate = lto(input);
  const body = { bundesland: input.region, court_type: "Eigene Frist", deadline_type: "Eigene Frist", date_of_service: input.triggerDate,
    extension_years: 0, extension_months: input.unit === "months" ? input.duration : 0, extension_weeks: input.unit === "weeks" ? input.duration : 0, extension_days: input.unit === "days" ? input.duration : 0 };
  const portalDate = z.object({ final_deadline: z.iso.date() }).parse(await (await request(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json()).final_deadline;
  if (calculated !== ltoDate || calculated !== portalDate) throw new Error(`Oracle mismatch ${JSON.stringify({ input, calculated, ltoDate, portalDate })}. Check primary law; never copy an oracle defect into production.`);
  captured.push({ input, calculated, ltoDate, portalDate });
}
if (process.argv.includes("--record")) {
  await mkdir(new URL("../src/calendar/fixtures/", import.meta.url), { recursive: true });
  await writeFile(fixtureUrl, JSON.stringify({ capturedAt: new Date().toISOString(), widgetUrl, widgetHash, endpoint, cases: captured }, null, 2) + "\n");
} else {
  const recorded = z.object({ cases: z.array(z.unknown()) }).parse(JSON.parse(await readFile(fixtureUrl, "utf8")));
  if (JSON.stringify(recorded.cases) !== JSON.stringify(captured)) throw new Error("Oracle responses changed since the recorded release; inspect before replacing fixtures.");
}
console.log(`${captured.length} cases matched both live German calculators through HTTP and the isolated calculator adapter.`);
