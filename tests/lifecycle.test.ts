import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, readdir, stat as fileStat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { start, status, stop, restart } from 'printgo/hosting';
import { processExists, readJson, writeJson } from '../src/storage.js';
import type { RuntimeState } from '../src/hosting-types.js';
import { temporaryDirectory } from './helpers.js';
import { runCommand } from '../src/commands.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const binary = fileURLToPath(new URL('./fixtures/cloudflared.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

test('concurrent start reuses one detached daemon; status omits secrets; stop cleans up', async () => {
  await chmod(binary, 0o755);
  const tmp = await temporaryDirectory();
  const options = { stateDir: tmp.directory, cloudflaredPath: binary, downloadCloudflared: false, startupTimeoutMs: 5000 };
  try {
    const results = await Promise.all([start(options), start(options)]);
    assert.deepEqual(results.map(result => result.status).sort(), ['already_running', 'started']);
    assert.equal(results[0]!.pid, results[1]!.pid);
    assert.equal(results[0]!.password, results[1]!.password);
    assert.equal(results[0]!.authHeader, 'Authorization');
    assert.equal(results[0]!.mcpConnectionURL, 'https://test-printgo.trycloudflare.com/mcp');
    const running = await status(options);
    assert.equal(running.status, 'running');
    assert.ok(!JSON.stringify(running).includes(results[0]!.password));
    assert.equal((await fileStat(join(tmp.directory, 'credentials.json'))).mode & 0o777, 0o600);
    const runtime = await readJson<RuntimeState>(join(tmp.directory, 'state.json'));
    const mcp = new Client({ name: 'bundled-daemon-test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
    try {
      await mcp.connect(new StreamableHTTPClientTransport(new URL(`${runtime!.localURL}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${results[0]!.password}` } },
      }));
      assert.equal((await mcp.listTools()).tools.length, 7);
    } finally { await mcp.close(); }
    const control = await fetch(`${runtime!.localURL}/internal/stop`, { method: 'POST', headers: { Authorization: `Bearer ${results[0]!.password}` } });
    assert.equal(control.status, 401);
    assert.equal((await stop(options)).status, 'stopped');
    assert.equal((await status(options)).status, 'stopped');
    const next = await start(options);
    assert.equal(next.password, results[0]!.password);
    const restarted = await restart({ stateDir: tmp.directory });
    assert.equal(restarted.password, next.password);
    assert.notEqual(restarted.pid, next.pid);
    await stop(options);
    assert.equal((await stop(options)).status, 'stopped');
  } finally { await stop(options); await tmp.cleanup(); }
});

test('a tunnel startup failure is reported and leaves no running daemon', async () => {
  const tmp = await temporaryDirectory();
  process.env.FAKE_CF_FAIL = '1';
  try {
    await assert.rejects(start({ stateDir: tmp.directory, cloudflaredPath: binary, startupTimeoutMs: 3000 }), { code: 'START_FAILED' });
    assert.equal((await status({ stateDir: tmp.directory })).status, 'stopped');
  } finally { delete process.env.FAKE_CF_FAIL; await tmp.cleanup(); }
});

test('stale state never causes a signal to an unrelated live PID', async () => {
  const tmp = await temporaryDirectory();
  try {
    await writeJson(join(tmp.directory, 'state.json'), {
      pid: process.pid, instanceId: 'stale', status: 'running', localURL: 'http://127.0.0.1:1', adminToken: 'stale',
    });
    assert.equal((await status({ stateDir: tmp.directory })).status, 'unreachable');
    await assert.rejects(stop({ stateDir: tmp.directory }), { code: 'DAEMON_UNREACHABLE' });
    assert.ok(processExists(process.pid));
  } finally { await tmp.cleanup(); }
});

