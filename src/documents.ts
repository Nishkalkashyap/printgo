import { extname } from 'node:path';
import { inflateSync } from 'node:zlib';
import { PDFDocument, PageSizes, concatTransformationMatrix, pushGraphicsState, popGraphicsState } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { fontBytes } from './fonts/font.js';
import { MAX_ASSET_BYTES, type DownloadedAsset } from './assets.js';
import { PrintGoError } from './errors.js';
import type { AssetType, PrintSettings } from './types.js';

export const MAX_IMAGE_PIXELS = 16_000_000;
export const MAX_TEXT_CHARACTERS = 100_000;
export const MAX_TEXT_PAGES = 100;
export const MAX_PRINT_PDF_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const TEXT_EXTENSIONS = new Set(['.txt', '.text', '.log', '.csv', '.json', '.md', '.markdown', '.yaml', '.yml', '.xml', '.js', '.ts', '.py', '.css']);
const TEXT_TYPES = new Set(['text/plain', 'text/csv', 'text/markdown', 'text/x-markdown', 'application/json', 'application/xml', 'text/xml', 'application/yaml', 'text/yaml', 'application/javascript', 'text/javascript']);

function invalid(message = 'The asset is malformed or does not match its requested type.'): never {
  throw new PrintGoError('INVALID_DOCUMENT', message);
}

function detectType(asset: DownloadedAsset, url: string, requested: AssetType): Exclude<AssetType, 'auto'> {
  const { bytes } = asset;
  let detected: 'pdf' | 'png' | 'jpeg' | undefined;
  if (bytes.subarray(0, 5).toString() === '%PDF-') detected = 'pdf';
  else if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) detected = 'png';
  else if (bytes[0] === 0xff && bytes[1] === 0xd8) detected = 'jpeg';
  if (requested !== 'auto') {
    if (requested !== 'text' && detected !== requested) invalid();
    if (requested === 'text' && detected) invalid('A binary PDF or image cannot be printed as text.');
    return requested;
  }
  if (detected) return detected;
  if (asset.contentType === 'text/html') {
    throw new PrintGoError('UNSUPPORTED_ASSET_TYPE', 'HTML pages are not rendered. Use a direct asset download URL, or assetType text to print HTML source.');
  }
  const extension = extname(new URL(url).pathname).toLowerCase();
  if (['.pdf', '.png', '.jpg', '.jpeg'].includes(extension)) invalid();
  if (TEXT_TYPES.has(asset.contentType ?? '') || TEXT_EXTENSIONS.has(extension)) return 'text';
  throw new PrintGoError('UNSUPPORTED_ASSET_TYPE', 'Supported assets are PDF, PNG, JPEG and UTF-8 text. For extensionless text, set assetType to text. Convert other formats to PDF first.');
}

function checkDimensions(width: number, height: number): void {
  if (!width || !height || width > 16384 || height > 16384 || width * height > MAX_IMAGE_PIXELS) {
    throw new PrintGoError('IMAGE_TOO_LARGE', 'Images must be at most 16 megapixels and 16,384 pixels per dimension.');
  }
}

/** Bound inflation and discard ancillary metadata before handing a PNG to the decoder. */
function preparePng(bytes: Buffer): Buffer {
  if (bytes.length < 33 || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') invalid();
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  checkDimensions(width, height);
  const depth = bytes[24]!, color = bytes[25]!, interlace = bytes[28]!;
  const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  if (!depths[color]?.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || interlace > 1) invalid();
  const chunks = [bytes.subarray(0, 8)];
  const compressed: Buffer[] = [];
  let offset = 8, paletteSize = 0, ended = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) invalid();
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) invalid();
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) {
      throw new PrintGoError('UNSUPPORTED_ASSET_TYPE', 'Animated PNG files are unsupported. Provide a static PNG, JPEG or PDF.');
    }
    if (type === 'IHDR' && offset !== 8) invalid();
    if (type === 'PLTE') {
      if (!length || length > 768 || length % 3) invalid();
      paletteSize = length / 3;
    }
    if (type === 'tRNS' && !((color === 0 && length === 2) || (color === 2 && length === 6) || (color === 3 && paletteSize && length <= paletteSize))) invalid();
    if (type === 'IDAT') compressed.push(bytes.subarray(offset + 8, end - 4));
    if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type)) chunks.push(bytes.subarray(offset, end));
    else if (/^[A-Z]/.test(type)) invalid('The PNG uses an unsupported critical chunk.');
    offset = end;
    if (type === 'IEND') {
      if (length !== 0 || offset !== bytes.length) invalid();
      ended = true;
      break;
    }
  }
  if (!ended || !compressed.length || (color === 3 && !paletteSize)) invalid();
  const rowBytes = (w: number) => Math.ceil(w * channels[color]! * depth / 8) + 1;
  let expected = rowBytes(width) * height;
  if (interlace) {
    expected = 0;
    const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;
    for (const [x, y, dx, dy] of passes) {
      const w = Math.max(0, Math.ceil((width - x) / dx)), h = Math.max(0, Math.ceil((height - y) / dy));
      if (w && h) expected += rowBytes(w) * h;
    }
  }
  if (inflateSync(Buffer.concat(compressed), { maxOutputLength: expected }).length !== expected) invalid();
  return Buffer.concat(chunks);
}

