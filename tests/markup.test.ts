import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { findBrowser } from '../src/browser.js';
import { renderMarkup, prepareMarkupRuntime } from '../src/markup.js';
import { markupPrintRequestSchema, PrinterService } from '../src/printing.js';
import { createPrinterHttpServer } from '../src/server.js';
import { connectPrinter } from '../src/client.js';
import { FakePrinter, temporaryDirectory, pngBytes, printRequest } from './helpers.js';

const browserExecutablePath = await findBrowser().catch(() => undefined);
if (!browserExecutablePath && process.env.REQUIRE_CHROMIUM_TESTS === '1') throw new Error('Chromium is required for the rendering integration tests.');
const chromium = { skip: !browserExecutablePath };

test('printMarkup requires exactly one source and caps inline UTF-8 payloads', () => {
  const base = { printerId: 'test-printer', format: 'markdown' as const, idempotencyKey: 'key' };
  assert.throws(() => markupPrintRequestSchema.parse(base));
  assert.throws(() => markupPrintRequestSchema.parse({ ...base, content: '# Test', assetUrl: 'https://assets.example/report.md' }));
  assert.throws(() => markupPrintRequestSchema.parse({ ...base, content: 'é'.repeat(20_000) }));
  assert.throws(() => markupPrintRequestSchema.parse({ ...base, assetUrl: 'file:///etc/passwd' }));
  assert.equal(markupPrintRequestSchema.parse({ ...base, content: '# Test' }).content, '# Test');
});

test('browser discovery rejects a missing explicit executable without downloading', async () => {
  await assert.rejects(findBrowser({ browserExecutablePath: '/nonexistent/printgo-browser' }), { code: 'BROWSER_NOT_FOUND' });
});

async function commands(pdf: Buffer): Promise<string> {
  const doc = await PDFDocument.load(pdf);
  const contents = doc.getPage(0).node.Contents()!;
  const streams = contents instanceof PDFRawStream ? [contents] : Array.from({ length: (contents as any).size() }, (_, i) => (contents as any).lookup(i));
  return streams.map(stream => Buffer.from(decodePDFRawStream(stream).decode()).toString()).join('\n');
}

test('Chromium renders Markdown formatting/tables and paginated HTML with full CSS', chromium, async () => {
  const tmp = await temporaryDirectory();
  try {
    const workerPath = await prepareMarkupRuntime(tmp.directory);
    const options = { workerPath, stateDir: tmp.directory, browserExecutablePath };
    const markdown = await renderMarkup('# Receipt\n\n**Paid** and _approved_.\n\n|Item|Price|\n|---|---|\n|Coffee|3|\n\n- first\n- second', 'markdown', {}, options);
    assert.equal((await PDFDocument.load(markdown)).getPageCount(), 1);
    assert.match(await commands(markdown), /Tf/);
    const html = await renderMarkup(`<style>.grid {display:grid;grid-template-columns:1fr 1fr;gap:12px} .cell{background:#dcecff;padding:16px} .next{break-before:page}</style>
      <div class="grid"><div class="cell">Left</div><div class="cell">Right</div></div><h1 class="next">Page two</h1>`, 'html', { paperSize: 'Letter', orientation: 'landscape' }, options);
    const doc = await PDFDocument.load(html);
    assert.equal(doc.getPageCount(), 2);
    assert.ok(Math.abs(doc.getPage(0).getWidth() - 792) < 1);
    assert.ok(Math.abs(doc.getPage(0).getHeight() - 612) < 1);
    assert.match(await commands(html), / re/);
  } finally { await tmp.cleanup(); }
});

test('linked CSS/images use the guarded downloader and the source URL as their base', chromium, async () => {
  const tmp = await temporaryDirectory();
  const requests: string[] = [];
  try {
    const workerPath = await prepareMarkupRuntime(tmp.directory);
    const pdf = await renderMarkup('<link rel="stylesheet" href="theme.css"><h1>Receipt</h1><img src="logo.png"><div class="print-logo"></div>', 'html', {}, {
      workerPath, stateDir: tmp.directory, browserExecutablePath, baseUrl: 'https://assets.example/reports/receipt.html',
      download: async url => {
        requests.push(url);
        if (url.endsWith('theme.css')) return { bytes: Buffer.from('h1{color:blue} img{width:40px} @media print {.print-logo{width:40px;height:40px;background-image:url(print.png)}}'), contentType: 'text/css' };
        return { bytes: pngBytes, contentType: 'image/png' };
      },
    });
    assert.deepEqual(requests.sort(), ['https://assets.example/reports/logo.png', 'https://assets.example/reports/print.png', 'https://assets.example/reports/theme.css']);
    const doc = await PDFDocument.load(pdf);
    assert.ok(doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject')));
    assert.equal((await readdir(join(tmp.directory, 'runtime'))).filter(name => name.startsWith('render-profile-')).length, 0);
  } finally { await tmp.cleanup(); }
});

test('scripts and event handlers never fetch, while private linked assets fail safely', chromium, async () => {
  const tmp = await temporaryDirectory();
  try {
    const workerPath = await prepareMarkupRuntime(tmp.directory);
    let downloads = 0;
    const options = { workerPath, stateDir: tmp.directory, browserExecutablePath };
    const pdf = await renderMarkup('<script>fetch("https://127.0.0.1/secret")</script><h1 onclick="fetch(\'https://127.0.0.1\')">Safe document</h1>', 'html', {},
      { ...options, download: async () => { downloads++; throw new Error('Unexpected request'); } });
    assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1);
    assert.equal(downloads, 0);
    await assert.rejects(renderMarkup('<img src="https://127.0.0.1/secret">', 'html', {}, options), { code: 'UNSAFE_ASSET_URL' });
    await assert.rejects(renderMarkup('<iframe src="https://example.com"></iframe>', 'html', {}, options), { code: 'MARKUP_UNSUPPORTED_CONTENT' });
    await assert.rejects(renderMarkup('<img src="file:///etc/passwd">', 'html', {}, options));
    await assert.rejects(renderMarkup('<style>body{background-image:url(file:///etc/passwd)}</style><p>Blocked background</p>', 'html', {}, options), { code: 'MARKUP_RESOURCE_BLOCKED' });
  } finally { await tmp.cleanup(); }
});

