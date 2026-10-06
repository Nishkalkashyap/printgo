import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { PrintGoError, messageOf } from './errors.js';
import { privateDirectory, readJson, writeJson } from './storage.js';
import { assetUrlSchema, downloadAsset, type AssetDownloader } from './assets.js';
import { preparePrintDocument, MAX_PRINT_PDF_BYTES } from './documents.js';
import { renderMarkup, prepareMarkupRuntime, MAX_MARKUP_BYTES, MAX_INLINE_MARKUP_BYTES } from './markup.js';
import type { PrintJob, PrinterAdapter, PrintRequest, MarkupPrintRequest, PrintSettings } from './types.js';

export const MAX_REQUEST_BYTES = 64 * 1024;
export const printerIdSchema = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value));
// Zod preserves schema field order, keeping job fingerprints stable.
export const settingsSchema = z.object({
  copies: z.number().int().min(1).max(100).optional(),
  pageRanges: z.string().max(500).regex(/^[1-9]\d*(?:-[1-9]\d*)?(?:,[1-9]\d*(?:-[1-9]\d*)?)*$/)
    .refine(value => value.split(',').every(range => {
      const [first, last] = range.split('-').map(Number);
      return Number.isSafeInteger(first) && (last === undefined || (Number.isSafeInteger(last) && last >= first!));
    })).optional(),
  paperSize: z.string().max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/).optional(),
  orientation: z.enum(['portrait', 'landscape']).optional(),
  sides: z.enum(['one-sided', 'two-sided-long-edge', 'two-sided-short-edge']).optional(),
  colorMode: z.enum(['color', 'monochrome']).optional(),
  fitToPage: z.boolean().optional(),
}).strict();

export const markupPrintRequestSchema = z.object({
  printerId: printerIdSchema,
  format: z.enum(['markdown', 'html']),
  content: z.string().min(1).max(MAX_INLINE_MARKUP_BYTES).refine(value => Buffer.byteLength(value, 'utf8') <= MAX_INLINE_MARKUP_BYTES,
    'Inline markup exceeds 32 KiB; use assetUrl for larger documents.').describe('Inline Markdown or HTML source, up to 32 KiB. Provide content or assetUrl, never both.').optional(),
  assetUrl: assetUrlSchema.describe('Direct public or signed HTTPS URL containing UTF-8 Markdown or HTML. Provide assetUrl or content, never both.').optional(),
  settings: settingsSchema.optional(),
  idempotencyKey: z.string().min(1).max(128),
}).strict().refine(value => (value.content !== undefined) !== (value.assetUrl !== undefined),
  'Provide exactly one of content or assetUrl.');

export const printRequestSchema = z.object({
  printerId: printerIdSchema,
  assetUrl: assetUrlSchema.describe('Direct public or signed HTTPS file URL; supports PDF, PNG, JPEG and UTF-8 text, up to 10 MiB.'),
  assetType: z.enum(['auto', 'pdf', 'png', 'jpeg', 'text']).describe('Defaults to auto. Use text for extensionless plain-text URLs.').optional(),
  settings: settingsSchema.optional(),
  idempotencyKey: z.string().min(1).max(128),
}).strict();

interface StoredJob extends PrintJob { idempotencyKey: string; fingerprint: string }

function publicJob(job: StoredJob): PrintJob {
  const { idempotencyKey: _key, fingerprint: _fingerprint, ...result } = job;
  return result;
}

export class PrinterService {
  private queue: Promise<unknown> = Promise.resolve();
  private markupWorkerPath?: string;
  constructor(readonly adapter: PrinterAdapter, private readonly directory: string, private readonly download: AssetDownloader = downloadAsset,
    private readonly rendering: { browserExecutablePath?: string } = {}) {}

  async prepareRuntime(): Promise<void> {
    this.markupWorkerPath ??= await prepareMarkupRuntime(this.directory);
  }

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async loadJobs(): Promise<StoredJob[]> {
    return (await readJson<StoredJob[]>(join(this.directory, 'jobs.json'))) ?? [];
  }

  async requirePrinter(printerId: string): Promise<void> {
    if (!(await this.adapter.listPrinters()).some(printer => printer.id === printerId)) {
      throw new PrintGoError('PRINTER_NOT_FOUND', 'Choose a printer ID returned by listPrinters.');
    }
  }

  async sendPrintCommand(input: PrintRequest): Promise<PrintJob> {
    const request = printRequestSchema.parse(input);
    const settings = request.settings ?? {};
    const fingerprint = createHash('sha256').update(JSON.stringify({ assetUrl: new URL(request.assetUrl).href, printerId: request.printerId, settings,
      ...(request.assetType && request.assetType !== 'auto' ? { assetType: request.assetType } : {}),
    })).digest('hex');
    return this.submit(request.printerId, settings, request.idempotencyKey, fingerprint,
      async () => preparePrintDocument(await this.download(request.assetUrl), request.assetUrl, settings, request.assetType));
  }

