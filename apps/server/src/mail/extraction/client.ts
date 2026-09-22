import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { workerEnvironment, type WorkerExecutable } from '../runtime/executable.js';
import { EXTRACTION_LIMITS as LIMIT, ExtractionError, extractedSchema, extractionErrorSchema, type ExtractedText } from './contract.js';
const response = z.discriminatedUnion('ok', [z.object({ ok: z.literal(true), result: extractedSchema }).strict(), z.object({ ok: z.literal(false), error: extractionErrorSchema }).strict()]);
/** One caller-owned physical process, always killed/reaped before settlement on cancellation/deadline. */
export function extractInProcess(input: {
    bytes: Uint8Array;
    filename: string;
    contentType: string;
    signal: AbortSignal;
}, executable: WorkerExecutable = { kind: process.versions.electron ? 'electron' : 'node', path: process.execPath }, budgetMs = LIMIT.wallMs + 1000): Promise<ExtractedText> {
    if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > LIMIT.wallMs + 1000)
        return Promise.reject(new ExtractionError('limit'));
    if (input.bytes.length > LIMIT.inputBytes)
        return Promise.reject(new ExtractionError('limit'));
    if (input.signal.aborted)
        return Promise.reject(new ExtractionError('cancelled'));
    return new Promise((resolve, reject) => {
        const child = spawn(executable.path, [fileURLToPath(new URL('./process.js', import.meta.url))], { env: workerEnvironment(executable), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const chunks: Buffer[] = [];
        let outputBytes = 0;
        let failure: ExtractionError | undefined, finished = false;
        const started = performance.now();
        const stop = (code: 'cancelled' | 'timeout' | 'limit') => { failure ??= new ExtractionError(code); child.kill('SIGKILL'); };
        const abort = () => stop('cancelled');
        input.signal.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => stop('timeout'), budgetMs);
        child.stdin.on('error', () => { });
        child.stdout.on('data', chunk => { outputBytes += chunk.length; if (outputBytes > LIMIT.outputBytes + 1024) {
            stop('limit');
            return;
        } chunks.push(Buffer.from(chunk)); });
        let stderrBytes = 0;
        child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 4096)
            stop('limit'); });
        const end = (code: number | null) => {
            if (finished)
                return;
            finished = true;
            clearTimeout(timer);
            input.signal.removeEventListener('abort', abort);
            if (input.signal.aborted)
                failure ??= new ExtractionError('cancelled');
            if (performance.now() - started > budgetMs)
                failure ??= new ExtractionError('timeout');
            if (failure) {
                reject(failure);
                return;
            }
            try {
                if (code !== 0)
                    throw new ExtractionError('runtime_failed');
                const parsed = response.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
                if (!parsed.ok)
                    throw new ExtractionError(parsed.error);
                resolve(parsed.result);
            }
            catch (error) {
                reject(error instanceof ExtractionError ? error : new ExtractionError('runtime_failed'));
            }
        };
        child.once('error', () => { failure = new ExtractionError('runtime_failed'); });
        child.once('close', end);
        child.stdin.end(JSON.stringify({ filename: input.filename, contentType: input.contentType, data: Buffer.from(input.bytes).toString('base64') }));
    });
}