test('render limits and worker deadlines return errors and terminate the helper', chromium, async () => {
  const tmp = await temporaryDirectory();
  try {
    const workerPath = await prepareMarkupRuntime(tmp.directory);
    const options = { workerPath, stateDir: tmp.directory, browserExecutablePath };
    await assert.rejects(renderMarkup('<div>'.repeat(80) + 'deep' + '</div>'.repeat(80), 'html', {}, options), { code: 'MARKUP_TOO_LARGE' });
    await assert.rejects(renderMarkup('<div style="height:1000000px">Too tall</div>', 'html', {}, options), { code: 'MARKUP_TOO_LARGE' });
    const hangingWorker = join(tmp.directory, 'hanging.cjs');
    const pidFile = join(tmp.directory, 'worker.pid');
    await writeFile(hangingWorker, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.stdin.resume(); setInterval(()=>{},1000);`);
    await assert.rejects(renderMarkup('hello', 'html', {}, { ...options, workerPath: hangingWorker, timeoutMs: 300 }), { code: 'MARKUP_RENDER_TIMEOUT' });
    const pid = Number(await readFile(pidFile, 'utf8'));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    for (const directory of [tmp.directory, join(tmp.directory, 'runtime')]) {
      assert.equal((await readdir(directory)).filter(name => name.startsWith('render-profile-')).length, 0);
    }
  } finally { await tmp.cleanup(); }
});

test('MCP SDK prints inline/URL markup, preserves retry safety and creates no job on render failure', chromium, async () => {
  const tmp = await temporaryDirectory();
  const adapter = new FakePrinter();
  const pageCounts: number[] = [];
  let downloads = 0;
  adapter.submit = async (path?: string) => {
    pageCounts.push((await PDFDocument.load(await readFile(path!))).getPageCount());
    return `fake-${++adapter.submissions}`;
  };
  const app = createPrinterHttpServer({ password: 'x'.repeat(43), stateDir: tmp.directory, adapter, browserExecutablePath,
    assetDownloader: async () => { downloads++; return { bytes: Buffer.from('<h1>URL receipt</h1>'), contentType: 'text/html', finalUrl: 'https://assets.example/final/receipt.html' }; } });
  let client: Awaited<ReturnType<typeof connectPrinter>> | undefined;
  try {
    const localURL = await app.listen();
    client = await connectPrinter({ password: 'x'.repeat(43), mcpConnectionURL: `${localURL}/mcp` });
    const inline = { printerId: 'test-printer', format: 'markdown' as const, content: '# Paid\n\n**Receipt**', idempotencyKey: 'inline' };
    const job = await client.printMarkup(inline);
    assert.equal(job.status, 'submitted');
    assert.equal((await client.printMarkup(inline)).jobId, job.jobId);
    await assert.rejects(client.printMarkup({ ...inline, content: '# Changed' }), { code: 'IDEMPOTENCY_CONFLICT' });
    const request = { printerId: 'test-printer', format: 'html' as const, assetUrl: 'https://assets.example/receipt.html', idempotencyKey: 'url' };
    const urlJob = await client.printMarkup(request);
    assert.equal((await client.printMarkup(request)).jobId, urlJob.jobId);
    assert.equal(downloads, 1);
    assert.equal(adapter.submissions, 2);
    assert.deepEqual(pageCounts, [1, 1]);
    await assert.rejects(client.printMarkup({ ...inline, content: '<iframe></iframe>', format: 'html', idempotencyKey: 'bad' }), { code: 'MARKUP_UNSUPPORTED_CONTENT' });
    const jobs = await readFile(join(tmp.directory, 'jobs.json'), 'utf8');
    assert.equal(JSON.parse(jobs).length, 2);
    assert.doesNotMatch(jobs, /Receipt|assets\.example|iframe/);
    assert.equal((await stat(join(tmp.directory, 'runtime', 'markup-worker.cjs'))).mode & 0o777, 0o600);
    const resumed = new PrinterService(adapter, tmp.directory, async () => { throw new Error('Expired URL'); });
    assert.equal((await resumed.printMarkup(request)).jobId, urlJob.jobId);
    await assert.rejects(resumed.sendPrintCommand({ ...printRequest, idempotencyKey: 'url' }), { code: 'IDEMPOTENCY_CONFLICT' });
  } finally { await client?.close(); await app.close(); await tmp.cleanup(); }
});
