import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { estimateHostedCapacity, validateCapacityInputs, capacityTable } from './hosted-capacity.mjs';
const base = JSON.parse(await readFile(new URL('../../docs/mail-hosted-capacity-inputs.json', import.meta.url), 'utf8'));
const input = () => structuredClone(base);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-7, `${a} differs from ${b}`);

test('fleet allocation conserves complete accounts for small fractional mixes and multiple accounts per owner', () => {
  for (const users of [1, 2, 3, 7, 25, 101]) {
    const c = input(); c.accountsPerUser = 3; const e = estimateHostedCapacity(c, users);
    assert.equal(Object.values(e.mix).reduce((a, b) => a + b, 0), users * 3);
    assert.ok(Object.values(e.mix).every(count => Number.isInteger(count) && count >= 0));
  }
  const one = input(), two = input(); two.accountsPerUser = 2;
  const a = estimateHostedCapacity(one, 100), b = estimateHostedCapacity(two, 100);
  close(b.capacity.memoryGiB - a.capacity.memoryGiB, 100 * one.capacity.accountMemoryMiB / 1024 * one.capacity.headroom);
});
test('zero Gmail has no Gmail delay and exhausting daily headroom remains distinct from minute-rate capacity', () => {
  const c = input(); c.providerMix = { gmail: 0, graph: 1, imap: 0 };
  assert.equal(estimateHostedCapacity(c, 100).gmail.backfillDaysBelowDailyThreshold, 0);
  const d = input(); d.gmail.dailyBillingThresholdUnits = 1;
  const e = estimateHostedCapacity(d, 100);
  assert.equal(e.gmail.backfillDaysBelowDailyThreshold, null);
  assert.ok(e.gmail.minimumBackfillDaysAtMinuteBudgets > 0);
  d.gmail.projectUnitsPerMinute = 1;
  assert.equal(estimateHostedCapacity(d, 100).gmail.minimumBackfillDaysAtMinuteBudgets, null);
  assert.equal(estimateHostedCapacity(d, 100).gmail.concurrentBackfills, 0);
});
test('raw-message cost changes the safe interval and initial quota burden without altering mailbox ownership', () => {
  const c = input(), d = input(); d.gmail.rawUnits = 20;
  const raw = estimateHostedCapacity(c, 100), metadata = estimateHostedCapacity(d, 100);
  assert.equal(raw.gmail.rawReadIntervalMs, 750); assert.equal(metadata.gmail.rawReadIntervalMs, 250);
  assert.ok(raw.gmail.initialUnits > metadata.gmail.initialUnits * 2.9);
  assert.deepEqual(raw.mix, metadata.mix);
});
test('folder count and slower polling expose current Graph and full IMAP scan costs', () => {
  const c = input(), fewerFolders = input(), slower = input(); fewerFolders.workload.graphFolders = 1; slower.workload.pollSeconds = 300;
  const a = estimateHostedCapacity(c, 100), b = estimateHostedCapacity(fewerFolders, 100), d = estimateHostedCapacity(slower, 100);
  assert.ok(a.traffic.httpRequestsMonth > b.traffic.httpRequestsMonth * 3);
  close(a.traffic.imapRowsDay, 5 * d.traffic.imapRowsDay);
  assert.ok(a.capacity.vcpu > d.capacity.vcpu);
  assert.equal(a.capacity.primaryGiB, d.capacity.primaryGiB);
});
test('extra device replicas add transfer without adding owner workers or server data copies', () => {
  const c = input(), d = input(); d.capacity.deviceReplicas = 0;
  const a = estimateHostedCapacity(c, 100), b = estimateHostedCapacity(d, 100);
  assert.equal(b.capacity.steadyDeviceEgressGiBMonth, 0); assert.equal(b.capacity.initialDeviceEgressGiB, 0);
  assert.equal(a.capacity.hostedStorageGiB, b.capacity.hostedStorageGiB);
  assert.equal(a.capacity.memoryGiB, b.capacity.memoryGiB);
  assert.ok(a.costs.totalMonth > b.costs.totalMonth);
});
test('cost totals include shared operations, separate initial transfer and transparent configurable unit prices', () => {
  const c = input(), e = estimateHostedCapacity(c, 100);
  close(e.costs.totalMonth, e.costs.compute + e.costs.memory + e.costs.storage + e.costs.deviceEgress + e.costs.operations + e.costs.fixed);
  close(e.costs.perUserMonth * 100, e.costs.totalMonth);
  assert.ok(e.costs.initialDeviceEgress > 0);
  for (const key of Object.keys(c.rates)) c.rates[key] = 0;
  assert.equal(estimateHostedCapacity(c, 100).costs.totalMonth, 0);
});
test('malformed, incomplete, negative, fractional allocation and nonfinite inputs cannot produce a misleading estimate', () => {
  for (const mutate of [c => { c.providerMix.gmail = 0.9; }, c => { c.capacity.headroom = 0; }, c => { c.capacity.deviceReplicas = 1.5; }, c => { c.workload.pollSeconds = 0; }, c => { c.rates.storageGiBMonth = -1; }, c => { c.workload.meanRawKiB = NaN; }, c => { c.capacity.workerMemoryMiB = Infinity; }, c => { c.gmail.rawUnits = 0; }, c => { c.rates.remoteUpload = 1; }, c => { delete c.gmail.userUnitsPerMinute; }]) {
    const c = input(); mutate(c); assert.throws(() => validateCapacityInputs(c));
  }
  assert.throws(() => estimateHostedCapacity(input(), 0)); assert.throws(() => estimateHostedCapacity(input(), 1.5));
  const imprecise = input(); imprecise.workload.meanRawKiB = Number.EPSILON;
  assert.throws(() => estimateHostedCapacity(imprecise, 100));
  assert.ok(capacityTable(input()).includes('| 500 | 200/200/100 |'));
});
