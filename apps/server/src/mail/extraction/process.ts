/** Private parser process: no SQL, credential keys, filesystem input paths, or provider transport. */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { EXTRACTION_LIMITS as LIMIT, ExtractionError, extractionInputSchema } from './contract.js';
if (!isMainThread) {
    // Dependency diagnostics must never serialize attachment contents or parser exceptions.
    console.log = console.warn = console.error = () => { };
    const input = extractionInputSchema.safeParse(workerData);
    if (!input.success)
        parentPort?.postMessage({ ok: false, error: 'malformed' });
    else {
        try {
            const { extractAttachment } = await import('./extract.js');
            const result = await extractAttachment(Buffer.from(input.data.data, 'base64'), input.data.filename, input.data.contentType);
            parentPort?.postMessage({ ok: true, result });
        }
        catch (error) {
            parentPort?.postMessage({ ok: false, error: error instanceof ExtractionError ? error.code : 'runtime_failed' });
        }
    }
}
else {
    let input = '', worker: Worker | undefined, settled = false;
    const finish = (value: unknown) => { if (settled)
        return; settled = true; clearInterval(memory); clearTimeout(deadline); process.stdout.write(JSON.stringify(value) + '\n', () => { void worker?.terminate(); process.exit(0); }); };
    const memory = setInterval(() => { if (process.memoryUsage.rss() > LIMIT.rssBytes)
        finish({ ok: false, error: 'memory' }); }, 50);
    const deadline = setTimeout(() => finish({ ok: false, error: 'timeout' }), LIMIT.wallMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; if (input.length > Math.ceil(LIMIT.inputBytes / 3) * 4 + 32768)
        finish({ ok: false, error: 'limit' }); });
    process.stdin.on('end', () => {
        if (settled)
            return;
        let supplied: unknown;
        try {
            supplied = JSON.parse(input);
        }
        catch {
            finish({ ok: false, error: 'malformed' });
            return;
        }
        const parsed = extractionInputSchema.safeParse(supplied);
        input = '';
        if (!parsed.success) {
            finish({ ok: false, error: 'malformed' });
            return;
        }
        worker = new Worker(new URL(import.meta.url), { workerData: parsed.data, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 } });
        worker.once('message', finish);
        worker.once('error', () => finish({ ok: false, error: 'runtime_failed' }));
        worker.once('exit', () => { if (!settled)
            finish({ ok: false, error: 'runtime_failed' }); });
    });
}