function exifOrientation(segment: Buffer): number {
  if (segment.length < 14 || segment.subarray(0, 6).toString() !== 'Exif\0\0') return 1;
  const tiff = segment.subarray(6);
  const order = tiff.subarray(0, 2).toString();
  if (!['II', 'MM'].includes(order)) return 1;
  const u16 = (at: number) => order === 'II' ? tiff.readUInt16LE(at) : tiff.readUInt16BE(at);
  const u32 = (at: number) => order === 'II' ? tiff.readUInt32LE(at) : tiff.readUInt32BE(at);
  try {
    if (u16(2) !== 42) return 1;
    const start = u32(4), count = u16(start);
    for (let i = 0; i < count; i++) {
      const at = start + 2 + i * 12;
      if (at + 12 > tiff.length) return 1;
      if (u16(at) === 0x112 && u16(at + 2) === 3 && u32(at + 4) === 1) {
        const value = u16(at + 8);
        return value >= 1 && value <= 8 ? value : 1;
      }
    }
  } catch { /* Ignore malformed optional orientation metadata. */ }
  return 1;
}

function inspectJpeg(bytes: Buffer): number {
  const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2, found = false, foundScan = false, orientation = 1;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) invalid();
    const marker = bytes[offset + 1]!;
    if (marker === 0xda) {
      const scanLength = bytes.readUInt16BE(offset + 2);
      if (scanLength < 6 || offset + 2 + scanLength > bytes.length) invalid();
      foundScan = bytes.indexOf(Buffer.from([0xff, 0xd9]), offset + 2 + scanLength) !== -1;
      break;
    }
    if (marker === 0xd9) break;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) invalid();
    if (marker === 0xe1) orientation = exifOrientation(bytes.subarray(offset + 4, offset + 2 + length));
    if (frames.has(marker)) {
      if (length < 8 || bytes[offset + 4] !== 8 || ![1, 3, 4].includes(bytes[offset + 9]!) || length < 8 + 3 * bytes[offset + 9]!) invalid();
      checkDimensions(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5));
      found = true;
    }
    offset += length + 2;
  }
  if (!found || !foundScan) invalid();
  return orientation;
}

export function pageSize(settings: PrintSettings): [number, number] {
  const name = settings.paperSize ?? 'A4';
  const key = Object.keys(PageSizes).find(key => key.toLowerCase() === name.toLowerCase());
  if (!key) throw new PrintGoError('UNSUPPORTED_PAPER_SIZE', 'Converted images and text need a standard paper size such as A4, A3, A5, Letter, Legal or Tabloid. Omit paperSize for A4. PDFs can use driver-specific sizes.');
  const [width, height] = PageSizes[key as keyof typeof PageSizes];
  return settings.orientation === 'landscape' ? [height, width] : [width, height];
}

