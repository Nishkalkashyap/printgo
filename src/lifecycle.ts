import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { z } from 'zod';
import { ensureCloudflared, tunnelSchema } from './cloudflare.js';
import { PrintGoError } from './errors.js';
import { delay, processExists, readJson, stateDirectory, withLock, writeJson } from './storage.js';
import type { DaemonStatus, RuntimeConfig, RuntimeState, StartOptions, StartResult, TunnelConfig } from './hosting-types.js';

async function inspect(directory: string): Promise<{ state?: RuntimeState; status: DaemonStatus }> {
  const state = await readJson<RuntimeState>(join(directory, 'state.json'));
  if (!state || !processExists(state.pid) || state.status === 'stopped' || state.status === 'failed') return { state, status: { status: 'stopped' } };
  const info = { pid: state.pid, mcpConnectionURL: state.mcpConnectionURL, tunnelMode: state.tunnelMode, startedAt: state.startedAt, localURL: state.localURL };
  if (!state.localURL && state.status === 'starting') return { state, status: { status: 'starting', ...info } };
  try {
    const response = await fetch(`${state.localURL}/internal/status`, {
      headers: { Authorization: `Bearer ${state.adminToken}` }, signal: AbortSignal.timeout(1500), redirect: 'error',
    });
    const result = await response.json() as { instanceId?: string; status?: string };
    if (!response.ok || result.instanceId !== state.instanceId) throw new Error('Daemon identity mismatch');
    return { state, status: { status: result.status === 'running' ? 'running' : 'starting', ...info } };
  } catch { return { state, status: { status: 'unreachable', ...info } }; }
}

export async function status(options: Pick<StartOptions, 'stateDir'> = {}): Promise<DaemonStatus> {
  return (await inspect(stateDirectory(options.stateDir))).status;
}

function startResult(state: RuntimeState, result: StartResult['status']): StartResult {
  if (!state.mcpConnectionURL) throw new PrintGoError('NOT_READY', 'The tunnel URL is not ready.');
  return {
    status: result,
    message: `${result === 'started' ? 'Started' : 'Already running'} tunnel on ${new URL(state.mcpConnectionURL).hostname}. Use Authorization: Bearer <password>.`,
    password: state.password, mcpConnectionURL: state.mcpConnectionURL, authHeader: 'Authorization',
    pid: state.pid, tunnelMode: state.tunnelMode,
  };
}

