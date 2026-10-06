import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrinterHttpServer } from 'printgo';
import { connectPrinter } from '../src/client.js';
import { MAX_REQUEST_BYTES } from '../src/printing.js';
import { request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { FakePrinter, printRequest, temporaryDirectory, fakeDownload, pngBytes } from './helpers.js';

const password = 'x'.repeat(43);
const adminToken = 'a'.repeat(43);

test('HTTP security, modern MCP SDK, all printer tools, and legacy JSON transport', async () => {
  const tmp = await temporaryDirectory();
  const adapter = new FakePrinter();
  const app = createPrinterHttpServer({ password, adminToken, stateDir: tmp.directory, adapter, assetDownloader: fakeDownload, getStatus: () => ({ instanceId: 'test', status: 'running' }) });
  const localURL = await app.listen();
  let client: Awaited<ReturnType<typeof connectPrinter>> | undefined;
  const headers = { Authorization: `Bearer ${password}` };
  try {
    const unauthorized = await fetch(`${localURL}/health`);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get('www-authenticate'), 'Bearer realm="printgo"');
    for (const invalid of [
      { 'x-auth-token': password },
      { Authorization: password },
      { Authorization: `Basic ${password}` },
      { Authorization: 'Bearer incorrect' },
      { Authorization: `Bearer ${adminToken}` },
    ]) {
      assert.equal((await fetch(`${localURL}/health`, { headers: invalid })).status, 401);
    }
    assert.equal((await fetch(`${localURL}/health`, { headers: { ...headers, Origin: 'https://attacker.example' } })).status, 403);
    const badHostStatus = await new Promise<number>(resolve => {
      const request = httpRequest(`${localURL}/health`, { headers: { ...headers, Host: 'attacker.example' } }, response => {
        response.resume(); resolve(response.statusCode!);
      });
      request.end();
    });
    assert.equal(badHostStatus, 403);
    assert.equal((await fetch(`${localURL}/health`, { headers: { authorization: `bearer ${password}` } })).status, 200);
    assert.equal((await fetch(`${localURL}/internal/status`, { headers })).status, 401);
    const control = await fetch(`${localURL}/internal/status`, { headers: { Authorization: `Bearer ${adminToken}` } });
    assert.deepEqual(await control.json(), { instanceId: 'test', status: 'running' });
    client = await connectPrinter({ mcpConnectionURL: `${localURL}/mcp`, password });
    assert.equal((await client.listPrinters())[0]!.id, 'test-printer');
    assert.equal((await client.checkPrinterStatus('test-printer')).state, 'idle');
    assert.deepEqual((await client.getPrinterCapabilities('test-printer')).options.PageSize, ['A4', 'Letter']);
    await assert.rejects(client.checkPrinterStatus('bad-printer'), { code: 'PRINTER_NOT_FOUND' });
    const job = await client.sendPrintCommand(printRequest);
    assert.equal(job.status, 'submitted');
    assert.equal((await client.getPrintJobStatus(job.jobId)).status, 'pending');
    assert.equal((await client.cancelPrintJob(job.jobId)).status, 'cancelled');
    assert.equal(adapter.submissions, 1);
    const legacy = await fetch(`${localURL}/mcp`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } } }),
    });
    assert.equal(legacy.status, 200, await legacy.clone().text());
    assert.match(legacy.headers.get('content-type')!, /application\/json/);
    assert.equal((await legacy.json() as any).result.serverInfo.name, 'printgo-mcp');
    const tools = await fetch(`${localURL}/mcp`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    assert.match(tools.headers.get('content-type')!, /application\/json/);
    const exposedTools = (await tools.json() as any).result.tools;
    assert.equal(exposedTools.length, 7);
    const printTool = exposedTools.find((tool: any) => tool.name === 'sendPrintCommand');
    assert.ok(printTool.inputSchema.properties.assetUrl);
    assert.deepEqual(printTool.inputSchema.properties.assetType.enum, ['auto', 'pdf', 'png', 'jpeg', 'text']);
    assert.equal(printTool.inputSchema.properties.document, undefined);
    assert.equal(printTool.annotations.openWorldHint, true);
    const markupTool = exposedTools.find((tool: any) => tool.name === 'printMarkup');
    assert.deepEqual(markupTool.inputSchema.properties.format.enum, ['markdown', 'html']);
    assert.ok(markupTool.inputSchema.properties.content);
    assert.ok(markupTool.inputSchema.properties.assetUrl);
    const oversized = await fetch(`${localURL}/mcp`, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: ' '.repeat(MAX_REQUEST_BYTES + 1),
    });
    assert.equal(oversized.status, 413);
  } finally { await client?.close(); await app.close(); await tmp.cleanup(); }
});

test('MCP SDK prints image/text URLs through conversion and never spools unsupported assets', async () => {
  const tmp = await temporaryDirectory();
  const adapter = new FakePrinter();
  const pageCounts: number[] = [];
  let downloads = 0;
  adapter.submit = async (path?: string) => {
    const pdf = await PDFDocument.load(await readFile(path!));
    pageCounts.push(pdf.getPageCount());
    adapter.submissions++;
    return `fake-${adapter.submissions}`;
  };
  const app = createPrinterHttpServer({ password, stateDir: tmp.directory, adapter, assetDownloader: async url => {
    downloads++;
    if (url.endsWith('/image')) return { bytes: pngBytes, contentType: 'image/png' };
    if (url.endsWith('/text')) return { bytes: Buffer.from('Café — Привет\n'.repeat(120)), contentType: 'application/octet-stream' };
    return { bytes: Buffer.from('<html>login</html>'), contentType: 'text/html' };
  } });
  let client: Awaited<ReturnType<typeof connectPrinter>> | undefined;
  try {
    const localURL = await app.listen();
    client = await connectPrinter({ mcpConnectionURL: `${localURL}/mcp`, password });
    const imageRequest = { ...printRequest, assetUrl: 'https://assets.example/image', idempotencyKey: 'image-job' };
    const image = await client.sendPrintCommand(imageRequest);
    assert.equal(image.status, 'submitted');
    assert.equal((await client.sendPrintCommand(imageRequest)).jobId, image.jobId);
    const text = await client.sendPrintCommand({ ...printRequest, assetUrl: 'https://assets.example/text', assetType: 'text', idempotencyKey: 'text-job' });
    assert.equal(text.status, 'submitted');
    assert.equal(downloads, 2);
    assert.equal(adapter.submissions, 2);
    assert.equal(pageCounts[0], 1);
    assert.ok(pageCounts[1]! >= 3);
    await assert.rejects(client.sendPrintCommand({ ...printRequest, assetUrl: 'https://assets.example/login', idempotencyKey: 'bad-job' }), { code: 'UNSUPPORTED_ASSET_TYPE' });
    assert.equal(adapter.submissions, 2);
    const jobs = JSON.parse(await readFile(join(tmp.directory, 'jobs.json'), 'utf8'));
    assert.equal(jobs.length, 2);
  } finally { await client?.close(); await app.close(); await tmp.cleanup(); }
});
