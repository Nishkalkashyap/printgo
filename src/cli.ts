#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import type { stop } from './hosting.js';
import { PrintGoError, messageOf } from './errors.js';
import { readJson, stateDirectory } from './storage.js';
import type { DaemonStatus, StartOptions, StartResult, TunnelConfig } from './hosting-types.js';
import { installBrowser, type BrowserInstallResult } from './browser.js';
import { servePrinterStdio } from './stdio.js';
import { commandNames, renderHelp } from './cli-help.js';

// Parse errors must also respect --json.
let jsonOutput = process.argv.slice(2).includes('--json');
type CommandResult = StartResult | DaemonStatus | Awaited<ReturnType<typeof stop>> | BrowserInstallResult;

async function confirmCloudflaredDownload(directory?: string): Promise<boolean> {
  if (!stdin.isTTY) {
    throw new PrintGoError('DOWNLOAD_CONFIRMATION_REQUIRED', 'cloudflared is not installed. Run start in an interactive terminal to approve installation, pass --yes, or install cloudflared manually.');
  }
  const prompt = createInterface({ input: stdin, output: stderr });
  const controller = new AbortController();
  prompt.once('close', () => controller.abort());
  try {
    const answer = await prompt.question(`cloudflared is missing. Download it to ${join(stateDirectory(directory), 'bin')}? [y/N] `, { signal: controller.signal });
    return /^(y|yes)$/i.test(answer.trim());
  } catch (error) {
    if (controller.signal.aborted) return false;
    throw error;
  } finally { prompt.close(); }
}

