import { serveStdio, StdioServerTransport, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import type { Readable, Writable } from 'node:stream';
import { createMcpServer, createPrinterService, type PrinterMcpServerOptions } from './mcp.js';
import { MAX_REQUEST_BYTES } from './printing.js';

export interface PrinterStdioServerOptions extends PrinterMcpServerOptions {
  /** Defaults to process.stdin. */
  stdin?: Readable;
  /** Defaults to process.stdout; reserve this stream for MCP messages. */
  stdout?: Writable;
  onerror?: (error: Error) => void;
}

/** Serve MCP over stdio. Close the handle on shutdown; stdin EOF closes it automatically. */
export function servePrinterStdio(options: PrinterStdioServerOptions = {}): StdioServerHandle {
  const service = createPrinterService(options);
  return serveStdio(() => createMcpServer(service), {
    transport: new StdioServerTransport(options.stdin, options.stdout, { maxBufferSize: MAX_REQUEST_BYTES }),
    onerror: options.onerror,
  });
}