  async printMarkup(input: MarkupPrintRequest): Promise<PrintJob> {
    const request = markupPrintRequestSchema.parse(input);
    const settings = request.settings ?? {};
    const fingerprint = createHash('sha256').update(JSON.stringify({ kind: 'markup', printerId: request.printerId, settings,
      format: request.format, ...(request.content !== undefined ? { content: request.content } : { assetUrl: new URL(request.assetUrl!).href }),
    })).digest('hex');
    return this.submit(request.printerId, settings, request.idempotencyKey, fingerprint, async () => {
      let content = request.content;
      let baseUrl = request.assetUrl;
      if (content === undefined) {
        const asset = await this.download(request.assetUrl!, { maxBytes: MAX_MARKUP_BYTES });
        const bytes = Buffer.isBuffer(asset) ? asset : asset.bytes;
        if (!Buffer.isBuffer(asset)) baseUrl = asset.finalUrl ?? baseUrl;
        if (bytes.length > MAX_MARKUP_BYTES) throw new PrintGoError('MARKUP_TOO_LARGE', 'Markup downloads may contain at most 1 MiB of source.');
        try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { throw new PrintGoError('INVALID_DOCUMENT', 'Markup URLs must return valid UTF-8 source.'); }
      }
      await this.prepareRuntime();
      return renderMarkup(content, request.format, settings, { workerPath: this.markupWorkerPath!, stateDir: this.directory,
        browserExecutablePath: this.rendering.browserExecutablePath, baseUrl, download: this.download });
    });
  }

  private submit(printerId: string, settings: PrintSettings, idempotencyKey: string, fingerprint: string, prepare: () => Promise<Buffer>): Promise<PrintJob> {
    return this.serialized(async () => {
      await privateDirectory(this.directory);
      const jobs = await this.loadJobs();
      const previous = jobs.find(job => job.idempotencyKey === idempotencyKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new PrintGoError('IDEMPOTENCY_CONFLICT', 'This idempotency key was already used with different print arguments.');
        return publicJob(previous);
      }
      await this.requirePrinter(printerId);
      // Check retries before downloading: signed URLs may have expired.
      const pdf = await prepare();
      if (pdf.length > MAX_PRINT_PDF_BYTES || pdf.subarray(0, 5).toString() !== '%PDF-') {
        throw new PrintGoError('INVALID_DOCUMENT', 'The prepared document must be a PDF of at most 10 MiB.');
      }
      const job: StoredJob = {
        jobId: randomUUID(), printerId, status: 'submitting', createdAt: new Date().toISOString(),
        idempotencyKey, fingerprint,
      };
      jobs.push(job);
      // Persist before spooling so a crash cannot cause a duplicate print.
      await writeJson(join(this.directory, 'jobs.json'), jobs);
      const temporaryDirectory = join(this.directory, 'documents');
      await privateDirectory(temporaryDirectory);
      const file = join(temporaryDirectory, `${job.jobId}.pdf`);
      try {
        await writeFile(file, pdf, { mode: 0o600, flag: 'wx' });
        job.nativeJobId = await this.adapter.submit(file, printerId, settings, `printgo-${job.jobId}`);
        job.status = 'submitted';
      } catch (error) {
        // Command timeouts/nonzero exits can occur after a spooler accepts the job.
        job.status = 'unknown';
        job.details = `${messageOf(error)} Submission may have occurred; do not retry with a new idempotency key.`;
      } finally { await rm(file, { force: true }); }
      await writeJson(join(this.directory, 'jobs.json'), jobs);
      return publicJob(job);
    });
  }

  async getPrintJobStatus(jobId: string): Promise<PrintJob> {
    return this.serialized(async () => {
      const job = (await this.loadJobs()).find(job => job.jobId === jobId);
      if (!job) throw new PrintGoError('JOB_NOT_FOUND', 'Unknown printgo job ID.');
      if (job.status === 'submitting') return { ...publicJob(job), status: 'unknown', details: 'Submission was interrupted. Reusing its idempotency key will not resubmit.' };
      if (job.status === 'cancelled' || job.status === 'failed' || !job.nativeJobId) return publicJob(job);
      return this.adapter.getJobStatus(publicJob(job));
    });
  }

  async cancelPrintJob(jobId: string): Promise<PrintJob> {
    return this.serialized(async () => {
      const jobs = await this.loadJobs();
      const job = jobs.find(job => job.jobId === jobId);
      if (!job) throw new PrintGoError('JOB_NOT_FOUND', 'Unknown printgo job ID.');
      if (job.status !== 'cancelled') {
        await this.adapter.cancelJob(publicJob(job));
        job.status = 'cancelled';
        await writeJson(join(this.directory, 'jobs.json'), jobs);
      }
      return publicJob(job);
    });
  }
}
