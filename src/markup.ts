import { fork, execFile, type ChildProcess } from 'node:child_process';
import { copyFile, chmod, rename, rm, mkdtemp } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { findBrowser, type BrowserOptions } from './browser.js';
import { downloadAsset, MAX_ASSET_BYTES, type AssetDownloader, type DownloadedAsset } from './assets.js';
import { PrintGoError } from './errors.js';
import { MAX_PRINT_PDF_BYTES, pageSize } from './documents.js';
import { privateDirectory } from './storage.js';
import { packagedMarkupWorker } from './markup-worker-location.js';
import type { PrintSettings } from './types.js';
import { imageSize } from 'image-size';

export const MAX_INLINE_MARKUP_BYTES = 32 * 1024;
export const MAX_MARKUP_BYTES = 1024 * 1024;
export const MARKUP_TIMEOUT_MS = 30_000;
export const MAX_MARKUP_RESOURCES = 100;
export const MAX_MARKUP_RESOURCE_BYTES = 20 * 1024 * 1024;
export interface MarkupRenderOptions extends BrowserOptions {
  workerPath: string;
  baseUrl?: string;
  download?: AssetDownloader;
  /** Trusted test/embedding option, never exposed in MCP arguments. */
  timeoutMs?: number;
}

/** Persist the helper before the server listens, so npx cache cleanup is harmless. */
export async function prepareMarkupRuntime(directory: string): Promise<string> {
  const runtime = join(directory, 'runtime');
  await privateDirectory(runtime);
  const path = join(runtime, 'markup-worker.cjs'), temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await copyFile(packagedMarkupWorker, temporary);
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
  return path;
}

