import { servePrinterStdio } from 'printgo';

let submissions = 0;
servePrinterStdio({
  stateDir: process.argv[2],
  adapter: {
    async listPrinters() { return [{ id: 'test-printer', name: 'Test printer', isDefault: true, state: 'idle' }]; },
    async getPrinterCapabilities(printerId) { return { printerId, options: { PageSize: ['A4', 'Letter'] } }; },
    async checkPrinterStatus(printerId) { return { printerId, state: 'idle', details: 'Ready' }; },
    async submit() { return `test-printer-${++submissions}`; },
    async getJobStatus(job) { return { ...job, status: 'pending' }; },
    async cancelJob() {},
  },
  assetDownloader: async () => Buffer.from('%PDF-1.4\n%%EOF'),
});
