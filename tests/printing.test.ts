import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PrinterService } from '../src/printing.js';
import { CupsPrinterAdapter } from '../src/printers.js';
import { PrintGoError } from '../src/errors.js';
import { FakePrinter, printRequest, temporaryDirectory, fakeDownload, pdfBytes } from './helpers.js';

test('concurrent retries and daemon restarts do not duplicate physical submissions', async () => {
  const tmp = await temporaryDirectory();
  try {
    const adapter = new FakePrinter();
    let downloads = 0;
    adapter.submit = async (file?: string) => {
      assert.deepEqual(await readFile(file!), pdfBytes);
      adapter.submissions++;
      return 'test-printer-42';
    };
    const service = new PrinterService(adapter, tmp.directory, async url => {
      assert.equal(url, printRequest.assetUrl);
      downloads++;
      return pdfBytes;
    });
    const jobs = await Promise.all(Array.from({ length: 5 }, () => service.sendPrintCommand(printRequest)));
    assert.equal(adapter.submissions, 1);
    assert.equal(new Set(jobs.map(job => job.jobId)).size, 1);
    const resumed = new PrinterService(adapter, tmp.directory, async () => { throw new Error('Signed URL expired'); });
    assert.equal((await resumed.sendPrintCommand(printRequest)).jobId, jobs[0]!.jobId);
    assert.equal(adapter.submissions, 1);
    await assert.rejects(resumed.sendPrintCommand({ ...printRequest, settings: { copies: 3 } }), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(resumed.sendPrintCommand({ ...printRequest, assetUrl: 'https://assets.example/other.pdf' }), { code: 'IDEMPOTENCY_CONFLICT' });
    await assert.rejects(resumed.sendPrintCommand({ ...printRequest, assetType: 'text' }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal((await resumed.sendPrintCommand({ ...printRequest, assetType: 'auto' })).jobId, jobs[0]!.jobId);
    assert.equal(downloads, 1);
    assert.doesNotMatch(await readFile(join(tmp.directory, 'jobs.json'), 'utf8'), /signature=test|assets\.example/);
    assert.deepEqual(await readdir(join(tmp.directory, 'documents')), []);
    assert.equal((await service.getPrintJobStatus(jobs[0]!.jobId)).status, 'pending');
    assert.equal((await service.cancelPrintJob(jobs[0]!.jobId)).status, 'cancelled');
    await service.cancelPrintJob(jobs[0]!.jobId);
    assert.equal(adapter.cancellations, 1);
  } finally { await tmp.cleanup(); }
});

test('validation rejects unsafe documents, printer IDs and settings before submission', async () => {
  const tmp = await temporaryDirectory();
  try {
    const adapter = new FakePrinter();
    const service = new PrinterService(adapter, tmp.directory, fakeDownload);
    await assert.rejects(service.sendPrintCommand({ ...printRequest, assetUrl: 'file:///tmp/invoice.pdf' }));
    await assert.rejects(service.sendPrintCommand({ ...printRequest, assetUrl: 'https://127.0.0.1/invoice.pdf' }));
    await assert.rejects(service.sendPrintCommand({ ...printRequest, document: { mimeType: 'application/pdf', dataBase64: 'AAAA' } } as any));
    await assert.rejects(new PrinterService(adapter, tmp.directory, async () => Buffer.from('not PDF')).sendPrintCommand(printRequest), { code: 'INVALID_DOCUMENT' });
    await assert.rejects(service.sendPrintCommand({ ...printRequest, printerId: 'nonexistent' }), { code: 'PRINTER_NOT_FOUND' });
    await assert.rejects(service.sendPrintCommand({ ...printRequest, settings: { copies: 0 } }));
    await assert.rejects(service.sendPrintCommand({ ...printRequest, settings: { pageRanges: '5-2' } }));
    await assert.rejects(service.sendPrintCommand({ ...printRequest, settings: { paperSize: 'A4;touch /tmp/injected' } }));
    assert.equal(adapter.submissions, 0);
  } finally { await tmp.cleanup(); }
});

test('ambiguous spooler errors are persisted and never automatically resubmitted', async () => {
  const tmp = await temporaryDirectory();
  try {
    const adapter = new FakePrinter();
    adapter.submit = async () => { adapter.submissions++; throw new Error('Spooler timed out'); };
    const service = new PrinterService(adapter, tmp.directory, fakeDownload);
    const result = await service.sendPrintCommand(printRequest);
    assert.equal(result.status, 'unknown');
    assert.match(result.details!, /Submission may have occurred/);
    assert.equal((await new PrinterService(adapter, tmp.directory, fakeDownload).sendPrintCommand(printRequest)).status, 'unknown');
    assert.equal(adapter.submissions, 1);
  } finally { await tmp.cleanup(); }
});

test('failed downloads create no job and allow a safe retry with the same key', async () => {
  const tmp = await temporaryDirectory();
  try {
    const adapter = new FakePrinter();
    const service = new PrinterService(adapter, tmp.directory, async () => { throw new PrintGoError('ASSET_DOWNLOAD_FAILED', 'Expired URL'); });
    await assert.rejects(service.sendPrintCommand(printRequest), { code: 'ASSET_DOWNLOAD_FAILED' });
    await assert.rejects(readFile(join(tmp.directory, 'jobs.json')), { code: 'ENOENT' });
    assert.equal(adapter.submissions, 0);
    const retry = await new PrinterService(adapter, tmp.directory, fakeDownload).sendPrintCommand(printRequest);
    assert.equal(retry.status, 'submitted');
    assert.equal(adapter.submissions, 1);
  } finally { await tmp.cleanup(); }
});

test('CUPS maps settings to argument arrays and treats a missing default printer as valid', async () => {
  const calls: { file: string; args: string[] }[] = [];
  const cups = new CupsPrinterAdapter(async (file, args) => {
    calls.push({ file, args });
    if (args.includes('-d') && file === 'lpstat') throw new PrintGoError('COMMAND_FAILED', 'no system default destination');
    if (file === 'lpstat') return 'printer test-printer is idle. enabled since yesterday\n';
    return 'request id is test-printer-123 (1 file(s))\n';
  });
  assert.equal((await cups.listPrinters())[0]!.isDefault, false);
  assert.equal(await cups.submit('/tmp/test.pdf', 'test-printer', { copies: 2, sides: 'two-sided-long-edge', pageRanges: '1-3' }, 'test-job'), 'test-printer-123');
  assert.deepEqual(calls.at(-1)!.args, ['-d', 'test-printer', '-t', 'test-job', '-n', '2', '-o', 'page-ranges=1-3', '-o', 'sides=two-sided-long-edge', '--', '/tmp/test.pdf']);
});
