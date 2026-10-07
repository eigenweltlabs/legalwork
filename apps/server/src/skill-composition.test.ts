import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("expert correction composes in a fresh load, preserves base, respects scope, detects updates and cycles", async () => {
  const root = await mkdtemp(join(tmpdir(), "skill-composition-"));
  const script = join(root, "check.mjs");
  await writeFile(script, `
    import { mkdir, readFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import assert from 'node:assert/strict';
    const { upsertSkill, listSkills } = await import(${JSON.stringify(new URL("./skills.ts", import.meta.url).href)});
    const { composedSkill, skillFingerprint } = await import(${JSON.stringify(new URL("./skill-composition.ts", import.meta.url).href)});
    const workspace = join(process.env.XDG_CONFIG_HOME, 'project');
    const other = join(process.env.XDG_CONFIG_HOME, 'other');
    await mkdir(join(workspace, '.git'), { recursive:true });
    await mkdir(join(other, '.git'), { recursive:true });
    const base = await upsertSkill(workspace, { name:'de-civil-demo', description:'Civil deadlines.', content:'Use the installed calculator for established periods.', scope:'global' });
    const original = await readFile(base.path,'utf8');
    const lesson = { base:'de-civil-demo', appliesWhen:'German payment orders, distinguish requested legal cutoff from diary entry.', correction:'For the absolute Widerspruch cutoff under §694(1) ZPO, request whether/when the Vollstreckungsbescheid was ordered. Unknown means needs_information and no date. Two weeks is not a Notfrist.', examples:[{input:'Served 12 Jan 2026, absolute cutoff, subsequent record absent',expected:'needs_information; no deadline'}, {input:'Same service, ordinary two-week diary entry',expected:'26 Jan 2026; never label absolute cutoff'}] };
    const extension = await upsertSkill(workspace, { name:'payment-order-correction', description:'Use for Mahnbescheid.', content:'Apply this scoped correction.', scope:'project', lesson });
    const extensionText = await readFile(extension.path, 'utf8');
    const extensionHash = await skillFingerprint(extension.path);
    const listed = (await listSkills(workspace, true)).find(item => item.name === 'payment-order-correction');
    assert.equal(listed.kind, 'workflow');
    assert.equal(listed.path, extension.path);
    assert.equal(listed.scope, 'project');
    assert.equal(await readFile(extension.path, 'utf8'), extensionText);
    assert.equal(await skillFingerprint(extension.path), extensionHash);
    assert.equal(await readFile(base.path,'utf8'),original);
    const loaded = await composedSkill(workspace,'de-civil-demo');
    assert.equal(loaded.chain.length,2);
    assert.match(loaded.chain[1].content,/needs_information/);
    assert.match(loaded.chain[1].content,/26 Jan 2026/);
    assert.equal((await composedSkill(other,'de-civil-demo')).chain.length,1);
    assert.equal((await composedSkill(workspace,'payment-order-correction')).chain.length,2);
    await assert.rejects(upsertSkill(workspace,{name:'de-civil-demo',content:'Cycle',description:'Cycle',lesson:{...lesson,base:'payment-order-correction'}}),{code:'skill_cycle'});
    await writeFile(base.path, original+'\\nChanged code-selection guidance.\\n');
    await assert.rejects(composedSkill(workspace,'de-civil-demo'),{code:'skill_base_changed'});
    console.log('fresh load, original preserved, positive and negative example, scoped, cycle and update checks passed');
  `);
  try {
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, XDG_CONFIG_HOME: root }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("checks passed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("workflow bases and descendants compose automatically and support installed Python code", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-composition-"));
  const script = join(root, "check.mjs");
  await writeFile(script, `
    import { mkdir, writeFile } from 'node:fs/promises';
    import { dirname, join } from 'node:path';
    import assert from 'node:assert/strict';
    const { upsertSkill, listSkills } = await import(${JSON.stringify(new URL("./skills.ts", import.meta.url).href)});
    const { composedSkill } = await import(${JSON.stringify(new URL("./skill-composition.ts", import.meta.url).href)});
    const { calculationScript, executePython } = await import(${JSON.stringify(new URL("./calculations/python-runner.ts", import.meta.url).href)});
    const workspace = join(process.env.XDG_CONFIG_HOME, 'project');
    const other = join(process.env.XDG_CONFIG_HOME, 'other');
    await mkdir(join(workspace, '.git'), { recursive:true });
    await mkdir(join(other, '.git'), { recursive:true });
    const baseName = 'workflow-assistant-custom-calculation';
    const base = await upsertSkill(workspace, { name:baseName, description:'Use for custom calculations.', content:'Read the facts, then run the installed code.', scope:'global' });
    await assert.rejects(calculationScript(workspace, baseName), { code:'calculation_code_missing' });
    await mkdir(join(dirname(base.path), 'resources'));
    const code = 'def calculate(inputs, recorder):\\n    return {"status":"needs_information","missingFacts":["Later procedural record"]}\\n';
    await writeFile(join(dirname(base.path), 'resources/calculation.py'), code);
    const lesson = { base:baseName, appliesWhen:'Requested absolute cutoff.', correction:'Require the later procedural record.', examples:[{input:'Missing record',expected:'No date'}] };
    const globalName = 'workflow-assistant-cutoff-correction';
    await upsertSkill(workspace, { name:globalName, description:'Use for cutoff questions.', content:'Check later events.', scope:'global', lesson });
    await upsertSkill(workspace, { name:'workflow-assistant-project-correction', description:'Use for this project.', content:'Additional project instruction.', scope:'project', lesson:{...lesson,base:globalName} });
    const loaded = await calculationScript(workspace, baseName);
    assert.equal(loaded.code, code);
    assert.deepEqual(loaded.composed.chain.map(item => item.name), [baseName, globalName, 'workflow-assistant-project-correction']);
    assert.deepEqual((await composedSkill(other, baseName)).chain.map(item => item.name), [baseName, globalName]);
    assert.equal((await listSkills(other, true)).find(item => item.name === globalName).kind, 'workflow');
    const result = await executePython(loaded.code, {});
    assert.equal(result.result.status, 'needs_information');
    assert.deepEqual(result.result.results, []);
    await writeFile(base.path, '---\\nname: '+baseName+'\\ndescription: Changed\\n---\\nChanged code selection.');
    await assert.rejects(calculationScript(workspace, baseName), { code:'skill_base_changed' });
    console.log('workflow discovery, composition, scope, executable and pinned version checks passed');
  `);
  try {
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, XDG_CONFIG_HOME: root }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("checks passed");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 180000);

