import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PrinterAdapter, PrintJob } from '../src/types.js';

export async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'printgo-test-'));
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

export class FakePrinter implements PrinterAdapter {
  submissions = 0;
  cancellations = 0;
  async listPrinters() { return [{ id: 'test-printer', name: 'Test printer', isDefault: true, state: 'idle' }]; }
  async getPrinterCapabilities(printerId: string) { return { printerId, options: { PageSize: ['A4', 'Letter'] } }; }
  async checkPrinterStatus(printerId: string) { return { printerId, state: 'idle', acceptingJobs: true, details: 'Ready' }; }
  async submit() { this.submissions++; return 'test-printer-42'; }
  async getJobStatus(job: PrintJob): Promise<PrintJob> { return { ...job, status: 'pending' }; }
  async cancelJob() { this.cancellations++; }
}

export const printRequest = {
  printerId: 'test-printer', assetUrl: 'https://assets.example/invoice.pdf?signature=test',
  settings: { copies: 2, paperSize: 'A4', sides: 'two-sided-long-edge' as const }, idempotencyKey: 'test-key',
};

export const pdfBytes = Buffer.from('%PDF-1.4\n%%EOF');
export const fakeDownload = async (_url: string) => pdfBytes;
// Tiny image fixture bytes stay local to the test, never in MCP arguments.
export const pngBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
