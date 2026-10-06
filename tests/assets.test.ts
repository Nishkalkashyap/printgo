import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { IncomingMessage, IncomingHttpHeaders } from 'node:http';
import type { RequestOptions } from 'node:https';
import { createAssetDownloader, isPublicAddress, MAX_ASSET_BYTES, openPinnedResponse } from '../src/assets.js';
import { pdfBytes } from './helpers.js';

const publicAddress = { address: '93.184.215.14', family: 4 };
function response(body: Buffer | Buffer[] = pdfBytes, statusCode = 200, headers: IncomingHttpHeaders = {}): IncomingMessage {
  return Object.assign(Readable.from(Array.isArray(body) ? body : [body]), { statusCode, headers }) as IncomingMessage;
}
const resolvePublic = async () => [publicAddress];

test('only public unicast addresses are accepted, including IPv6 restrictions', () => {
  for (const address of ['8.8.8.8', '93.184.215.14', '2606:4700:4700::1111']) assert.equal(isPublicAddress(address), true, address);
  for (const address of [
    '0.0.0.0', '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '100.100.100.200', '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '64:ff9b::a00:1',
    '2002:a00:1::', '2001::1', '2001:db8::1', '3fff::1', '4000::1', 'garbage',
  ]) assert.equal(isPublicAddress(address), false, address);
});

test('invalid schemes, credentials, ports, fragments and encoded local IPs never connect', async () => {
  const download = createAssetDownloader({ resolve: async () => { throw new Error('Should not resolve'); }, open: async () => { assert.fail('Should not connect'); } });
  for (const url of [
    'file:///etc/passwd', 'http://assets.example/invoice.pdf', 'data:application/pdf;base64,AAAA',
    'https://user:secret@assets.example/file.pdf', 'https://assets.example:8443/file.pdf', 'https://assets.example/file.pdf#page=1',
    'https://127.1/file.pdf', 'https://2130706433/file.pdf', 'https://0x7f000001/file.pdf', 'https://[::1]/file.pdf',
    'https://[::ffff:127.0.0.1]/file.pdf',
  ]) await assert.rejects(download(url), error => ['INVALID_ASSET_URL', 'UNSAFE_ASSET_URL'].includes((error as any).code), url);
});

