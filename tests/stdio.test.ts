import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { connectPrinter, createPrinterMcpServer, servePrinterStdio } from 'printgo';
import { FakePrinter, fakeDownload, printRequest, temporaryDirectory } from './helpers.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/stdio.mjs', import.meta.url));

test('transport-independent MCP server works with a custom adapter and in-memory transport', async () => {
  const tmp = await temporaryDirectory();
  const adapter = new FakePrinter();
  const server = createPrinterMcpServer({ stateDir: tmp.directory, adapter, assetDownloader: fakeDownload });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  let printer: Awaited<ReturnType<typeof connectPrinter>> | undefined;
  try {
    await server.connect(serverTransport);
    printer = await connectPrinter({ transport: clientTransport });
    assert.deepEqual(await printer.listPrinters(), await adapter.listPrinters());
    const jobs = await Promise.all([printer.sendPrintCommand(printRequest), printer.sendPrintCommand(printRequest)]);
    assert.equal(jobs[0]!.jobId, jobs[1]!.jobId);
    assert.equal(adapter.submissions, 1);
  } finally { await printer?.close(); await server.close(); await tmp.cleanup(); }
});

test('typed client uses stdio for printer tools, errors, retries, and durable history', { timeout: 20_000 }, async () => {
  const tmp = await temporaryDirectory();
  const open = () => connectPrinter({ transport: new StdioClientTransport({ command: process.execPath, args: [fixture, tmp.directory] }) });
  let printer: Awaited<ReturnType<typeof connectPrinter>> | undefined;
  try {
    printer = await open();
    assert.equal((await printer.listPrinters())[0]!.id, 'test-printer');
    assert.deepEqual((await printer.getPrinterCapabilities('test-printer')).options.PageSize, ['A4', 'Letter']);
    assert.equal((await printer.checkPrinterStatus('test-printer')).state, 'idle');
    await assert.rejects(printer.checkPrinterStatus('missing'), { code: 'PRINTER_NOT_FOUND' });
    // Exercises printMarkup dispatch without requiring a browser or printing paper.
    await assert.rejects(printer.printMarkup({ printerId: 'missing', format: 'html', content: '<p>test</p>', idempotencyKey: 'markup' }), { code: 'PRINTER_NOT_FOUND' });
    const [job, retry] = await Promise.all([printer.sendPrintCommand(printRequest), printer.sendPrintCommand(printRequest)]);
    assert.equal(job.jobId, retry.jobId);
    assert.equal(job.nativeJobId, 'test-printer-1');
    await assert.rejects(printer.sendPrintCommand({ ...printRequest, settings: { copies: 3 } }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal((await printer.getPrintJobStatus(job.jobId)).status, 'pending');
    assert.equal((await printer.cancelPrintJob(job.jobId)).status, 'cancelled');
    await printer.close();
    printer = await open();
    assert.equal((await printer.sendPrintCommand(printRequest)).jobId, job.jobId);
    assert.equal((await printer.getPrintJobStatus(job.jobId)).status, 'cancelled');
    assert.deepEqual((await readdir(tmp.directory)).sort(), ['documents', 'jobs.json']);
  } finally { await printer?.close(); await tmp.cleanup(); }
});

for (const [label, mode] of [['modern', { pin: '2026-07-28' }], ['legacy', 'legacy']] as const) {
  test(`CLI stdio serves ${label} clients with no cloudflared, credentials, or daemon`, { timeout: 15_000 }, async () => {
    const tmp = await temporaryDirectory();
    const transport = new StdioClientTransport({
      command: process.execPath, args: [cli, 'stdio', '--state-dir', tmp.directory],
      env: { PATH: tmp.directory }, stderr: 'pipe',
    });
    let diagnostics = '';
    transport.stderr!.on('data', chunk => { diagnostics += chunk; });
    const client = new Client({ name: 'stdio-test', version: '1' }, { versionNegotiation: { mode } });
    try {
      await client.connect(transport);
      assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), [
        'cancelPrintJob', 'checkPrinterStatus', 'getPrintJobStatus', 'getPrinterCapabilities', 'listPrinters', 'printMarkup', 'sendPrintCommand',
      ]);
      assert.deepEqual(await readdir(tmp.directory), []);
      assert.equal(diagnostics, '');
    } finally { await client.close(); await tmp.cleanup(); }
  });
}

test('stdio exits on EOF and SIGTERM, keeping stdout reserved for protocol messages', { timeout: 15_000 }, async () => {
  const tmp = await temporaryDirectory();
  try {
    for (const signal of [false, true]) {
      const child = spawn(process.execPath, [cli, 'stdio', '--state-dir', tmp.directory], { stdio: ['pipe', 'pipe', 'pipe'] });
      const exited = once(child, 'exit');
      let stdout = '', stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      try {
        if (signal) {
          const response = once(child.stdout, 'data');
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
            protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'exit-test', version: '1' },
          } }) + '\n');
          await response;
          child.kill('SIGTERM');
        } else child.stdin.end();
        assert.deepEqual(await exited, [0, null]);
        if (signal) assert.equal(JSON.parse(stdout).id, 1);
        else assert.equal(stdout, '');
        assert.equal(stderr, '');
      } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
    }
    const execute = promisify(execFile);
    for (const flag of ['--quick', '--yes', '--json', '--port=8787']) {
      await assert.rejects(execute(process.execPath, [cli, 'stdio', '--state-dir', tmp.directory, flag]), (error: any) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        assert.match(error.stderr, /INVALID_OPTIONS/);
        return true;
      });
    }
    assert.deepEqual(await readdir(tmp.directory), []);
  } finally { await tmp.cleanup(); }
});

test('stdio reports and closes oversized input without writing non-protocol output', async () => {
  const stdin = new PassThrough(), stdout = new PassThrough();
  let output = '';
  stdout.on('data', chunk => { output += chunk; });
  const errors: Error[] = [];
  const app = servePrinterStdio({ stdin, stdout, adapter: new FakePrinter(), onerror: error => errors.push(error) });
  try {
    stdin.write('x'.repeat(64 * 1024 + 1));
    assert.equal(errors.length, 1);
    assert.equal(stdin.listenerCount('data'), 0);
    assert.equal(output, '');
  } finally { await app.close(); stdin.destroy(); stdout.destroy(); }
});
