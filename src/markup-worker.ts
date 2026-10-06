import puppeteer, { type Browser, type HTTPRequest } from 'puppeteer-core';
import { parse, serialize, defaultTreeAdapter, html as htmlTypes, type DefaultTreeAdapterMap } from 'parse5';
import { marked } from 'marked';
import { PDFDocument } from 'pdf-lib';
import { fontBytes } from './fonts/font.js';
import { PrintGoError } from './errors.js';
import type { DownloadedAsset } from './assets.js';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
const MAIN_URL = 'https://printgo.invalid/render';
const FONT_URL = 'https://printgo.invalid/font.ttf';
const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline' https:; img-src https:; font-src https:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri https:";

function printableHtml(content: string, format: 'markdown' | 'html', baseUrl?: string): string {
  const html = format === 'markdown' ? marked.parse(content, { async: false, gfm: true }) : content;
  const tree = parse(html);
  let count = 0;
  const visit = (node: Node, depth: number) => {
    if (++count > 20_000 || depth > 64) throw new PrintGoError('MARKUP_TOO_LARGE', 'Markup is limited to 20,000 DOM nodes and 64 nesting levels.');
    if ('tagName' in node) {
      const tag = node.tagName.toLowerCase();
      if (['script', 'base'].includes(tag) || (tag === 'link' && node.attrs.find(attr => attr.name === 'rel')?.value.toLowerCase() !== 'stylesheet') ||
          (tag === 'meta' && node.attrs.some(attr => attr.name === 'http-equiv'))) {
        defaultTreeAdapter.detachNode(node); return;
      }
      if (['iframe', 'frame', 'object', 'embed'].includes(tag)) throw new PrintGoError('MARKUP_UNSUPPORTED_CONTENT', 'Frames, objects and embedded documents are unsupported. Provide a self-contained document.');
      node.attrs = node.attrs.filter(attr => !attr.name.toLowerCase().startsWith('on'));
      const resources = new Set(['src', 'poster', ...(tag === 'link' || ['image', 'use'].includes(tag) ? ['href', 'xlink:href'] : [])]);
      for (const attr of node.attrs) {
        if (resources.has(attr.name) && attr.value.trim() && new URL(attr.value, baseUrl ?? MAIN_URL).protocol !== 'https:') {
          throw new PrintGoError('MARKUP_RESOURCE_BLOCKED', 'Linked rendering resources must use public HTTPS URLs. Local files, HTTP and data URLs are unsupported.');
        }
      }
      if (tag === 'a') node.attrs = node.attrs.filter(attr => attr.name !== 'href' || attr.value.startsWith('#') || ['https:', 'http:'].includes(new URL(attr.value, baseUrl ?? MAIN_URL).protocol));
    }
    if ('childNodes' in node) for (const child of [...node.childNodes]) visit(child, depth + 1);
    if ('content' in node) visit(node.content, depth + 1);
  };
  visit(tree, 0);
  const root = tree.childNodes.find(node => 'tagName' in node && node.tagName === 'html') as Element;
  const head = root.childNodes.find(node => 'tagName' in node && node.tagName === 'head') as Element;
  const base = defaultTreeAdapter.createElement('base', htmlTypes.NS.HTML, [{ name: 'href', value: baseUrl ?? MAIN_URL }]);
  const style = defaultTreeAdapter.createElement('style', htmlTypes.NS.HTML, []);
  defaultTreeAdapter.insertText(style, `
    @font-face { font-family: PrintGo; src: url(${FONT_URL}); }
    body { font: 10.5pt PrintGo, sans-serif; margin: 0; color: #222; }
    ${format === 'markdown' ? `
      h1,h2,h3,h4,h5,h6 { line-height: 1.25; break-after: avoid; }
      p,li { line-height: 1.45; } table { border-collapse: collapse; width: 100%; }
      th,td { border: 1px solid #ccc; padding: 6px 8px; } th { background: #eee; text-align: left; }
      pre { background: #f4f4f4; padding: 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
      code { font-family: monospace; } blockquote { border-left: 3px solid #aaa; margin-left: 0; padding-left: 12px; }
      img { max-width: 100%; height: auto; } a { color: #245da8; }` : ''}
  `);
  if (head.childNodes[0]) defaultTreeAdapter.insertBefore(head, style, head.childNodes[0]); else defaultTreeAdapter.appendChild(head, style);
  defaultTreeAdapter.insertBefore(head, base, style);
  return serialize(tree);
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new PrintGoError('MARKUP_TOO_LARGE', 'Rendering input exceeds its limit.');
    chunks.push(Buffer.from(chunk));
  }
  const input = JSON.parse(Buffer.concat(chunks).toString()) as { content: string; format: 'markdown' | 'html'; dimensions: [number, number]; executablePath: string; baseUrl?: string; profileDirectory: string };
  const html = printableHtml(input.content, input.format, input.baseUrl);
  let browser: Browser | undefined;
  const pending = new Map<number, (asset: DownloadedAsset) => void>();
  let resourceId = 0, navigationHandled = false;
  let fatal: (error: Error) => void = () => {};
  const failure = new Promise<never>((_resolve, reject) => { fatal = reject; });
  // Handle parent death even during browser launch: Puppeteer's SIGINT hook kills its process tree.
  process.once('disconnect', () => { process.emit('SIGINT'); process.exit(1); });
  process.on('message', (message: any) => {
    if (message.kind !== 'resource-result') return;
    const resolve = pending.get(message.id);
    pending.delete(message.id);
    resolve?.(message);
  });
  const render = async () => {
    browser = await puppeteer.launch({ executablePath: input.executablePath, headless: true, timeout: 20_000, pipe: true, userDataDir: input.profileDirectory,
      args: ['--disable-background-networking', '--dns-prefetch-disable', '--renderer-process-limit=1'] });
    process.send?.({ kind: 'browser', pid: browser.process()!.pid });
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setBypassServiceWorker(true);
    await page.setViewport({ width: Math.round((input.dimensions[0] - 72) * 96 / 72), height: Math.round((input.dimensions[1] - 72) * 96 / 72) });
    await page.emulateMediaType('print');
    await page.setRequestInterception(true);
    page.on('console', message => {
      if (message.type() === 'error' && /Content Security Policy|Not allowed to load local resource|Refused to load/i.test(message.text())) {
        fatal(new PrintGoError('MARKUP_RESOURCE_BLOCKED', 'A rendering resource was blocked by the document security policy. Use public HTTPS assets.'));
      }
    });
    page.on('requestfailed', () => fatal(new PrintGoError('MARKUP_RESOURCE_FAILED', 'A rendering asset was blocked or could not be loaded. Use public HTTPS assets; file, HTTP and data image URLs are unsupported.')));
    async function handleRequest(request: HTTPRequest): Promise<void> {
      if (!navigationHandled && request.isNavigationRequest() && request.url() === MAIN_URL) {
        navigationHandled = true;
        await request.respond({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'Content-Security-Policy': CSP }, body: html });
        return;
      }
      if (request.url() === FONT_URL && request.resourceType() === 'font') {
        await request.respond({ status: 200, contentType: 'font/ttf', headers: { 'Access-Control-Allow-Origin': '*' }, body: fontBytes });
        return;
      }
      if (request.url() === 'https://printgo.invalid/favicon.ico') { await request.respond({ status: 204 }); return; }
      if (!['image', 'stylesheet', 'font'].includes(request.resourceType()) || !request.url().startsWith('https://')) {
        await request.abort();
        fatal(new PrintGoError('MARKUP_RESOURCE_BLOCKED', `Rendering blocked a ${request.resourceType()} resource. Only public HTTPS images, stylesheets and fonts are permitted.`));
        return;
      }
      const id = ++resourceId;
      const asset = await new Promise<DownloadedAsset>(resolve => {
        pending.set(id, resolve);
        process.send?.({ kind: 'resource', id, url: request.url(), resourceType: request.resourceType() });
      });
      if (asset.finalUrl && asset.finalUrl !== request.url()) {
        await request.respond({ status: 307, headers: { Location: asset.finalUrl } });
        return;
      }
      await request.respond({ status: 200, contentType: asset.contentType ?? (request.resourceType() === 'stylesheet' ? 'text/css' : 'application/octet-stream'),
        headers: { 'Access-Control-Allow-Origin': '*' }, body: asset.bytes });
    }
    page.on('request', request => {
      void handleRequest(request).catch(() => fatal(new PrintGoError('MARKUP_RESOURCE_FAILED', 'A linked rendering asset could not be loaded.')));
    });
    await page.goto(MAIN_URL, { waitUntil: 'networkidle0', timeout: 25_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => document.getAnimations().forEach(animation => { animation.pause(); animation.currentTime = 0; }));
    const limits = await page.evaluate(() => {
      const nodes = document.querySelectorAll('*');
      let breaks = 0;
      for (const node of nodes) {
        const style = getComputedStyle(node);
        if (['page', 'always', 'left', 'right', 'recto', 'verso'].includes(style.breakBefore)) breaks++;
        if (['page', 'always', 'left', 'right', 'recto', 'verso'].includes(style.breakAfter)) breaks++;
      }
      const images = Array.from(document.images);
      return { height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight), breaks,
        imagesTooLarge: images.some(image => image.naturalWidth * image.naturalHeight > 16_000_000 || image.naturalWidth > 16384 || image.naturalHeight > 16384) };
    });
    if (limits.height > (input.dimensions[1] - 72) * 96 / 72 * 100 || limits.breaks > 100 || limits.imagesTooLarge) {
      throw new PrintGoError('MARKUP_TOO_LARGE', 'Rendered documents are limited to 100 pages and images to 16 megapixels.');
    }
    const pdf = Buffer.from(await page.pdf({ width: `${input.dimensions[0] / 72}in`, height: `${input.dimensions[1] / 72}in`,
      margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' }, printBackground: true, preferCSSPageSize: false, timeout: 20_000 }));
    if (pdf.length > 10 * 1024 * 1024) throw new PrintGoError('CONVERTED_DOCUMENT_TOO_LARGE', 'Rendered PDFs may contain at most 10 MiB.');
    if ((await PDFDocument.load(pdf)).getPageCount() > 100) throw new PrintGoError('MARKUP_TOO_LARGE', 'Rendered documents may contain at most 100 pages.');
    return pdf;
  };
  let pdf: Buffer;
  try { pdf = await Promise.race([render(), failure]); }
  finally {
    await browser?.close();
    process.send?.({ kind: 'browser-closed' });
  }
  await new Promise<void>((resolve, reject) => process.stdout.write(pdf, error => error ? reject(error) : resolve()));
}

void main().then(() => process.exit(0), error => {
  process.send?.({ kind: 'error', code: error instanceof PrintGoError ? error.code : 'MARKUP_RENDER_FAILED',
    message: error instanceof PrintGoError ? error.message : 'Chromium could not render this document. Check the browser installation and system dependencies.' }, () => process.exit(1));
  if (!process.connected) process.exit(1);
});