function writeResult(result: CommandResult): void {
  if (jsonOutput) { process.stdout.write(`${JSON.stringify(result)}\n`); return; }
  const lines = ['PrintGo-MCP', ''];
  const field = (label: string, value: string | number) => lines.push(`  ${`${label}:`.padEnd(13)} ${value}`);
  if (result.status === 'started' || result.status === 'already_running') {
    lines.push(result.status === 'started' ? 'Tunnel started.' : 'Tunnel is already running.', '');
    field('MCP URL', result.mcpConnectionURL);
    field('Auth header', result.authHeader);
    field('Password', result.password);
    field('Tunnel', result.tunnelMode === 'quick' ? 'Random URL (Quick Tunnel)' : 'Custom domain');
    field('Process ID', result.pid);
    lines.push('', 'Connect your MCP client with Authorization: Bearer <password>.',
      '', 'Stop with: npx printgo stop');
  } else if (result.status === 'ready') {
    lines.push('Browser ready.', '');
    field('Executable', result.executablePath);
    field('Build', result.buildId);
  } else if (result.status === 'stopped') {
    lines.push('message' in result ? result.message : 'Daemon is stopped.');
  } else {
    field('Status', { running: 'Running', starting: 'Starting', unreachable: 'Unreachable' }[result.status]);
    if (result.mcpConnectionURL) field('MCP URL', result.mcpConnectionURL);
    if (result.tunnelMode) field('Tunnel', result.tunnelMode === 'quick' ? 'Random URL (Quick Tunnel)' : 'Custom domain');
    if (result.pid !== undefined) field('Process ID', result.pid);
    if ('startedAt' in result && result.startedAt) field('Started at', result.startedAt);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // Accept --custom-domain-with-cf with or without a hostname.
  const custom = args.indexOf('--custom-domain-with-cf');
  if (custom >= 0 && args[custom + 1] && !args[custom + 1]!.startsWith('-') && args[custom + 1]!.includes('.')) {
    args.splice(custom + 1, 1, '--hostname', args[custom + 1]!);
  }
  const { values, positionals } = parseArgs({ args, allowPositionals: true, strict: true, options: {
    quick: { type: 'boolean' }, 'custom-domain-with-cf': { type: 'boolean' },
    hostname: { type: 'string' }, 'tunnel-name': { type: 'string' }, 'tunnel-id': { type: 'string' },
    'credentials-file': { type: 'string' }, 'tunnel-token-file': { type: 'string' },
    port: { type: 'string' }, 'state-dir': { type: 'string' }, cloudflared: { type: 'string' },
    'no-download': { type: 'boolean' }, 'startup-timeout': { type: 'string' }, 'sumatra-pdf': { type: 'string' }, chrome: { type: 'string' },
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' }, json: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' },
  } });
  jsonOutput = Boolean(values.json);
  if (values.version) { process.stdout.write('0.1.0\n'); return; }
  const command = positionals[0];
  if (positionals.length > 1 || (command !== undefined && !commandNames.includes(command))) {
    throw new PrintGoError('INVALID_COMMAND', 'Use stdio, start, stop, status, restart, or install-browser. See --help.');
  }
  if (values.help || command === undefined) { process.stdout.write(renderHelp(command)); return; }
  const allowedOptions: Record<string, string[]> = {
    stdio: ['state-dir', 'sumatra-pdf', 'chrome'],
    'install-browser': ['state-dir', 'json'],
    stop: ['state-dir', 'json'],
    status: ['state-dir', 'json'],
  };
  const allowed = allowedOptions[command];
  if (allowed && Object.keys(values).some(key => !allowed.includes(key))) {
    throw new PrintGoError('INVALID_OPTIONS', `${command} accepts ${allowed.map(key => `--${key}`).join(', ')}. See ${command} --help.`);
  }
  if (command === 'stdio') {
    const app = servePrinterStdio({
      stateDir: values['state-dir'], sumatraPdfPath: values['sumatra-pdf'], browserExecutablePath: values.chrome,
      onerror: error => { process.stderr.write(`${messageOf(error)}\n`); },
    });
    const shutdown = () => { void app.close().catch(error => { process.stderr.write(`${messageOf(error)}\n`); process.exitCode = 1; }); };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return;
  }
  if (command === 'install-browser') {
    writeResult(await installBrowser({ stateDir: values['state-dir'] }));
    return;
  }
  const { start, stop, status, restart, configureCloudflare } = await import('./hosting.js');
  if (command === 'stop' || command === 'status') {
    writeResult(await (command === 'stop' ? stop : status)({ stateDir: values['state-dir'] }));
    return;
  }
  const { tunnelSchema } = await import('./cloudflare.js');
  if (values.yes && values['no-download']) throw new PrintGoError('INVALID_OPTIONS', '--yes cannot be combined with --no-download.');
  const options: StartOptions = {
    stateDir: values['state-dir'], cloudflaredPath: values.cloudflared,
    downloadCloudflared: values['no-download'] ? false : values.yes,
    confirmCloudflaredDownload: () => confirmCloudflaredDownload(values['state-dir']),
    port: values.port === undefined ? undefined : Number(values.port),
    startupTimeoutMs: values['startup-timeout'] === undefined ? undefined : Number(values['startup-timeout']) * 1000,
    sumatraPdfPath: values['sumatra-pdf'],
    browserExecutablePath: values.chrome,
  };
  const namedFlags = Boolean(values['custom-domain-with-cf'] || values.hostname || values['tunnel-id'] || values['credentials-file'] || values['tunnel-token-file'] || values['tunnel-name']);
  if (values.quick && namedFlags) throw new PrintGoError('INVALID_OPTIONS', '--quick cannot be combined with custom tunnel options.');
  if (values['tunnel-token-file'] && (values['tunnel-id'] || values['credentials-file'] || values['custom-domain-with-cf'] || values['tunnel-name'])) {
    throw new PrintGoError('INVALID_OPTIONS', 'Token mode only accepts --hostname, --tunnel-token-file, and --port.');
  }
  let domain = values.hostname;
  if (values['custom-domain-with-cf']) {
    if ((await status(options)).status !== 'stopped') throw new PrintGoError('ALREADY_RUNNING', 'Run stop before setting up a custom domain.');
    if (!domain) {
      const saved = await readJson<TunnelConfig>(join(stateDirectory(options.stateDir), 'tunnel.json'));
      if (saved?.mode === 'named') domain = saved.hostname;
    }
    if (!domain) {
      if (!stdin.isTTY) throw new PrintGoError('HOSTNAME_REQUIRED', 'Provide --hostname printer.example.com in non-interactive mode.');
      const prompt = createInterface({ input: stdin, output: stderr });
      try { domain = (await prompt.question('Cloudflare hostname (e.g. printer.example.com): ')).trim(); }
      finally { prompt.close(); }
    }
    if (!values['tunnel-id'] && !values['credentials-file']) {
      options.tunnel = await configureCloudflare({ ...options, hostname: domain, tunnelName: values['tunnel-name'], login: true });
    }
  }
  if (!options.tunnel && namedFlags) {
    if (!domain) throw new PrintGoError('HOSTNAME_REQUIRED', 'Provide --hostname for your named tunnel.');
    if (values['tunnel-token-file']) {
      options.tunnel = tunnelSchema.parse({ mode: 'token', hostname: domain, tokenFile: values['tunnel-token-file'] });
    } else if (values['tunnel-id'] && values['credentials-file']) {
      options.tunnel = tunnelSchema.parse({ mode: 'named', hostname: domain, tunnelId: values['tunnel-id'], credentialsFile: values['credentials-file'] });
    } else throw new PrintGoError('INVALID_OPTIONS', 'Use --custom-domain-with-cf, or supply both --tunnel-id and --credentials-file, or a --tunnel-token-file.');
  }
  if (values.quick) options.tunnel = { mode: 'quick' };
  writeResult(await (command === 'restart' ? restart : start)(options));
}

void main().catch(error => {
  const code = error instanceof PrintGoError ? error.code : 'INVALID_REQUEST';
  const message = messageOf(error);
  process.stderr.write(jsonOutput ? `${JSON.stringify({ status: 'error', code, message })}\n` : `Error [${code}]: ${message}\n`);
  process.exitCode = 1;
});
