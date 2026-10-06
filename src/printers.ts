import { PrintGoError } from './errors.js';
import { runCommand } from './commands.js';
import type { PrintJob, Printer, PrinterAdapter, PrinterCapabilities, PrinterStatus, PrintSettings } from './types.js';

function cupsState(details: string): string {
  if (details.includes('disabled')) return 'stopped';
  if (details.includes('now printing')) return 'printing';
  return 'idle';
}

export class CupsPrinterAdapter implements PrinterAdapter {
  constructor(private readonly command = runCommand) {}

  async listPrinters(): Promise<Printer[]> {
    const optional = async (args: string[]) => {
      try { return await this.command('lpstat', args); }
      catch (error) {
        if (error instanceof PrintGoError && error.code === 'COMMAND_FAILED' && /no (destinations|printers|system default destination)/i.test(error.message)) return '';
        throw error;
      }
    };
    const [printers, defaultPrinter] = await Promise.all([optional(['-p']), optional(['-d'])]);
    const defaultId = defaultPrinter.match(/system default destination: (.+)/)?.[1]?.trim();
    return printers.split('\n').flatMap(line => {
      const match = line.match(/^printer (\S+) (.+)$/);
      if (!match) return [];
      const id = match[1]!;
      const details = match[2]!;
      return [{ id, name: id, isDefault: id === defaultId,
        state: cupsState(details) }];
    });
  }

  async getPrinterCapabilities(printerId: string): Promise<PrinterCapabilities> {
    const output = await this.command('lpoptions', ['-p', printerId, '-l']);
    const options: Record<string, string[]> = {};
    for (const line of output.split('\n')) {
      const match = line.match(/^([^/]+)\/[^:]+:\s*(.*)$/);
      if (match) options[match[1]!] = match[2]!.split(/\s+/).filter(Boolean).map(value => value.replace(/^\*/, ''));
    }
    return { printerId, options };
  }

  async checkPrinterStatus(printerId: string): Promise<PrinterStatus> {
    const [details, accepting] = await Promise.all([
      this.command('lpstat', ['-l', '-p', printerId]),
      this.command('lpstat', ['-a', printerId]),
    ]);
    return {
      printerId,
      state: cupsState(details),
      acceptingJobs: !accepting.includes('not accepting'),
      details: details.trim(),
    };
  }

  async submit(filePath: string, printerId: string, settings: PrintSettings, jobName: string): Promise<string> {
    const args = ['-d', printerId, '-t', jobName, '-n', String(settings.copies ?? 1)];
    const option = (value: string) => args.push('-o', value);
    if (settings.pageRanges) option(`page-ranges=${settings.pageRanges}`);
    if (settings.paperSize) option(`media=${settings.paperSize}`);
    if (settings.orientation) option(`orientation-requested=${settings.orientation === 'landscape' ? 4 : 3}`);
    if (settings.sides) option(`sides=${settings.sides}`);
    if (settings.colorMode) option(`print-color-mode=${settings.colorMode}`);
    if (settings.fitToPage !== undefined) option(`fit-to-page=${settings.fitToPage}`);
    args.push('--', filePath);
    const output = await this.command('lp', args, 60_000);
    const id = output.match(/request id is (\S+) \(/)?.[1];
    if (!id) throw new PrintGoError('PRINT_RESULT_UNKNOWN', 'The print command succeeded but did not return a job ID. Do not resubmit with a new idempotency key.');
    return id;
  }

  async getJobStatus(job: PrintJob): Promise<PrintJob> {
    if (!job.nativeJobId) return { ...job, status: 'unknown', details: 'No native job ID was recorded.' };
    const active = await this.command('lpstat', ['-W', 'not-completed', '-l', '-o', job.printerId]);
    const found = active.split('\n').find(line => line.split(/\s+/)[0] === job.nativeJobId);
    if (found) return { ...job, status: 'pending', details: found.trim() };
    const completed = await this.command('lpstat', ['-W', 'completed', '-o', job.printerId]);
    const finished = completed.split('\n').find(line => line.split(/\s+/)[0] === job.nativeJobId);
    // CUPS' completed list also contains failed/cancelled jobs: never claim paper printed.
    return { ...job, status: finished ? 'completed' : 'unknown',
      details: finished ? 'The job left the active queue. Physical print success is not confirmed.' : 'The job is absent from retained queue history.' };
  }

  async cancelJob(job: PrintJob): Promise<void> {
    if (!job.nativeJobId) throw new PrintGoError('JOB_NOT_CANCELLABLE', 'No native job ID was recorded.');
    await this.command('cancel', [job.nativeJobId]);
  }
}

interface WindowsPrinter { Name: string; PrinterStatus: string | number; IsDefault?: boolean }
interface WindowsJob { ID: number; DocumentName: string; JobStatus: string | number }

export class WindowsPrinterAdapter implements PrinterAdapter {
  constructor(private readonly sumatra = 'SumatraPDF.exe') {}

