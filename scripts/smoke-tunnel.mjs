import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, stop } from 'printgo/hosting';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const stateDir = await mkdtemp(join(tmpdir(), 'printgo-smoke-'));
let client;
try {
  const connection = await start({ stateDir, tunnel: { mode: 'quick' }, startupTimeoutMs: 60_000,
    downloadCloudflared: process.argv.includes('--yes') ? true : undefined });
  console.log('Daemon connected to a real Cloudflare Quick Tunnel.');
  const deadline = Date.now() + 120_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const healthURL = new URL('/health', connection.mcpConnectionURL);
      const health = await fetch(healthURL, {
        headers: { Authorization: `Bearer ${connection.password}` }, signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      if (!health.ok) throw new Error(`Public health endpoint returned HTTP ${health.status}`);
      await health.arrayBuffer();
      client = new Client({ name: 'printgo-smoke', version: '1' }, { versionNegotiation: { mode: 'auto' } });
      await client.connect(new StreamableHTTPClientTransport(new URL(connection.mcpConnectionURL), {
        requestInit: { headers: { Authorization: `Bearer ${connection.password}` }, redirect: 'error' },
      }));
      const tools = await client.listTools();
      if (tools.tools.length !== 7) throw new Error('Expected seven printer tools');
      console.log('Authenticated remote MCP connection succeeded; all seven tools were discovered.');
      break;
    } catch (error) {
      lastError = error;
      await client?.close();
      client = undefined;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  if (!client) throw lastError ?? new Error('Remote connection timed out');
} catch (error) {
  console.error(error.message);
  if (error.cause) console.error(error.cause.message ?? error.cause.code);
  console.error((await readFile(join(stateDir, 'daemon.log'), 'utf8').catch(() => '')).slice(-5000));
  process.exitCode = 1;
} finally {
  await client?.close();
  await stop({ stateDir });
  await rm(stateDir, { recursive: true, force: true });
}
