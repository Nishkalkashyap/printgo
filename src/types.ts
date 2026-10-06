export interface PrintSettings {
  copies?: number;
  pageRanges?: string;
  paperSize?: string;
  orientation?: 'portrait' | 'landscape';
  sides?: 'one-sided' | 'two-sided-long-edge' | 'two-sided-short-edge';
  colorMode?: 'color' | 'monochrome';
  fitToPage?: boolean;
}

export interface Printer {
  id: string;
  name: string;
  isDefault: boolean;
  state: string;
}

export interface PrinterCapabilities {
  printerId: string;
  /** Driver-reported options; exact support varies by printer and driver. */
  options: Record<string, string[]>;
}

export interface PrinterStatus {
  printerId: string;
  state: string;
  acceptingJobs?: boolean;
  details: string;
}

export type AssetType = 'auto' | 'pdf' | 'png' | 'jpeg' | 'text';

export interface PrintRequest {
  printerId: string;
  /** Direct public or signed HTTPS file URL (at most 10 MiB). */
  assetUrl: string;
  /** Defaults to auto. Use text for extensionless text served as octet-stream. */
  assetType?: AssetType;
  settings?: PrintSettings;
  /** Reusing a key with the same arguments returns the existing job. */
  idempotencyKey: string;
}

/** Locally render Markdown/HTML and print the result. Provide exactly one source. */
export interface MarkupPrintRequest {
  printerId: string;
  format: 'markdown' | 'html';
  /** Short document source; larger documents can be supplied by URL. */
  content?: string;
  /** Direct public or signed HTTPS URL containing UTF-8 markup. */
  assetUrl?: string;
  settings?: PrintSettings;
  idempotencyKey: string;
}

export interface PrintJob {
  jobId: string;
  printerId: string;
  nativeJobId?: string;
  status: 'submitting' | 'submitted' | 'pending' | 'printing' | 'completed' | 'cancelled' | 'failed' | 'unknown';
  createdAt: string;
  details?: string;
}

export interface PrinterAdapter {
  listPrinters(): Promise<Printer[]>;
  getPrinterCapabilities(printerId: string): Promise<PrinterCapabilities>;
  checkPrinterStatus(printerId: string): Promise<PrinterStatus>;
  submit(filePath: string, printerId: string, settings: PrintSettings, jobName: string): Promise<string | undefined>;
  getJobStatus(job: PrintJob): Promise<PrintJob>;
  cancelJob(job: PrintJob): Promise<void>;
}
