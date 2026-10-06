import { Client, StreamableHTTPClientTransport, type Transport } from '@modelcontextprotocol/client';
import { PrintGoError } from './errors.js';
import { version } from './version.js';
import { printRequestSchema, markupPrintRequestSchema } from './printing.js';
import type { Printer, PrinterCapabilities, PrinterStatus, PrintJob, PrintRequest, MarkupPrintRequest } from './types.js';

export interface PrinterHttpClientOptions {
  transport?: never;
  mcpConnectionURL: string;
  password: string;
}

export type PrinterClientOptions = PrinterHttpClientOptions | {
  /** An unstarted MCP transport, e.g. StdioClientTransport. close() closes this transport. */
  transport: Transport;
  mcpConnectionURL?: never;
  password?: never;
};

export class PrinterClient {
  private constructor(private readonly client: Client) {}

  static async connect(options: PrinterClientOptions): Promise<PrinterClient> {
    let transport: Transport;
    if (options.transport) {
      transport = options.transport;
    } else {
      const url = new URL(options.mcpConnectionURL);
      if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
        throw new PrintGoError('INVALID_URL', 'Use an HTTPS MCP URL, or HTTP on loopback for local development.');
      }
      transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: { Authorization: `Bearer ${options.password}` }, redirect: 'error' },
      });
    }
    const client = new Client({ name: 'printgo-sdk', version }, {
      versionNegotiation: { mode: 'auto' },
    });
    try { await client.connect(transport); }
    catch (error) { await client.close(); throw error; }
    return new PrinterClient(client);
  }

  private async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
    const result = await this.client.callTool({ name, arguments: args });
    const text = result.content?.find(item => item.type === 'text');
    if (result.isError) {
      if (text?.type === 'text') {
        let failure: { code?: string; message?: string };
        try { failure = JSON.parse(text.text); } catch { failure = { message: text.text }; }
        throw new PrintGoError(failure.code ?? 'TOOL_ERROR', failure.message ?? 'Printer tool failed.');
      }
      throw new PrintGoError('TOOL_ERROR', 'Printer tool failed.');
    }
    if (result.structuredContent) return result.structuredContent as T;
    if (text?.type !== 'text') throw new PrintGoError('INVALID_RESPONSE', 'Printer tool returned no result.');
    return JSON.parse(text.text) as T;
  }

  async listPrinters(): Promise<Printer[]> {
    return (await this.call<{ printers: Printer[] }>('listPrinters', {})).printers;
  }
  getPrinterCapabilities(printerId: string): Promise<PrinterCapabilities> {
    return this.call('getPrinterCapabilities', { printerId });
  }
  checkPrinterStatus(printerId: string): Promise<PrinterStatus> {
    return this.call('checkPrinterStatus', { printerId });
  }
  sendPrintCommand(request: PrintRequest): Promise<PrintJob> {
    return this.call('sendPrintCommand', printRequestSchema.parse(request));
  }
  printMarkup(request: MarkupPrintRequest): Promise<PrintJob> {
    return this.call('printMarkup', markupPrintRequestSchema.parse(request));
  }
  getPrintJobStatus(jobId: string): Promise<PrintJob> {
    return this.call('getPrintJobStatus', { jobId });
  }
  cancelPrintJob(jobId: string): Promise<PrintJob> {
    return this.call('cancelPrintJob', { jobId });
  }
  close(): Promise<void> { return this.client.close(); }
}

export const connectPrinter = (options: PrinterClientOptions): Promise<PrinterClient> => PrinterClient.connect(options);