export async function renderMarkup(content: string, format: 'markdown' | 'html', settings: PrintSettings, options: MarkupRenderOptions): Promise<Buffer> {
  if (!content.trim() || Buffer.byteLength(content, 'utf8') > MAX_MARKUP_BYTES || /[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/.test(content)) {
    throw new PrintGoError('INVALID_DOCUMENT', 'Provide nonempty UTF-8 Markdown/HTML source of at most 1 MiB, without binary/control characters.');
  }
  const dimensions = pageSize(settings);
  const executablePath = await findBrowser(options);
  const download = options.download ?? downloadAsset;
  const controller = new AbortController();
  const profileDirectory = await mkdtemp(join(dirname(options.workerPath), 'render-profile-'));
  let worker: ChildProcess;
  try {
    worker = fork(options.workerPath, [], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], serialization: 'advanced',
      execArgv: ['--max-old-space-size=128'], windowsHide: true });
  } catch {
    await rm(profileDirectory, { recursive: true, force: true });
    throw new PrintGoError('MARKUP_RENDER_FAILED', 'The rendering helper could not start.');
  }
  const closed = new Promise<void>(resolve => worker.once('close', () => resolve()));
  let browserPid: number | undefined;
  let finished = false;
  let requests = 0, resourceBytes = 0, outputBytes = 0;
  const output: Buffer[] = [];
  const cache = new Map<string, Promise<DownloadedAsset>>();
  // All subresources are fetched here; Chromium never opens their network sockets.
  let resourceQueue = Promise.resolve();
  const fetchResource = (url: string): Promise<DownloadedAsset> => {
    const cached = cache.get(url);
    if (cached) return cached;
    const task = resourceQueue.then(async () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      const input = await download(url, { signal: controller.signal, maxBytes: Math.min(MAX_ASSET_BYTES, MAX_MARKUP_RESOURCE_BYTES - resourceBytes) });
      const asset = Buffer.isBuffer(input) ? { bytes: input } : input;
      resourceBytes += asset.bytes.length;
      if (resourceBytes > MAX_MARKUP_RESOURCE_BYTES) throw new PrintGoError('MARKUP_TOO_LARGE', 'Linked rendering assets exceed the 20 MiB total limit.');
      if (asset.finalUrl && asset.finalUrl !== url) cache.set(asset.finalUrl, Promise.resolve(asset));
      return asset;
    });
    resourceQueue = task.then(() => undefined, () => undefined);
    cache.set(url, task);
    return task;
  };
  const send = (message: object) => {
    if (worker.connected && !finished) worker.send(message, error => { if (error && !finished) fail(new PrintGoError('MARKUP_RENDER_FAILED', 'The rendering helper disconnected.')); });
  };
  let rejectResult: (error: Error) => void = () => {};
  let forcedKill: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    if (browserPid) {
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(browserPid), '/T', '/F'], () => {});
      else { try { process.kill(-browserPid, 'SIGKILL'); } catch { /* The owned browser may have already exited. */ } }
    }
    if (worker.exitCode === null && worker.signalCode === null) {
      if (process.platform === 'win32' && worker.pid) execFile('taskkill', ['/PID', String(worker.pid), '/T', '/F'], error => { if (error) worker.kill('SIGKILL'); });
      else if (browserPid) worker.kill('SIGKILL');
      else {
        // Before we know the browser PID, let Puppeteer terminate it via SIGINT.
        worker.kill('SIGINT');
        forcedKill = setTimeout(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); }, 2000);
      }
    }
  };
  const fail = (error: PrintGoError) => {
    if (finished) return;
    finished = true;
    controller.abort(error);
    kill();
    rejectResult(error);
  };
  const timer = setTimeout(() => fail(new PrintGoError('MARKUP_RENDER_TIMEOUT', 'Markdown/HTML rendering exceeded its time limit.')), options.timeoutMs ?? MARKUP_TIMEOUT_MS);
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      rejectResult = reject;
      worker.on('error', () => fail(new PrintGoError('MARKUP_RENDER_FAILED', 'The rendering helper could not start.')));
      worker.stdout!.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_PRINT_PDF_BYTES) { fail(new PrintGoError('CONVERTED_DOCUMENT_TOO_LARGE', 'Rendered PDFs may contain at most 10 MiB.')); return; }
        output.push(chunk);
      });
      worker.stderr!.resume(); // Never echo browser diagnostics containing document URLs/content.
      worker.on('message', async (message: any) => {
        if (message.kind === 'browser' && Number.isSafeInteger(message.pid) && message.pid > 0) { browserPid = message.pid; if (finished) kill(); return; }
        if (message.kind === 'browser-closed') { browserPid = undefined; return; }
        if (finished) return;
        if (message.kind === 'error') { fail(new PrintGoError(message.code, message.message)); return; }
        if (message.kind !== 'resource') return;
        if (++requests > MAX_MARKUP_RESOURCES) { fail(new PrintGoError('MARKUP_TOO_LARGE', 'A rendered document may request at most 100 linked assets.')); return; }
        try {
          const asset = await fetchResource(message.url);
          if (message.resourceType === 'image') {
            let dimensions: ReturnType<typeof imageSize>;
            try { dimensions = imageSize(asset.bytes); }
            catch { throw new PrintGoError('INVALID_DOCUMENT', 'A linked image has an unsupported or invalid image header.'); }
            if (!Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height) || dimensions.width <= 0 || dimensions.height <= 0 ||
                dimensions.width * dimensions.height > 16_000_000 || dimensions.width > 16384 || dimensions.height > 16384) {
              throw new PrintGoError('IMAGE_TOO_LARGE', 'Linked images may contain at most 16 megapixels and 16,384 pixels per dimension.');
            }
          }
          send({ kind: 'resource-result', id: message.id, ...asset });
        } catch (error) {
          fail(error instanceof PrintGoError ? error : new PrintGoError('MARKUP_RESOURCE_FAILED', 'A linked rendering asset could not be downloaded.'));
        }
      });
      worker.on('close', code => {
        if (forcedKill) clearTimeout(forcedKill);
        if (finished) return;
        finished = true;
        controller.abort(new PrintGoError('MARKUP_RENDER_FAILED', 'Rendering finished.'));
        if (code !== 0) { kill(); reject(new PrintGoError('MARKUP_RENDER_FAILED', 'Chromium rendering failed. Check the browser installation and system dependencies.')); return; }
        const pdf = Buffer.concat(output, outputBytes);
        if (pdf.subarray(0, 5).toString() !== '%PDF-') reject(new PrintGoError('MARKUP_RENDER_FAILED', 'The renderer returned no printable PDF.'));
        else resolve(pdf);
      });
      worker.stdin!.on('error', () => fail(new PrintGoError('MARKUP_RENDER_FAILED', 'The rendering helper could not receive the document.')));
      worker.stdin!.end(JSON.stringify({ content, format, dimensions, executablePath, baseUrl: options.baseUrl, profileDirectory }));
    });
  } finally { clearTimeout(timer); await closed; await rm(profileDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