test('DNS answers must all be public and match their address family', async () => {
  for (const addresses of [[], [{ address: '127.0.0.1', family: 4 }], [publicAddress, { address: '10.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 6 }]]) {
    const download = createAssetDownloader({ resolve: async () => addresses, open: async () => { assert.fail('Should not connect'); } });
    await assert.rejects(download('https://assets.example/file.pdf'), { code: 'UNSAFE_ASSET_URL' });
  }
});

test('downloads PDF bytes from extensionless signed URLs without depending on content-type', async () => {
  const download = createAssetDownloader({ resolve: resolvePublic, open: async (url, address) => {
    assert.equal(url.href, 'https://assets.example/download?signature=secret');
    assert.deepEqual(address, publicAddress);
    return response(pdfBytes, 200, { 'content-type': 'application/octet-stream' });
  } });
  assert.deepEqual((await download('https://assets.example/download?signature=secret')).bytes, pdfBytes);
});

test('HTTPS transport pins DNS while retaining the original hostname and verifies certificates', async () => {
  const url = new URL('https://assets.example/invoice.pdf?signature=secret');
  const signal = new AbortController().signal;
  let options: RequestOptions | undefined;
  const incoming = response();
  const request = ((actualURL: URL, actualOptions: RequestOptions, callback: (incoming: IncomingMessage) => void) => {
    assert.equal(actualURL, url);
    options = actualOptions;
    return Object.assign(new EventEmitter(), { end: () => callback(incoming) });
  }) as any;
  assert.equal(await openPinnedResponse(url, publicAddress, signal, request), incoming);
  assert.equal(options!.agent, false);
  assert.equal(options!.rejectUnauthorized, true);
  assert.equal(options!.signal, signal);
  assert.deepEqual(options!.headers, { Accept: '*/*', 'Accept-Encoding': 'identity' });
  options!.lookup!('assets.example', { all: false }, (error, address, family) => {
    assert.equal(error, null); assert.equal(address, publicAddress.address); assert.equal(family, 4);
  });
  options!.lookup!('assets.example', { all: true }, (error, addresses) => {
    assert.equal(error, null); assert.deepEqual(addresses, [publicAddress]);
  });
  incoming.destroy();
});

test('redirects are revalidated, including same-host DNS rebinding and private targets', async () => {
  let resolutions = 0;
  let connections = 0;
  const rebinding = createAssetDownloader({
    resolve: async () => ++resolutions === 1 ? [publicAddress] : [{ address: '127.0.0.1', family: 4 }],
    open: async () => { connections++; return response([], 302, { location: '/other.pdf' }); },
  });
  await assert.rejects(rebinding('https://assets.example/file.pdf'), { code: 'UNSAFE_ASSET_URL' });
  assert.equal(resolutions, 2);
  assert.equal(connections, 1);
  for (const location of ['https://169.254.169.254/metadata', 'http://assets.example/other.pdf', 'https://user:secret@assets.example/file.pdf']) {
    const download = createAssetDownloader({ resolve: resolvePublic, open: async () => response([], 302, { location }) });
    await assert.rejects(download('https://assets.example/file.pdf'));
  }
});

test('public relative redirects work but redirect loops are bounded', async () => {
  let connections = 0;
  const download = createAssetDownloader({ resolve: resolvePublic, open: async url => {
    connections++;
    return url.pathname === '/file.pdf' ? response([], 302, { location: '/download' }) : response();
  } });
  assert.deepEqual((await download('https://assets.example/file.pdf')).bytes, pdfBytes);
  assert.equal(connections, 2);
  connections = 0;
  const loop = createAssetDownloader({ resolve: resolvePublic, open: async () => {
    connections++; return response([], 302, { location: '/loop' });
  } });
  await assert.rejects(loop('https://assets.example/file.pdf'), { code: 'ASSET_DOWNLOAD_FAILED' });
  assert.equal(connections, 4);
});

test('rejects HTTP errors and compressed content without leaking signed URLs', async () => {
  for (const incoming of [
    response(pdfBytes, 200, { 'content-encoding': 'gzip' }),
    response(pdfBytes, 200, { 'content-length': 'invalid' }),
  ]) {
    const download = createAssetDownloader({ resolve: resolvePublic, open: async () => incoming });
    await assert.rejects(download('https://assets.example/file.pdf?signature=secret'), { code: 'INVALID_DOCUMENT' });
    assert.equal(incoming.destroyed, true);
  }
  for (const status of [204, 206, 401, 403, 404, 500]) {
    const download = createAssetDownloader({ resolve: resolvePublic, open: async () => response([], status) });
    await assert.rejects(download('https://assets.example/file.pdf?signature=secret'), { code: 'ASSET_DOWNLOAD_FAILED' });
  }
  const download = createAssetDownloader({ resolve: async () => { throw new Error('Request https://assets.example/?signature=secret failed'); } });
  await assert.rejects(download('https://assets.example/?signature=secret'), error => {
    assert.equal((error as any).code, 'ASSET_DOWNLOAD_FAILED');
    assert.doesNotMatch((error as Error).message, /secret|assets\.example/);
    return true;
  });
});

test('enforces 10 MiB by both declared length and actual stream size', async () => {
  const oversizedHeader = response(pdfBytes, 200, { 'content-length': String(MAX_ASSET_BYTES + 1) });
  const oversizedStream = response([pdfBytes, Buffer.alloc(MAX_ASSET_BYTES)], 200, { 'content-length': '10' });
  for (const incoming of [oversizedHeader, oversizedStream]) {
    const download = createAssetDownloader({ resolve: resolvePublic, open: async () => incoming });
    await assert.rejects(download('https://assets.example/file.pdf'), { code: 'INVALID_DOCUMENT' });
    assert.equal(incoming.destroyed, true);
  }
  const boundary = Buffer.alloc(MAX_ASSET_BYTES);
  pdfBytes.copy(boundary);
  const download = createAssetDownloader({ resolve: resolvePublic, open: async () => response(boundary) });
  assert.equal((await download('https://assets.example/file.pdf')).bytes.length, MAX_ASSET_BYTES);
});

test('downloads text and image bytes with MIME metadata for conversion', async () => {
  const bytes = Buffer.from('name,count\ninvoice,2\n');
  const download = createAssetDownloader({ resolve: resolvePublic, open: async () => response(bytes, 200, { 'content-type': 'Text/CSV; charset=utf-8' }) });
  assert.deepEqual(await download('https://assets.example/download'), { bytes, contentType: 'text/csv', finalUrl: 'https://assets.example/download' });
});

test('one deadline covers stalled DNS, connections and response streams', async () => {
  const stalled = Object.assign(new PassThrough(), { statusCode: 200, headers: {} }) as IncomingMessage;
  for (const dependencies of [
    { resolve: async () => new Promise<never>(() => {}) },
    { resolve: resolvePublic, open: async () => new Promise<never>(() => {}) },
    { resolve: resolvePublic, open: async () => stalled },
  ]) {
    const download = createAssetDownloader({ ...dependencies, timeoutMs: 15 });
    // Keep a referenced test timer: production download deadlines intentionally don't keep Node alive.
    await Promise.all([assert.rejects(download('https://assets.example/file.pdf'), { code: 'ASSET_DOWNLOAD_TIMEOUT' }), delay(30)]);
  }
  assert.equal(stalled.destroyed, true);
});

test('caller download bounds and abort signals are enforced for rendering assets', async () => {
  const download = createAssetDownloader({ resolve: resolvePublic, open: async () => response(Buffer.alloc(100)) });
  await assert.rejects(download('https://assets.example/style.css', { maxBytes: 10 }), { code: 'INVALID_DOCUMENT' });
  const controller = new AbortController();
  const stopped = new Error('Render stopped');
  controller.abort(stopped);
  await assert.rejects(download('https://assets.example/style.css', { signal: controller.signal }), error => error === stopped);
});
