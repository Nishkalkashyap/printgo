import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { preparePrintDocument, MAX_IMAGE_PIXELS, MAX_TEXT_CHARACTERS } from '../src/documents.js';
import { pdfBytes, pngBytes } from './helpers.js';

function chunk(type: string, data: Buffer): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 'ascii');
  data.copy(result, 8);
  // Conversion preflight does not rely on CRC; fixtures exercise bounded inflation.
  return result;
}

function customPng(compressed = deflateSync(Buffer.from([0, 0, 0, 0, 255])), width = 1, height = 1, extra: Buffer[] = []): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([pngBytes.subarray(0, 8), chunk('IHDR', header), ...extra, chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

async function pageCommands(pdf: Buffer): Promise<string> {
  const doc = await PDFDocument.load(pdf);
  const contents = doc.getPage(0).node.Contents()!;
  const streams = contents instanceof PDFRawStream ? [contents] : Array.from({ length: (contents as any).size() }, (_, i) => (contents as any).lookup(i));
  return streams.map(stream => Buffer.from(decodePDFRawStream(stream).decode()).toString()).join('\n');
}

test('PDFs pass through byte-for-byte without altering their layout', async () => {
  assert.equal(await preparePrintDocument(pdfBytes, 'https://assets.example/download', { paperSize: 'driver-specific' }), pdfBytes);
});

test('PNG and transparent PNG become a centered, single-page PDF', async () => {
  for (const bytes of [pngBytes, customPng()]) {
    const pdf = await preparePrintDocument(bytes, 'https://assets.example/download');
    const doc = await PDFDocument.load(pdf);
    assert.equal(doc.getPageCount(), 1);
    assert.deepEqual(doc.getPage(0).getSize(), { width: 595.28, height: 841.89 });
    assert.ok(doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject')));
    assert.match(await pageCommands(pdf), / Do/);
  }
  const landscape = await PDFDocument.load(await preparePrintDocument(pngBytes, 'https://assets.example/image.png', { paperSize: 'Letter', orientation: 'landscape' }));
  assert.deepEqual(landscape.getPage(0).getSize(), { width: 792, height: 612 });
});

test('JPEGs are embedded and EXIF rotations are honored', async () => {
  const jpeg = await readFile(new URL('./fixtures/pixel.jpg', import.meta.url));
  const plain = await preparePrintDocument(jpeg, 'https://assets.example/download');
  assert.equal((await PDFDocument.load(plain)).getPageCount(), 1);
  const exif = Buffer.alloc(32);
  exif.write('Exif\0\0'); exif.write('II', 6); exif.writeUInt16LE(42, 8); exif.writeUInt32LE(8, 10);
  exif.writeUInt16LE(1, 14); exif.writeUInt16LE(0x112, 16); exif.writeUInt16LE(3, 18); exif.writeUInt32LE(1, 20); exif.writeUInt16LE(6, 24);
  const marker = Buffer.alloc(4); marker[0] = 0xff; marker[1] = 0xe1; marker.writeUInt16BE(exif.length + 2, 2);
  const rotated = Buffer.concat([jpeg.subarray(0, 2), marker, exif, jpeg.subarray(2)]);
  const commands = await pageCommands(await preparePrintDocument(rotated, 'https://assets.example/photo.jpg'));
  assert.match(commands, /0 -1 1 0/);
});

test('UTF-8 text wraps, paginates and embeds a font for Latin, Greek and Cyrillic', async () => {
  const content = 'Café — Ελληνικά — Привет\r\n' + 'W'.repeat(300) + '\n' + 'line\tvalue\n'.repeat(120);
  const pdf = await preparePrintDocument({ bytes: Buffer.from(content), contentType: 'text/plain' }, 'https://assets.example/download', { paperSize: 'Letter' });
  const doc = await PDFDocument.load(pdf);
  assert.ok(doc.getPageCount() >= 3);
  for (const page of doc.getPages()) {
    assert.deepEqual(page.getSize(), { width: 612, height: 792 });
    assert.ok(page.node.Resources()!.lookup(PDFName.of('Font')));
  }
  assert.match(await pageCommands(pdf), / Tj/);
});

test('CSV, JSON, Markdown, logs and explicit extensionless text print as source', async () => {
  for (const extension of ['csv', 'json', 'md', 'log', 'txt', 'yaml', 'xml']) {
    const pdf = await preparePrintDocument(Buffer.from('plain source\nsecond line'), `https://assets.example/file.${extension}`);
    assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1);
  }
  const pdf = await preparePrintDocument(Buffer.from('plain text'), 'https://assets.example/download', {}, 'text');
  assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1);
});

test('binary, invalid UTF-8 and unsupported glyphs fail instead of printing garbage', async () => {
  await assert.rejects(preparePrintDocument(Buffer.from([0xc0, 0x80]), 'https://assets.example/file.txt'), { code: 'INVALID_DOCUMENT' });
  await assert.rejects(preparePrintDocument(Buffer.from('binary\0data'), 'https://assets.example/file.txt'), { code: 'INVALID_DOCUMENT' });
  await assert.rejects(preparePrintDocument(Buffer.from('emoji 😀'), 'https://assets.example/file.txt'), { code: 'UNSUPPORTED_TEXT_CHARACTER' });
  await assert.rejects(preparePrintDocument(Buffer.from('PK\x03\x04office zip'), 'https://assets.example/file.docx'), { code: 'UNSUPPORTED_ASSET_TYPE' });
  await assert.rejects(preparePrintDocument(Buffer.from('GIF89a'), 'https://assets.example/file.gif'), { code: 'UNSUPPORTED_ASSET_TYPE' });
  await assert.rejects(preparePrintDocument({ bytes: Buffer.from('<html>login</html>'), contentType: 'text/html' }, 'https://assets.example/file.txt'), { code: 'UNSUPPORTED_ASSET_TYPE' });
  await assert.rejects(preparePrintDocument(pngBytes, 'https://assets.example/file', {}, 'pdf'), { code: 'INVALID_DOCUMENT' });
  await assert.rejects(preparePrintDocument(pdfBytes, 'https://assets.example/file', {}, 'text'), { code: 'INVALID_DOCUMENT' });
});

test('image preflight rejects excessive pixels, animation, truncation and inflation bombs', async () => {
  await assert.rejects(preparePrintDocument(customPng(undefined, MAX_IMAGE_PIXELS + 1), 'https://assets.example/file.png'), { code: 'IMAGE_TOO_LARGE' });
  await assert.rejects(preparePrintDocument(customPng(undefined, 1, 1, [chunk('acTL', Buffer.alloc(8))]), 'https://assets.example/file.png'), { code: 'UNSUPPORTED_ASSET_TYPE' });
  await assert.rejects(preparePrintDocument(pngBytes.subarray(0, 30), 'https://assets.example/file.png'), { code: 'INVALID_DOCUMENT' });
  await assert.rejects(preparePrintDocument(customPng(deflateSync(Buffer.alloc(1024 * 1024))), 'https://assets.example/file.png'), { code: 'INVALID_DOCUMENT' });
  await assert.rejects(preparePrintDocument(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'https://assets.example/file.jpg'), { code: 'INVALID_DOCUMENT' });
});

test('text/page limits and unsupported converted paper sizes fail before submission', async () => {
  await assert.rejects(preparePrintDocument(Buffer.alloc(MAX_TEXT_CHARACTERS + 1, 'a'), 'https://assets.example/file.txt'), { code: 'TEXT_TOO_LARGE' });
  await assert.rejects(preparePrintDocument(Buffer.from('\n'.repeat(10000)), 'https://assets.example/file.txt'), { code: 'TEXT_TOO_LARGE' });
  await assert.rejects(preparePrintDocument(pngBytes, 'https://assets.example/file.png', { paperSize: 'custom' }), { code: 'UNSUPPORTED_PAPER_SIZE' });
  const hugeImage = customPng(deflateSync(Buffer.alloc(1000 * 1000 * 4 + 1000)), 1000, 1000);
  await assert.rejects(preparePrintDocument(hugeImage, 'https://assets.example/file.png', { paperSize: 'A5', fitToPage: false }), { code: 'INVALID_PRINT_LAYOUT' });
});
