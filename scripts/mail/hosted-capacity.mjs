import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const providers = ['gmail', 'graph', 'imap'];
const GiB = 1024 ** 3;
const dayMinutes = 1440;
const numericGroups = {
  workload: 'pollSeconds graphFolders graphHierarchyListCalls graphAttachmentGetsPerMessage newMessagesPerAccountDay metadataChangesPerAccountDay sendsPerAccountDay organizePerAccountDay rawGiBPerAccount meanRawKiB imapMetadataBytesPerRow refreshEveryMinutes retryMultiplier',
  capacity: 'projectionOverheadFraction hostedCopies backupCopies deviceReplicas headroom quotaBudgetFraction targetCpuUtilization baseVcpu baseMemoryGiB workerMemoryMiB accountMemoryMiB gmailCycleCpuMs graphFolderCycleCpuMs graphDiscoveryCycleCpuMs imapRowCpuMs projectMessageCpuMs actionCpuMs',
  gmail: 'projectUnitsPerMinute userUnitsPerMinute dailyBillingThresholdUnits historyUnits labelsUnits rawUnits metadataUnits listUnits listPageSize sendUnits modifyUnits',
  rates: 'vcpuHour memoryGiBHour storageGiBMonth egressGiB operationsHour operationsHoursMonth fixedMonth',
};
function exactKeys(value, keys) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Expected input object');
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'Unknown or missing capacity input');
}
function finite(value, min = 0, max = Number.MAX_SAFE_INTEGER) { assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, 'Capacity input outside range'); }
export function validateCapacityInputs(input) {
  exactKeys(input, ['version', 'currency', 'scenarioUsers', 'daysPerMonth', 'accountsPerUser', 'providerMix', ...Object.keys(numericGroups)]);
  assert.equal(input.version, 1); assert.equal(input.currency, 'EUR');
  assert.ok(Array.isArray(input.scenarioUsers) && input.scenarioUsers.length > 0 && input.scenarioUsers.length <= 20);
  for (const count of input.scenarioUsers) { finite(count, 1, 1000000); assert.ok(Number.isInteger(count)); }
  finite(input.daysPerMonth, 1, 366); finite(input.accountsPerUser, 1, 100); assert.ok(Number.isInteger(input.accountsPerUser));
  exactKeys(input.providerMix, providers);
  for (const provider of providers) finite(input.providerMix[provider], 0, 1);
  assert.ok(Math.abs(providers.reduce((sum, provider) => sum + input.providerMix[provider], 0) - 1) < 1e-9, 'Provider mix must total one');
  for (const [group, fields] of Object.entries(numericGroups)) {
    exactKeys(input[group], fields.split(' '));
    for (const value of Object.values(input[group])) finite(value);
  }
  for (const key of ['pollSeconds', 'meanRawKiB', 'refreshEveryMinutes', 'retryMultiplier']) finite(input.workload[key], key === 'retryMultiplier' ? 1 : Number.EPSILON);
  for (const key of ['graphFolders', 'graphHierarchyListCalls', 'graphAttachmentGetsPerMessage']) assert.ok(Number.isInteger(input.workload[key]));
  finite(input.workload.graphFolders, 1); finite(input.workload.graphHierarchyListCalls, 1);
  for (const key of ['quotaBudgetFraction', 'targetCpuUtilization']) finite(input.capacity[key], Number.EPSILON, 1);
  finite(input.capacity.headroom, 1);
  for (const key of ['hostedCopies', 'backupCopies', 'deviceReplicas']) assert.ok(Number.isInteger(input.capacity[key]));
  finite(input.capacity.hostedCopies, 1);
  for (const value of Object.values(input.gmail)) { finite(value, Number.EPSILON); assert.ok(Number.isInteger(value)); }
  return input;
}
function accountMix(accounts, mix) {
  const result = Object.fromEntries(providers.map(provider => [provider, Math.floor(accounts * mix[provider])]));
  const order = [...providers].sort((a, b) => accounts * mix[b] - result[b] - (accounts * mix[a] - result[a]));
  const remaining = accounts - Object.values(result).reduce((a, b) => a + b, 0);
  for (const provider of order.slice(0, remaining)) result[provider]++;
  return result;
}
export function estimateHostedCapacity(supplied, users) {
  const input = validateCapacityInputs(supplied); finite(users, 1, 1000000); assert.ok(Number.isInteger(users));
  const { workload: w, capacity: c, gmail: q, rates: r } = input;
  const accounts = users * input.accountsPerUser, mix = accountMix(accounts, input.providerMix), cyclesDay = 86400 / w.pollSeconds;
  const messagesPerAccount = Math.ceil(w.rawGiBPerAccount * GiB / (w.meanRawKiB * 1024));
  assert.ok(Number.isSafeInteger(messagesPerAccount), 'Mailbox size exceeds model precision');
  // Graph currently rechecks each folder's metadata and each delta stream every round.
  const graphCycleCalls = w.graphHierarchyListCalls + 1 + 2 * w.graphFolders;
  // Raw GET: metadata + MIME + metadata; body job: metadata + attachments list + final metadata.
  const graphMessageCalls = 6 + w.graphAttachmentGetsPerMessage;
  const graphDownloadedDay = mix.graph * (w.newMessagesPerAccountDay + w.metadataChangesPerAccountDay);
  const oauthRefreshesDay = (mix.gmail + mix.graph) * dayMinutes / w.refreshEveryMinutes;
  const actionsPerAccount = w.sendsPerAccountDay + w.organizePerAccountDay;
  const gmailCallsDay = mix.gmail * (cyclesDay * 2 + w.newMessagesPerAccountDay + w.metadataChangesPerAccountDay + actionsPerAccount * 2);
  const graphCallsDay = mix.graph * (cyclesDay * graphCycleCalls + actionsPerAccount * 2) + graphDownloadedDay * graphMessageCalls;
  // Include one metadata-sized read allowance per action and one identity read per refresh.
  const gmailSteadyUnitsDay = mix.gmail * (cyclesDay * (q.labelsUnits + q.historyUnits) + w.newMessagesPerAccountDay * q.rawUnits + w.metadataChangesPerAccountDay * q.metadataUnits + w.sendsPerAccountDay * (q.sendUnits + q.metadataUnits) + w.organizePerAccountDay * (q.modifyUnits + q.metadataUnits) + dayMinutes / w.refreshEveryMinutes) * w.retryMultiplier;
  const perGmailBackfillUnits = messagesPerAccount * q.rawUnits + Math.ceil(messagesPerAccount / q.listPageSize) * q.listUnits;
  const gmailInitialUnits = mix.gmail * perGmailBackfillUnits * w.retryMultiplier;
  const perAccountReadUnitsMinute = q.userUnitsPerMinute * c.quotaBudgetFraction;
  const projectReadBudgetMinute = Math.max(0, q.projectUnitsPerMinute * c.quotaBudgetFraction - gmailSteadyUnitsDay / dayMinutes);
  const gmailConcurrentBackfills = Math.min(mix.gmail, Math.max(0, Math.floor(projectReadBudgetMinute / perAccountReadUnitsMinute)));
  const gmailHardRateDays = mix.gmail === 0 ? 0 : projectReadBudgetMinute <= 0 ? null : Math.max(perGmailBackfillUnits * w.retryMultiplier / perAccountReadUnitsMinute / dayMinutes, gmailInitialUnits / projectReadBudgetMinute / dayMinutes);
  const dailyRoom = q.dailyBillingThresholdUnits * c.quotaBudgetFraction - gmailSteadyUnitsDay;
  const gmailDaysBelowDailyThreshold = mix.gmail === 0 ? 0 : dailyRoom <= 0 || gmailHardRateDays === null ? null : Math.max(gmailHardRateDays, gmailInitialUnits / dailyRoom);
  // Current IMAP cycles enumerate UID/internal-date rows even with CONDSTORE.
  const imapRowsDay = mix.imap * messagesPerAccount * cyclesDay;
  const imapMetadataGiBDay = imapRowsDay * w.imapMetadataBytesPerRow * w.retryMultiplier / GiB;
  const projectedMessagesDay = (mix.gmail + mix.imap) * w.newMessagesPerAccountDay + graphDownloadedDay;
  const cpuMsDay = mix.gmail * cyclesDay * c.gmailCycleCpuMs + mix.graph * cyclesDay * (c.graphDiscoveryCycleCpuMs + w.graphFolders * c.graphFolderCycleCpuMs) + imapRowsDay * c.imapRowCpuMs + projectedMessagesDay * c.projectMessageCpuMs + accounts * actionsPerAccount * c.actionCpuMs;
  const vcpu = (c.baseVcpu + cpuMsDay * w.retryMultiplier / 86400000) / c.targetCpuUtilization;
  const memoryGiB = (c.baseMemoryGiB + (users * c.workerMemoryMiB + accounts * c.accountMemoryMiB) / 1024) * c.headroom;
  const primaryGiB = accounts * w.rawGiBPerAccount * (1 + c.projectionOverheadFraction);
  const hostedStorageGiB = primaryGiB * (c.hostedCopies + c.backupCopies) * c.headroom;
  const newRawGiBMonth = accounts * w.newMessagesPerAccountDay * w.meanRawKiB * 1024 * input.daysPerMonth / GiB;
  const steadyDeviceEgressGiBMonth = newRawGiBMonth * (1 + c.projectionOverheadFraction) * c.deviceReplicas * w.retryMultiplier;
  const initialDeviceEgressGiB = primaryGiB * c.deviceReplicas * w.retryMultiplier;
  const hoursMonth = input.daysPerMonth * 24;
  const costs = { compute: vcpu * hoursMonth * r.vcpuHour, memory: memoryGiB * hoursMonth * r.memoryGiBHour, storage: hostedStorageGiB * r.storageGiBMonth, deviceEgress: steadyDeviceEgressGiBMonth * r.egressGiB, operations: r.operationsHoursMonth * r.operationsHour, fixed: r.fixedMonth };
  const totalMonth = Object.values(costs).reduce((a, b) => a + b, 0);
  const result = { users, accounts, mix, messagesPerAccount, gmail: { steadyUnitsDay: gmailSteadyUnitsDay, initialUnits: gmailInitialUnits, rawReadIntervalMs: 60000 * q.rawUnits / perAccountReadUnitsMinute, concurrentBackfills: gmailConcurrentBackfills, minimumBackfillDaysAtMinuteBudgets: gmailHardRateDays, backfillDaysBelowDailyThreshold: gmailDaysBelowDailyThreshold },
    traffic: { httpRequestsMonth: ((gmailCallsDay + graphCallsDay) * w.retryMultiplier + 2 * oauthRefreshesDay) * input.daysPerMonth, oauthRefreshesMonth: oauthRefreshesDay * input.daysPerMonth, graphCallsPerQuietCycle: graphCycleCalls, imapRowsDay, imapMetadataGiBDay },
    capacity: { vcpu, memoryGiB, primaryGiB, hostedStorageGiB, steadyDeviceEgressGiBMonth, initialDeviceEgressGiB }, costs: { currency: input.currency, ...costs, totalMonth, perUserMonth: totalMonth / users, initialDeviceEgress: initialDeviceEgressGiB * r.egressGiB } };
  const check = value => { if (typeof value === 'number') finite(value); else if (value !== null && typeof value === 'object') for (const child of Object.values(value)) check(child); };
  check(result); return result;
}
export function capacityTable(input) {
  const n = value => value === null ? 'No remaining budget' : value.toFixed(2);
  const rows = input.scenarioUsers.map(users => {
    const e = estimateHostedCapacity(input, users);
    return `| ${e.users} | ${Object.values(e.mix).join('/')} | ${n(e.traffic.httpRequestsMonth / 1000000)} M | ${n(e.traffic.imapMetadataGiBDay)} | ${n(e.capacity.vcpu)} | ${n(e.capacity.memoryGiB)} | ${n(e.capacity.hostedStorageGiB / 1024)} | ${n(e.gmail.backfillDaysBelowDailyThreshold)} | ${n(e.costs.totalMonth)} |`;
  });
  return ['| Users | Gmail/Graph/IMAP | HTTP calls/month | IMAP metadata GiB/day | vCPU | RAM GiB | Hosted TiB | Gmail initial days at daily budget | EUR/month |', '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |', ...rows].join('\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = validateCapacityInputs(JSON.parse(await readFile(new URL('../../docs/mail-hosted-capacity-inputs.json', import.meta.url), 'utf8')));
  const flag = process.argv[2]; assert.ok(process.argv.length <= 3 && (flag === undefined || flag === '--table' || flag === '--check'), 'Use hosted-capacity.mjs [--table|--check]');
  if (flag === '--check') {
    const doc = await readFile(new URL('../../docs/mail-multi-device-scope.md', import.meta.url), 'utf8');
    const section = doc.split('<!-- mail-hosted-capacity:start -->\n')[1]?.split('\n<!-- mail-hosted-capacity:end -->')[0];
    assert.equal(section, capacityTable(input), 'Hosted capacity table needs regeneration'); console.log('Hosted mail capacity table verified.');
  } else console.log(flag === '--table' ? capacityTable(input) : JSON.stringify(input.scenarioUsers.map(users => estimateHostedCapacity(input, users)), null, 2));
}