async function imagePdf(bytes: Buffer, type: 'png' | 'jpeg', settings: PrintSettings): Promise<Buffer> {
  const orientation = type === 'jpeg' ? inspectJpeg(bytes) : 1;
  const data = type === 'png' ? preparePng(bytes) : bytes;
  const doc = await PDFDocument.create();
  // Some decoders inspect the entire ArrayBuffer; never pass a pooled Buffer view.
  const image = type === 'png' ? await doc.embedPng(Uint8Array.from(data)) : await doc.embedJpg(Uint8Array.from(data));
  const page = doc.addPage(pageSize(settings));
  const rotated = orientation >= 5;
  const displayWidth = rotated ? image.height : image.width, displayHeight = rotated ? image.width : image.height;
  const availableWidth = page.getWidth() - 72, availableHeight = page.getHeight() - 72;
  const scale = settings.fitToPage === false ? 72 / 96 : Math.min(availableWidth / displayWidth, availableHeight / displayHeight);
  if (displayWidth * scale > availableWidth + 0.01 || displayHeight * scale > availableHeight + 0.01) {
    throw new PrintGoError('INVALID_PRINT_LAYOUT', 'The image at 96 DPI does not fit the page. Use fitToPage true or a larger paper size.');
  }
  const w = image.width * scale, h = image.height * scale;
  const transforms = [
    [1, 0, 0, 1, 0, 0], [-1, 0, 0, 1, w, 0], [-1, 0, 0, -1, w, h], [1, 0, 0, -1, 0, h],
    [0, -1, -1, 0, h, w], [0, -1, 1, 0, 0, w], [0, 1, 1, 0, 0, 0], [0, 1, -1, 0, h, 0],
  ] as const;
  const [a, b, c, d, tx, ty] = transforms[orientation - 1]!;
  const x = (page.getWidth() - displayWidth * scale) / 2, y = (page.getHeight() - displayHeight * scale) / 2;
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(a, b, c, d, x + tx, y + ty));
  page.drawImage(image, { x: 0, y: 0, width: w, height: h });
  page.pushOperators(popGraphicsState());
  return Buffer.from(await doc.save());
}

async function textPdf(bytes: Buffer, settings: PrintSettings): Promise<Buffer> {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { invalid('Text assets must be valid UTF-8.'); }
  if (text.length > MAX_TEXT_CHARACTERS) throw new PrintGoError('TEXT_TOO_LARGE', 'Text assets are limited to 100,000 UTF-16 code units and 100 rendered pages.');
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(text.replace(/\r/g, ''))) invalid('Text assets must not contain binary/control characters.');
  text = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes);
  const characters = new Set(font.getCharacterSet());
  for (const char of text) {
    if (char !== '\n' && !characters.has(char.codePointAt(0)!)) {
      throw new PrintGoError('UNSUPPORTED_TEXT_CHARACTER', 'The bundled font supports Latin, Greek and Cyrillic. Convert text using other scripts or emoji to PDF first.');
    }
  }
  const size = 10, lineHeight = 14, margin = 36;
  const dimensions = pageSize(settings);
  const maxWidth = dimensions[0] - margin * 2;
  const linesPerPage = Math.floor((dimensions[1] - margin * 2) / lineHeight);
  let page = doc.addPage(dimensions), lineNumber = 0;
  const drawLine = (line: string) => {
    if (lineNumber === linesPerPage) {
      if (doc.getPageCount() >= MAX_TEXT_PAGES) throw new PrintGoError('TEXT_TOO_LARGE', 'Text assets may render at most 100 pages.');
      page = doc.addPage(dimensions); lineNumber = 0;
    }
    page.drawText(line, { x: margin, y: dimensions[1] - margin - size - lineNumber * lineHeight, size, font });
    lineNumber++;
  };
  const widths = new Map<string, number>();
  for (const sourceLine of text.split('\n')) {
    let line = '', width = 0;
    for (const char of sourceLine) {
      let charWidth = widths.get(char);
      if (charWidth === undefined) { charWidth = font.widthOfTextAtSize(char, size); widths.set(char, charWidth); }
      if (line && width + charWidth > maxWidth) { drawLine(line); line = ''; width = 0; }
      line += char; width += charWidth;
    }
    drawLine(line);
  }
  return Buffer.from(await doc.save());
}

/** Normalize assets to PDF before recording any physical submission intent. */
export async function preparePrintDocument(input: Buffer | DownloadedAsset, url: string, settings: PrintSettings = {}, requested: AssetType = 'auto'): Promise<Buffer> {
  const asset = Buffer.isBuffer(input) ? { bytes: input } : input;
  if (!asset.bytes.length || asset.bytes.length > MAX_ASSET_BYTES) invalid('Provide an asset of 1 byte to 10 MiB.');
  const type = detectType(asset, url, requested);
  if (type === 'pdf') return asset.bytes;
  try {
    const pdf = type === 'text' ? await textPdf(asset.bytes, settings) : await imagePdf(asset.bytes, type, settings);
    if (pdf.length > MAX_PRINT_PDF_BYTES) throw new PrintGoError('CONVERTED_DOCUMENT_TOO_LARGE', 'The converted PDF exceeds 10 MiB. Reduce the image size or split the text.');
    return pdf;
  } catch (error) {
    if (error instanceof PrintGoError) throw error;
    invalid('The image or text asset could not be converted into a printable PDF.');
  }
}