  /** Data is passed as base64 JSON, never interpolated as PowerShell syntax. */
  private async powershell<T>(script: string, parameters: unknown = {}): Promise<T> {
    const data = Buffer.from(JSON.stringify(parameters)).toString('base64');
    const command = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); $p=([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json); ${script} | ConvertTo-Json -Depth 6 -Compress`;
    const output = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')]);
    return (output.trim() ? JSON.parse(output) : []) as T;
  }

  async listPrinters(): Promise<Printer[]> {
    const raw = await this.powershell<WindowsPrinter | WindowsPrinter[]>("Get-Printer | Select-Object Name,PrinterStatus,@{Name='IsDefault';Expression={$_.Name -eq (Get-CimInstance Win32_Printer -Filter 'Default=True').Name}}");
    return (Array.isArray(raw) ? raw : [raw]).map(printer => ({
      id: printer.Name, name: printer.Name, isDefault: Boolean(printer.IsDefault), state: String(printer.PrinterStatus),
    }));
  }

  async getPrinterCapabilities(printerId: string): Promise<PrinterCapabilities> {
    const configuration = await this.powershell<Record<string, unknown>>('Get-PrintConfiguration -PrinterName $p.printerId | Select-Object Color,DuplexingMode,PaperSize', { printerId });
    return { printerId, options: Object.fromEntries(Object.entries(configuration).map(([key, value]) => [key, [String(value)]])) };
  }

  async checkPrinterStatus(printerId: string): Promise<PrinterStatus> {
    const printer = await this.powershell<WindowsPrinter>('Get-Printer -Name $p.printerId | Select-Object Name,PrinterStatus', { printerId });
    return { printerId, state: String(printer.PrinterStatus), details: JSON.stringify(printer) };
  }

  private async jobs(printerId: string): Promise<WindowsJob[]> {
    const raw = await this.powershell<WindowsJob | WindowsJob[]>('Get-PrintJob -PrinterName $p.printerId | Select-Object ID,DocumentName,JobStatus', { printerId });
    return Array.isArray(raw) ? raw : [raw];
  }

  async submit(filePath: string, printerId: string, settings: PrintSettings, jobName: string): Promise<string | undefined> {
    const options = [`${settings.copies ?? 1}x`, `docname=${jobName}`];
    if (settings.pageRanges) options.push(settings.pageRanges);
    if (settings.paperSize) options.push(`paper=${settings.paperSize}`);
    if (settings.orientation) options.push(settings.orientation);
    if (settings.colorMode) options.push(settings.colorMode === 'monochrome' ? 'monochrome' : 'color');
    if (settings.sides) options.push({ 'one-sided': 'simplex', 'two-sided-long-edge': 'duplexlong', 'two-sided-short-edge': 'duplexshort' }[settings.sides]);
    if (settings.fitToPage !== undefined) options.push(settings.fitToPage ? 'fit' : 'noscale');
    await runCommand(this.sumatra, ['-print-to', printerId, '-print-settings', options.join(','), '-silent', filePath], 60_000);
    const job = (await this.jobs(printerId)).find(job => job.DocumentName === jobName);
    return job ? String(job.ID) : undefined;
  }

  async getJobStatus(job: PrintJob): Promise<PrintJob> {
    const native = (await this.jobs(job.printerId)).find(item => String(item.ID) === job.nativeJobId && item.DocumentName === `printgo-${job.jobId}`);
    return { ...job, status: native ? 'pending' : 'unknown', details: native ? String(native.JobStatus) : 'The job is absent from the active queue; physical print success is not confirmed.' };
  }

  async cancelJob(job: PrintJob): Promise<void> {
    if (!job.nativeJobId || !/^\d+$/.test(job.nativeJobId)) throw new PrintGoError('JOB_NOT_CANCELLABLE', 'No native job ID was recorded.');
    if (!(await this.jobs(job.printerId)).some(item => String(item.ID) === job.nativeJobId && item.DocumentName === `printgo-${job.jobId}`)) {
      throw new PrintGoError('JOB_NOT_CANCELLABLE', 'This job is no longer present in the active queue.');
    }
    await this.powershell('Remove-PrintJob -PrinterName $p.printerId -ID $p.id; $true', { printerId: job.printerId, id: Number(job.nativeJobId) });
  }
}

export function defaultPrinterAdapter(sumatraPdfPath?: string): PrinterAdapter {
  if (process.platform === 'win32') return new WindowsPrinterAdapter(sumatraPdfPath);
  if (process.platform === 'darwin' || process.platform === 'linux') return new CupsPrinterAdapter();
  throw new PrintGoError('UNSUPPORTED_PLATFORM', 'Printing is supported on macOS, Linux (CUPS), and Windows.');
}
