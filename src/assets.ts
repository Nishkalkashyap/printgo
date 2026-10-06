import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import type { IncomingMessage } from 'node:http';
import ipaddr from 'ipaddr.js';
import { z } from 'zod';
import { PrintGoError } from './errors.js';

export const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
export interface DownloadedAsset { bytes: Buffer; contentType?: string; finalUrl?: string }
export interface AssetDownloadOptions { signal?: AbortSignal; maxBytes?: number }
export type AssetDownloader = (assetUrl: string, options?: AssetDownloadOptions) => Promise<Buffer | DownloadedAsset>;

export function isPublicAddress(address: string): boolean {
  if (!isIP(address)) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.range() !== 'unicast') return false;
  // Restrict IPv6 to global unicast, excluding translation/transition ranges.
  return parsed.kind() === 'ipv4' || parsed.match(ipaddr.parse('2000::'), 3);
}

function parseAssetUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new PrintGoError('INVALID_ASSET_URL', 'Provide an absolute public HTTPS asset URL.'); }
  if (value.length > 8192 || url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    throw new PrintGoError('INVALID_ASSET_URL', 'Asset URLs must use HTTPS on port 443, without credentials or fragments.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname) && !isPublicAddress(hostname)) {
    throw new PrintGoError('UNSAFE_ASSET_URL', 'Asset URLs must resolve exclusively to public Internet addresses.');
  }
  return url;
}

export const assetUrlSchema = z.string().min(1).max(8192).superRefine((value, context) => {
  try { parseAssetUrl(value); }
  catch (error) { context.addIssue({ code: 'custom', message: (error as Error).message }); }
});

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => undefined); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/** Connect to the validated address while retaining the URL host for TLS and HTTP. */
export function openPinnedResponse(url: URL, address: LookupAddress, signal: AbortSignal, request = httpsRequest): Promise<IncomingMessage> {
  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'GET', agent: false, lookup, signal, rejectUnauthorized: true,
      headers: { Accept: '*/*', 'Accept-Encoding': 'identity' },
    }, resolve);
    req.on('error', reject);
    req.end();
  });
}

// Internal dependency hooks; CLI and daemon use the secure defaults.
export function createAssetDownloader(dependencies: {
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
  open?: typeof openPinnedResponse;
  timeoutMs?: number;
} = {}): (assetUrl: string, options?: AssetDownloadOptions) => Promise<DownloadedAsset> {
  const resolve = dependencies.resolve ?? (hostname => dnsLookup(hostname, { all: true, verbatim: true }));
  const open = dependencies.open ?? openPinnedResponse;
  return async (assetUrl, options = {}) => {
    const controller = new AbortController();
    const signal = controller.signal;
    const maxBytes = Math.min(options.maxBytes ?? MAX_ASSET_BYTES, MAX_ASSET_BYTES);
    const abort = () => controller.abort(options.signal!.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new PrintGoError('ASSET_DOWNLOAD_TIMEOUT', 'Asset download exceeded its time limit.')), dependencies.timeoutMs ?? DOWNLOAD_TIMEOUT_MS);
    timer.unref();
    try {
      let url = parseAssetUrl(assetUrl);
      for (let redirects = 0; ; redirects++) {
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const family = isIP(hostname);
        const addresses = family ? [{ address: hostname, family }] : await abortable(resolve(hostname), signal);
        if (!addresses.length || addresses.some(address => !isPublicAddress(address.address) || isIP(address.address) !== address.family)) {
          throw new PrintGoError('UNSAFE_ASSET_URL', 'Asset URLs must resolve exclusively to public Internet addresses.');
        }
        const response = await abortable(open(url, addresses[0]!, signal), signal);
        try {
          if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
            if (redirects >= MAX_REDIRECTS || !response.headers.location) {
              throw new PrintGoError('ASSET_DOWNLOAD_FAILED', 'Asset URL exceeded the redirect limit or returned an invalid redirect.');
            }
            // Revalidate and resolve every redirect, even when the hostname is unchanged.
            url = parseAssetUrl(new URL(response.headers.location, url).href);
            continue;
          }
          if (response.statusCode !== 200) {
            throw new PrintGoError('ASSET_DOWNLOAD_FAILED', `Asset URL returned HTTP ${response.statusCode ?? 'unknown'}; use a direct public or signed file download URL.`);
          }
          if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
            throw new PrintGoError('INVALID_DOCUMENT', 'Compressed HTTP responses are unsupported; provide a direct file download URL.');
          }
          const length = response.headers['content-length'];
          if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
            throw new PrintGoError('INVALID_DOCUMENT', 'The asset exceeds the download size limit.');
          }
          const chunks: Buffer[] = [];
          let size = 0;
          const iterator = response[Symbol.asyncIterator]();
          for (;;) {
            const chunk = await abortable(iterator.next(), signal);
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > maxBytes) throw new PrintGoError('INVALID_DOCUMENT', 'The asset exceeds the download size limit.');
            chunks.push(Buffer.from(chunk.value));
          }
          return { bytes: Buffer.concat(chunks, size), contentType: response.headers['content-type']?.split(';')[0]?.trim().toLowerCase(), finalUrl: url.href };
        } finally { response.destroy(); }
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof PrintGoError) throw error;
      // Do not echo URLs or transport errors, which can disclose signed URL credentials.
      throw new PrintGoError('ASSET_DOWNLOAD_FAILED', 'Could not download the asset. Check that its public or signed HTTPS URL is reachable from the daemon.');
    } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
  };
}

export const downloadAsset = createAssetDownloader();