export async function start(options: StartOptions = {}): Promise<StartResult> {
  const directory = stateDirectory(options.stateDir);
  return withLock(directory, async () => {
    const current = await inspect(directory);
    if (current.status.status === 'running' && current.state) {
      if (options.tunnel && (options.tunnel.mode !== current.state.tunnelMode || (options.tunnel.mode !== 'quick' && new URL(current.state.mcpConnectionURL!).hostname !== options.tunnel.hostname))) {
        throw new PrintGoError('ALREADY_RUNNING', 'Stop the existing daemon before changing its tunnel.');
      }
      return startResult(current.state, 'already_running');
    }
    if (current.status.status !== 'stopped') throw new PrintGoError('DAEMON_BUSY', 'A daemon is starting or unreachable. Run status/stop before starting another daemon.');
    const previous = await readJson<StartOptions>(join(directory, 'last-start.json'));
    const tunnel = tunnelSchema.parse(options.tunnel ?? await readJson<TunnelConfig>(join(directory, 'tunnel.json')) ?? { mode: 'quick' });
    const port = z.number().int().min(0).max(65535).parse(options.port ?? previous?.port ?? 0);
    if (tunnel.mode === 'token' && port === 0) throw new PrintGoError('PORT_REQUIRED', 'Token tunnels require an explicit port matching the service URL configured in your Cloudflare dashboard.');
    const timeout = z.number().int().min(1000).max(300_000).parse(options.startupTimeoutMs ?? 90_000);
    const cloudflaredPath = await ensureCloudflared({ ...options, cloudflaredPath: options.cloudflaredPath ?? previous?.cloudflaredPath });
    let credentials = await readJson<{ password: string }>(join(directory, 'credentials.json'));
    if (!credentials) {
      credentials = { password: randomBytes(32).toString('base64url') };
      await writeJson(join(directory, 'credentials.json'), credentials);
    }
    const config: RuntimeConfig = {
      stateDir: directory, tunnel, port, cloudflaredPath, startupTimeoutMs: timeout,
      sumatraPdfPath: options.sumatraPdfPath ?? previous?.sumatraPdfPath,
      browserExecutablePath: options.browserExecutablePath ?? previous?.browserExecutablePath,
      password: credentials.password, adminToken: randomBytes(32).toString('base64url'), instanceId: randomUUID(),
    };
    const log = await open(join(directory, 'daemon.log'), 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./daemon.cjs', import.meta.url))], {
      detached: true, stdio: ['pipe', log.fd, log.fd], windowsHide: true, cwd: directory,
    });
    await log.close();
    let spawnError: Error | undefined;
    child.on('error', error => { spawnError = error; });
    child.stdin!.on('error', error => { spawnError = error; });
    const initial: RuntimeState = {
      instanceId: config.instanceId, pid: child.pid ?? 0, status: 'starting', localURL: '', password: config.password,
      adminToken: config.adminToken, tunnelMode: tunnel.mode, startedAt: new Date().toISOString(),
    };
    try {
      await writeJson(join(directory, 'state.json'), initial);
      child.stdin!.end(JSON.stringify(config));
      child.unref();
      const deadline = Date.now() + timeout + 5_000;
      while (Date.now() < deadline) {
        if (spawnError) throw spawnError;
        const state = await readJson<RuntimeState>(join(directory, 'state.json'));
        if (state?.instanceId !== config.instanceId) throw new PrintGoError('STATE_CONFLICT', 'Daemon state changed during startup.');
        if (state.status === 'running') {
          const health = await inspect(directory);
          if (health.status.status === 'running') {
            if (options.tunnel && tunnel.mode !== 'quick') await writeJson(join(directory, 'tunnel.json'), tunnel);
            await writeJson(join(directory, 'last-start.json'), {
              tunnel, port, cloudflaredPath, startupTimeoutMs: timeout, sumatraPdfPath: config.sumatraPdfPath, browserExecutablePath: config.browserExecutablePath,
            });
            return startResult(state, 'started');
          }
        }
        if (state.status === 'failed' || state.status === 'stopped' || !processExists(state.pid)) {
          throw new PrintGoError('START_FAILED', state.error ?? `Daemon exited during startup. See ${join(directory, 'daemon.log')}.`);
        }
        await delay(150);
      }
      throw new PrintGoError('START_TIMEOUT', `Tunnel startup timed out. See ${join(directory, 'daemon.log')}.`);
    } catch (error) {
      // This is the child we just spawned, not a PID recovered from a stale file.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      throw error;
    }
  });
}

export async function stop(options: Pick<StartOptions, 'stateDir'> = {}): Promise<{ status: 'stopped'; message: string }> {
  const directory = stateDirectory(options.stateDir);
  return withLock(directory, async () => {
    const current = await inspect(directory);
    if (current.status.status === 'stopped' || !current.state) return { status: 'stopped', message: 'Daemon is stopped.' };
    const state = current.state;
    if (current.status.status === 'unreachable' || !state.localURL) {
      throw new PrintGoError('DAEMON_UNREACHABLE', 'Cannot authenticate the daemon. Refusing to signal a PID from a stale state file. Check daemon.log.');
    }
    const response = await fetch(`${state.localURL}/internal/stop`, {
      method: 'POST', headers: { Authorization: `Bearer ${state.adminToken}` }, signal: AbortSignal.timeout(3000), redirect: 'error',
    });
    if (!response.ok) throw new PrintGoError('STOP_FAILED', 'The daemon rejected the stop request.');
    await response.arrayBuffer();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const next = await readJson<RuntimeState>(join(directory, 'state.json'));
      if (!processExists(state.pid) || (next?.instanceId === state.instanceId && (next.status === 'stopped' || next.status === 'failed'))) {
        return { status: 'stopped', message: 'Stopped daemon and Cloudflare tunnel.' };
      }
      await delay(100);
    }
    throw new PrintGoError('STOP_TIMEOUT', 'The daemon has not finished stopping. Check status and daemon.log.');
  });
}

export async function restart(options: StartOptions = {}): Promise<StartResult> {
  const previous = await readJson<StartOptions>(join(stateDirectory(options.stateDir), 'last-start.json'));
  await stop(options);
  const explicit = Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
  return start({ ...previous, ...explicit });
}