test("older shipped skills and their corrections receive the current tool contract without changing pinned files", async () => {
  const root = await mkdtemp(join(tmpdir(), "deadline-tool-guide-"));
  const script = join(root, "check.mjs");
  await writeFile(script, `
    import { mkdir, readFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import assert from 'node:assert/strict';
    const { upsertSkill } = await import(${JSON.stringify(new URL("./skills.ts", import.meta.url).href)});
    const { composedSkill, skillFingerprint } = await import(${JSON.stringify(new URL("./skill-composition.ts", import.meta.url).href)});
    const workspace = join(process.env.XDG_CONFIG_HOME, 'project');
    await mkdir(join(workspace, '.git'), { recursive:true });
    const base = await upsertSkill(workspace, { name:'de-civil-deadlines', description:'German deadlines.', content:'Read this skill before calculating. The executable exports calculate(input) and can be imported by Node.js.', scope:'global' });
    const original = await readFile(base.path, 'utf8');
    const hash = await skillFingerprint(base.path);
    await upsertSkill(workspace, { name:'payment-order-correction', description:'Payment orders.', content:'Distinguish the requested cutoff.', scope:'project', lesson:{base:'de-civil-deadlines', appliesWhen:'Absolute objection cutoff.', correction:'Missing later procedural facts means no date.', examples:[{input:'Absolute cutoff, later record absent',expected:'No date'},{input:'Ordinary response period',expected:'Calculate the supported period'}]} });
    for (const name of ['de-civil-deadlines', 'payment-order-correction']) {
      const loaded = await composedSkill(workspace, name);
      assert.equal(loaded.chain.length, 2);
      const guide = loaded.calculationGuide;
      assert.equal(guide.calculate.tool, 'legalwork_deadline_calculate');
      assert.equal(guide.present.tool, 'legalwork_calculation_present');
      const schema = guide.calculate.argumentsSchema;
      assert.deepEqual(schema.properties.skill.enum, ['de-civil-deadlines']);
      assert.equal(schema.properties.input.properties.triggerDate.format, 'date');
      assert.deepEqual(schema.properties.input.properties.unit.enum, ['days','weeks','months','years']);
      assert.equal(schema.properties.input.additionalProperties, false);
      assert.match(guide.instruction, /No external-folder access is needed/);
      assert.match(guide.present.guidance, /without requiring the user to ask for a card/);
      assert.match(guide.interaction, /mode=show by default/);
      assert.equal(loaded.chain[0].hash, hash);
    }
    assert.equal(await readFile(base.path, 'utf8'), original);
    assert.equal(await skillFingerprint(base.path), hash);
    await upsertSkill(workspace, { name:'custom-calculator', description:'Custom calculation.', content:'My own script and presentation.', scope:'global' });
    assert.equal((await composedSkill(workspace, 'custom-calculator')).calculationGuide, undefined);
    console.log('legacy instructions, composed corrections, actual tool schema, preserved pins, and optional community presentation passed');
  `);
  try {
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env, XDG_CONFIG_HOME: root }, stdout: "pipe", stderr: "pipe" });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    expect(stdout).toContain("optional community presentation passed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