test('CLI without a command only shows help; human output is default and JSON is explicit', async () => {
  const tmp = await temporaryDirectory();
  try {
    const help = await runCommand(process.execPath, [cli, '--help']);
    assert.match(help, /Connect a local MCP client/);
    assert.ok(!help.includes('--tunnel-id'));
    const hostingHelp = await runCommand(process.execPath, [cli, 'start', '--help', '--state-dir', tmp.directory]);
    assert.match(hostingHelp, /Tunnel options/);
    assert.match(hostingHelp, /--custom-domain-with-cf/);
    const stdioHelp = await runCommand(process.execPath, [cli, 'stdio', '--help', '--state-dir', tmp.directory]);
    assert.match(stdioHelp, /Printer options/);
    assert.ok(!stdioHelp.includes('--tunnel-id'));
    for (const command of ['stop', 'status', 'restart', 'install-browser']) {
      const commandHelp = await runCommand(process.execPath, [cli, command, '--help']);
      assert.ok(commandHelp.includes(`npx printgo ${command} [options]`));
    }
    await assert.rejects(runCommand(process.execPath, [cli, 'delete-all', '--help']), /INVALID_COMMAND/);
    assert.equal(await runCommand(process.execPath, [cli]), help);
    assert.equal(await runCommand(process.execPath, [cli, '--state-dir', tmp.directory, '--no-download']), help);
    assert.equal(await runCommand(process.execPath, [cli, '--custom-domain-with-cf', 'printer.example.com', '--state-dir', tmp.directory]), help);
    assert.deepEqual(await readdir(tmp.directory), []);
    assert.match(await runCommand(process.execPath, [cli, 'status', '--state-dir', tmp.directory]), /Daemon is stopped\./);
    const stopped = JSON.parse(await runCommand(process.execPath, [cli, 'status', '--json', '--state-dir', tmp.directory]));
    assert.deepEqual(stopped, { status: 'stopped' });
    await assert.rejects(runCommand(process.execPath, [cli, 'delete-all']), /Error \[INVALID_COMMAND\]:/);
    const execute = promisify(execFile);
    for (const args of [['delete-all', '--json'], ['start', '--unknown-option', '--json']]) {
      await assert.rejects(execute(process.execPath, [cli, ...args]), (error: any) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        const failure = JSON.parse(error.stderr);
        assert.equal(failure.status, 'error');
        assert.ok(failure.code);
        assert.ok(failure.message);
        return true;
      });
    }
    await assert.rejects(runCommand(process.execPath, [cli, 'start', '--quick', '--hostname', 'printer.example.com']), /INVALID_OPTIONS/);
    assert.equal((await readFile(join(tmp.directory, 'lifecycle.lock', 'owner.json')).catch(() => Buffer.from('absent'))).toString(), 'absent');
  } finally { await tmp.cleanup(); }
});

test('CLI start presents connection details; JSON reuse, status and stop retain their contracts', async () => {
  await chmod(binary, 0o755);
  const tmp = await temporaryDirectory();
  const options = { stateDir: tmp.directory };
  const args = ['--state-dir', tmp.directory];
  try {
    const output = await runCommand(process.execPath, [cli, 'start', ...args, '--cloudflared', binary, '--no-download', '--startup-timeout', '5']);
    const runtime = (await readJson<RuntimeState>(join(tmp.directory, 'state.json')))!;
    assert.match(output, /^PrintGo-MCP\n\nTunnel started\./);
    assert.ok(output.includes(`MCP URL:      ${runtime.mcpConnectionURL}`));
    assert.ok(output.includes(`Password:     ${runtime.password}`));
    assert.match(output, /Auth header:  Authorization/);
    assert.match(output, /Authorization: Bearer <password>/);
    assert.match(output, /Stop with: npx printgo stop/);
    assert.match(await runCommand(process.execPath, [cli, 'start', ...args]), /Tunnel is already running\./);
    const reused = JSON.parse(await runCommand(process.execPath, [cli, 'start', ...args, '--json']));
    assert.equal(reused.status, 'already_running');
    assert.equal(reused.pid, runtime.pid);
    assert.equal(reused.password, runtime.password);
    const readableStatus = await runCommand(process.execPath, [cli, 'status', ...args]);
    assert.match(readableStatus, /Status:       Running/);
    assert.ok(!readableStatus.includes(runtime.password));
    const running = JSON.parse(await runCommand(process.execPath, [cli, 'status', ...args, '--json']));
    assert.equal(running.status, 'running');
    assert.ok(!JSON.stringify(running).includes(runtime.password));
    assert.match(await runCommand(process.execPath, [cli, ...args]), /Use <command> --help/);
    assert.equal((await status(options)).pid, runtime.pid);
    assert.match(await runCommand(process.execPath, [cli, 'stop', ...args]), /Stopped daemon and Cloudflare tunnel\./);
    assert.equal((await status(options)).status, 'stopped');
    assert.equal(JSON.parse(await runCommand(process.execPath, [cli, 'stop', ...args, '--json'])).status, 'stopped');
  } finally { await stop(options); await tmp.cleanup(); }
});

test('non-interactive CLI requires download consent, returns JSON errors, and creates no daemon', async () => {
  const tmp = await temporaryDirectory();
  const execute = promisify(execFile);
  try {
    for (const command of ['start', 'restart']) {
      await assert.rejects(execute(process.execPath, [cli, command, '--json', '--state-dir', tmp.directory], { env: { ...process.env, PATH: tmp.directory } }), (error: any) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, '');
        const failure = JSON.parse(error.stderr);
        assert.equal(failure.code, 'DOWNLOAD_CONFIRMATION_REQUIRED');
        assert.match(failure.message, /--yes/);
        return true;
      });
      assert.equal((await status({ stateDir: tmp.directory })).status, 'stopped');
      assert.ok(!(await readdir(tmp.directory)).some(name => ['bin', 'state.json', 'credentials.json', 'last-start.json'].includes(name)));
    }
    await assert.rejects(runCommand(process.execPath, [cli, 'start', '--yes', '--no-download']), /INVALID_OPTIONS/);
    await assert.rejects(runCommand(process.execPath, [cli, 'status', '--yes']), /INVALID_OPTIONS/);
  } finally { await tmp.cleanup(); }
});
