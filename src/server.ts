import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createMcpHandler, isLegacyRequest, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { MAX_REQUEST_BYTES } from './printing.js';
import { PrintGoError } from './errors.js';
import { createMcpServer, createPrinterService, type PrinterMcpServerOptions } from './mcp.js';

export function secretMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  return timingSafeEqual(createHash('sha256').update(actual).digest(), createHash('sha256').update(expected).digest());
}

export interface PrinterHttpServerOptions extends PrinterMcpServerOptions {
  password: string;
  publicURL?: string;
  /** Separate local lifecycle credential. Never give it to remote MCP clients. */
  adminToken?: string;
  getStatus?: () => unknown;
  onStop?: () => void;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

/** Authenticated HTTP transport for the printer tools. */
export function createPrinterHttpServer(options: PrinterHttpServerOptions) {
  if (options.password.length < 32) throw new PrintGoError('WEAK_TOKEN', 'Use an authentication secret of at least 32 characters.');
  const service = createPrinterService(options);
  let publicURL = options.publicURL;
  const factory = () => createMcpServer(service);
  const modern = createMcpHandler(factory, { legacy: 'reject', responseMode: 'json', maxSubscriptions: 0, maxRequestBodySize: MAX_REQUEST_BYTES });
  const handleMcp = toNodeHandler({ fetch: async (request, requestOptions) => {
    if (!await isLegacyRequest(request, requestOptions?.parsedBody, { maxRequestBodySize: MAX_REQUEST_BYTES })) return modern.fetch(request, requestOptions);
    // Quick Tunnels require JSON responses, including for 2025 MCP clients.
    const mcp = factory();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_REQUEST_BYTES });
    await mcp.connect(transport);
    try { return await transport.handleRequest(request, requestOptions); }
    finally { await mcp.close(); }
  } }, { maxRequestBodySize: MAX_REQUEST_BYTES });
  let inFlight = 0;
  let windowStarted = Date.now();
  let requestCount = 0;
  async function handler(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const hosts = ['localhost', '127.0.0.1'];
    if (publicURL) hosts.push(new URL(publicURL).hostname);
    if (!hostHeaderValidation(hosts)(request, response) || !originValidation(hosts)(request, response)) return;
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    if (request.url === '/internal/status' || request.url === '/internal/stop') {
      if (!options.adminToken || !secretMatches(bearer, options.adminToken)) {
        return json(response, 401, { error: 'Unauthorized' });
      }
      if (request.url === '/internal/status' && request.method === 'GET') {
        return json(response, 200, options.getStatus?.() ?? { status: 'running' });
      }
      if (request.url === '/internal/stop' && request.method === 'POST' && options.onStop) {
        json(response, 200, { status: 'stopping' });
        setImmediate(options.onStop);
        return;
      }
      return json(response, 405, { error: 'Method not allowed' });
    }
    if (!secretMatches(bearer, options.password)) {
      response.setHeader('WWW-Authenticate', 'Bearer realm="printgo"');
      return json(response, 401, { error: 'Use Authorization: Bearer <password>.' });
    }
    if (request.url === '/health' && request.method === 'GET') return json(response, 200, { status: 'ok' });
    if (request.url !== '/mcp') return json(response, 404, { error: 'Not found' });
    if (request.method !== 'POST') return json(response, 405, { error: 'Use Streamable HTTP POST requests. SSE is disabled.' });
    if (Date.now() - windowStarted > 60_000) { windowStarted = Date.now(); requestCount = 0; }
    if (++requestCount > 120 || inFlight >= 8) {
      response.setHeader('Retry-After', '5');
      return json(response, 429, { error: 'Too many requests' });
    }
    inFlight++;
    try {
      // Drain oversized bodies so the socket stays open long enough to send 413.
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size <= MAX_REQUEST_BYTES) chunks.push(Buffer.from(chunk));
        else chunks.length = 0;
      }
      if (size > MAX_REQUEST_BYTES) {
        return json(response, 413, { error: 'Request exceeds the 64 KiB JSON limit. Supply the file as an assetUrl.' });
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return json(response, 400, { error: 'Invalid JSON' }); }
      await handleMcp(request, response, body);
    }
    finally { inFlight--; }
  }
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => {
      if (!response.headersSent) json(response, 500, { error: 'Request failed' });
      else response.destroy();
    });
  });
  server.requestTimeout = 90_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return {
    server,
    service,
    setPublicURL(url: string) { publicURL = url; },
    async listen(port = 0): Promise<string> {
      await service.prepareRuntime();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No HTTP listen address');
      return `http://127.0.0.1:${address.port}`;
    },
    async close(): Promise<void> {
      await modern.close();
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
    },
  };
}
