import assert from 'node:assert/strict';
import { fork, execFile } from 'node:child_process';
import { resolve, relative, isAbsolute, sep, dirname, basename, join } from 'node:path';
import { realpath } from 'node:fs/promises';

async function canonicalOutput(path) {
  try { return await realpath(path); }
  catch (error) {
    if (error.code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(await canonicalOutput(dirname(path)), basename(path));
  }
}

export async function assertBenchmarkOutputOutside(source, destination) {
  const path = relative(await realpath(resolve(source)), await canonicalOutput(resolve(destination)));
  assert(path !== '' && (isAbsolute(path) || path === '..' || path.startsWith('..' + sep)), 'Benchmark output must be outside the source profile');
}

export function benchmarkRetention(environment) {
  const budget = environment.LEGALWORK_MAIL_BENCH_BUDGET_MS, destination = environment.LEGALWORK_MAIL_BENCH_CHECKPOINT_DIR;
  if (budget === undefined && destination === undefined) return null;
  assert(typeof budget === 'string' && /^[0-9]+$/.test(budget) && typeof destination === 'string' && destination.length > 0,
    'Benchmark retention requires a budget and checkpoint directory');
  const budgetMs = Number(budget);
  assert(Number.isSafeInteger(budgetMs) && budgetMs >= 1 && budgetMs <= 86400000, 'Invalid benchmark budget');
  return { budgetMs, destination };
}

function stopFamily(child) {
  if (!child.pid) return Promise.resolve();
  if (process.platform === 'win32') return new Promise(done => {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => {
      if (error) child.kill('SIGKILL');
      done();
    });
  });
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch { child.kill('SIGKILL'); }
  return Promise.resolve();
}

/** Settle only after the actual worker exits, so a failed run can be frozen safely. */
export function runBenchmarkProcess({ file, config, budgetMs, onStart = () => {}, onProgress = () => {}, onForeground = () => {} }) {
  return new Promise((resolve, reject) => {
    const child = fork(file, [], { detached: process.platform !== 'win32', windowsHide: true,
      env: { ...process.env, LEGALWORK_MAIL_BENCH_CHILD: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    let result, failure, ready = false, pending = null, id = 0, stopping = Promise.resolve();
    onStart(child.pid);
    const ping = setInterval(() => {
      if (!ready || pending !== null || !child.connected || failure || result !== undefined) return;
      pending = { id: ++id, start: performance.now() };
      try { child.send({ kind: 'ping', id }, () => {}); } catch { pending = null; }
    }, 500);
    const deadline = budgetMs === undefined ? undefined : setTimeout(() => {
      failure ??= Error('Synthetic benchmark deadline exceeded');
      stopping = stopFamily(child);
    }, budgetMs);
    child.on('message', message => {
      if (message.kind === 'ready') ready = true;
      if (message.kind === 'progress') onProgress(message);
      if (message.kind === 'pong' && pending?.id === message.id) {
        if (!message.skipped) onForeground({ phase: message.phase, ms: performance.now() - pending.start, queryMs: message.queryMs, error: message.error });
        pending = null;
      }
      if (message.kind === 'failure') failure ??= Error(message.error);
      if (message.kind === 'result') result = message.result;
    });
    child.once('error', error => { failure ??= error; });
    child.once('close', async code => {
      clearInterval(ping); clearTimeout(deadline);
      await stopping;
      if (failure) reject(failure);
      else if (code === 0 && result !== undefined) resolve(result);
      else reject(Error('Benchmark worker exited without a result: ' + code));
    });
    child.send(config, () => {});
  });
}
