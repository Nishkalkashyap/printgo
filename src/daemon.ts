import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { cloudflaredEnvironment, tunnelArguments } from './cloudflare.js';
import { createPrinterHttpServer } from './server.js';
import { delay, writeJson } from './storage.js';
import { messageOf } from './errors.js';
import type { RuntimeConfig, RuntimeState } from './hosting-types.js';

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Startup configuration too large');
    chunks.push(Buffer.from(chunk));
  }
  const config = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RuntimeConfig;
  const state: RuntimeState = {
    instanceId: config.instanceId, pid: process.pid, status: 'starting', localURL: '', password: config.password,
    adminToken: config.adminToken, tunnelMode: config.tunnel.mode, startedAt: new Date().toISOString(),
  };
  let child: ChildProcess | undefined;
  let shuttingDown: Promise<void> | undefined;
  const app = createPrinterHttpServer({
    password: config.password, adminToken: config.adminToken, stateDir: config.stateDir, sumatraPdfPath: config.sumatraPdfPath,
    browserExecutablePath: config.browserExecutablePath,
    publicURL: config.tunnel.mode === 'quick' ? undefined : `https://${config.tunnel.hostname}`,
    getStatus: () => ({ instanceId: state.instanceId, status: state.status }),
    onStop: () => { void shutdown(); },
  });
  const persist = () => writeJson(join(config.stateDir, 'state.json'), state);
  function shutdown(error?: unknown): Promise<void> {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      if (error) { state.error = messageOf(error); console.error(state.error); }
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const deadline = Date.now() + 5000;
        while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
      if (app.server.listening) {
        const forced = setTimeout(() => app.server.closeAllConnections(), 5000);
        try { await app.close(); } finally { clearTimeout(forced); }
      }
      state.status = error ? 'failed' : 'stopped';
      await persist();
      process.exit(error ? 1 : 0);
    })();
    return shuttingDown;
  }
  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
  process.once('uncaughtException', error => { void shutdown(error); });
  process.once('unhandledRejection', error => { void shutdown(error); });
  try {
    // Crash recovery: temporary PDFs are never used as durable source documents.
    await rm(join(config.stateDir, 'documents'), { recursive: true, force: true });
    state.localURL = await app.listen(config.port);
    await persist();
    const args = await tunnelArguments(config.tunnel, config.stateDir, state.localURL);
    child = spawn(config.cloudflaredPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: cloudflaredEnvironment() });
    const ready = new Promise<string>((resolve, reject) => {
      let url = config.tunnel.mode === 'quick' ? undefined : `https://${config.tunnel.hostname}`;
      let connected = false;
      let buffer = '';
      const consume = (chunk: Buffer) => {
        // Never run cloudflared at debug level: it can log request credentials.
        process.stderr.write(chunk);
        buffer = (buffer + chunk.toString()).slice(-16_384);
        if (config.tunnel.mode === 'quick') url = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/)?.[0] ?? url;
        if (buffer.includes('Registered tunnel connection')) connected = true;
        if (url) app.setPublicURL(url);
        if (url && connected) resolve(url);
      };
      child!.stdout!.on('data', consume);
      child!.stderr!.on('data', consume);
      child!.once('error', reject);
      child!.once('exit', (code, signal) => reject(new Error(`cloudflared exited (${code ?? signal})`)));
    });
    child.once('exit', (code, signal) => {
      if (!shuttingDown) void shutdown(new Error(`cloudflared exited (${code ?? signal}). Run start to reconnect.`));
    });
    const timeout = setTimeout(() => { void shutdown(new Error('Cloudflare tunnel did not connect before the startup timeout.')); }, config.startupTimeoutMs);
    let publicURL: string;
    try { publicURL = await ready; } finally { clearTimeout(timeout); }
    if (shuttingDown) return;
    state.mcpConnectionURL = `${publicURL}/mcp`;
    state.status = 'running';
    await persist();
  } catch (error) { await shutdown(error); }
}

void main().catch(error => { console.error(messageOf(error)); process.exitCode = 1; });
