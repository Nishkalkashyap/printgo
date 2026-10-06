import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { defaultPrinterAdapter } from './printers.js';
import { PrinterService, printerIdSchema, printRequestSchema, markupPrintRequestSchema } from './printing.js';
import { PrintGoError, messageOf } from './errors.js';
import { stateDirectory } from './storage.js';
import type { PrinterAdapter } from './types.js';
import type { AssetDownloader } from './assets.js';

/** Shared printer options for stdio and HTTP. */
export interface PrinterMcpServerOptions {
  stateDir?: string;
  adapter?: PrinterAdapter;
  /** Custom downloaders must enforce their own URL, size, and timeout checks. */
  assetDownloader?: AssetDownloader;
  sumatraPdfPath?: string;
  browserExecutablePath?: string;
}

export function createPrinterService(options: PrinterMcpServerOptions): PrinterService {
  return new PrinterService(options.adapter ?? defaultPrinterAdapter(options.sumatraPdfPath), stateDirectory(options.stateDir), options.assetDownloader,
    { browserExecutablePath: options.browserExecutablePath });
}

/** Create an unconnected MCP server. The caller owns its transport and must close it. */
export function createPrinterMcpServer(options: PrinterMcpServerOptions = {}): McpServer {
  return createMcpServer(createPrinterService(options));
}

// HTTP requests share one service so job submission and idempotency remain serialized.
export function createMcpServer(service: PrinterService): McpServer {
  const mcp = new McpServer({ name: 'printgo-mcp', version: '0.1.0' }, {
    supportedProtocolVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
  });
  const safe = async (work: () => Promise<unknown>) => {
    try {
      const value = await work();
      return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
    } catch (error) {
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({
        code: error instanceof PrintGoError ? error.code : 'PRINTER_ERROR', message: messageOf(error),
      }) }] };
    }
  };
  const printerInput = z.object({ printerId: printerIdSchema }).strict();
  const jobInput = z.object({ jobId: z.uuid() }).strict();
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  mcp.registerTool('listPrinters', { description: 'List printers configured on this computer.', inputSchema: z.object({}).strict(), annotations: readOnly },
    async () => safe(async () => ({ printers: await service.adapter.listPrinters() })));
  mcp.registerTool('getPrinterCapabilities', { description: 'Read the options reported by the printer driver.', inputSchema: printerInput, annotations: readOnly },
    async ({ printerId }) => safe(async () => {
      await service.requirePrinter(printerId);
      return service.adapter.getPrinterCapabilities(printerId);
    }));
  mcp.registerTool('checkPrinterStatus', { description: 'Read printer queue status.', inputSchema: printerInput, annotations: readOnly },
    async ({ printerId }) => safe(async () => {
      await service.requirePrinter(printerId);
      return service.adapter.checkPrinterStatus(printerId);
    }));
  mcp.registerTool('sendPrintCommand', {
    description: 'Print PDF, PNG, JPEG or UTF-8 text from a public HTTPS URL (10 MiB max). Reuse the same arguments and idempotencyKey for retries. Submission does not confirm physical printing.',
    inputSchema: printRequestSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async input => safe(() => service.sendPrintCommand(input)));
  mcp.registerTool('printMarkup', {
    description: 'Render and print Markdown or HTML. Supply content (32 KiB max) or assetUrl (1 MiB max). Reuse the same arguments and idempotencyKey for retries.',
    inputSchema: markupPrintRequestSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async input => safe(() => service.printMarkup(input)));
  mcp.registerTool('getPrintJobStatus', { description: 'Read queue status for a job created by this server. Completion does not confirm physical printing.', inputSchema: jobInput, annotations: readOnly },
    async ({ jobId }) => safe(() => service.getPrintJobStatus(jobId)));
  mcp.registerTool('cancelPrintJob', { description: 'Cancel a job created by this server. Already printed pages cannot be recalled.', inputSchema: jobInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } },
    async ({ jobId }) => safe(() => service.cancelPrintJob(jobId)));
  return mcp;
}
