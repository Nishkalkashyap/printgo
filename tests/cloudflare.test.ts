import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, writeFile, readFile, symlink, mkdir, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureCloudflare, ensureCloudflared, tunnelArguments, cloudflaredEnvironment } from '../src/cloudflare.js';
import { readJson } from '../src/storage.js';
import { temporaryDirectory } from './helpers.js';

const binary = fileURLToPath(new URL('./fixtures/cloudflared.mjs', import.meta.url));

test('missing cloudflared requires consent before any network or download; approved copies are reused', { skip: process.platform === 'win32' }, async t => {
  const tmp = await temporaryDirectory();
  const originalPath = process.env.PATH;
  const toolsDirectory = join(tmp.directory, 'tools');
  const stateDir = join(tmp.directory, 'state');
  try {
    await mkdir(toolsDirectory);
    await symlink(process.execPath, join(toolsDirectory, 'node'));
    await symlink('/usr/bin/tar', join(toolsDirectory, 'tar'));
    const fixture = join(tmp.directory, 'cloudflared');
    await writeFile(fixture, await readFile(binary), { mode: 0o700 });
    let data = await readFile(fixture);
    if (process.platform === 'darwin') {
      const archive = join(tmp.directory, 'cloudflared.tgz');
      execFileSync('tar', ['-czf', archive, '-C', tmp.directory, 'cloudflared']);
      data = await readFile(archive);
    }
    let downloads = 0;
    const digest = `sha256:${createHash('sha256').update(data).digest('hex')}`;
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
      downloads++;
      if (String(url).endsWith('/releases/latest')) {
        const architectures: Record<string, string> = { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' };
        return Response.json({ assets: [{ name: `cloudflared-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${architectures[process.arch]}${process.platform === 'darwin' ? '.tgz' : ''}`,
          digest, browser_download_url: 'https://github.com/cloudflare/cloudflared/releases/download/test/cloudflared' }] });
      }
      return new Response(new Uint8Array(data));
    });
    process.env.PATH = toolsDirectory;
    await assert.rejects(ensureCloudflared({ stateDir }), { code: 'DOWNLOAD_CONFIRMATION_REQUIRED' });
    await assert.rejects(ensureCloudflared({ stateDir, downloadCloudflared: false,
      confirmCloudflaredDownload: async () => { throw new Error('Downloads are disabled; no prompt expected'); } }), { code: 'MISSING_DEPENDENCY' });
    let prompts = 0;
    await assert.rejects(ensureCloudflared({ stateDir, confirmCloudflaredDownload: async () => { prompts++; return false; } }), { code: 'DOWNLOAD_CANCELLED' });
    assert.equal(prompts, 1);
    assert.equal(downloads, 0);
    assert.deepEqual((await readdir(stateDir).catch(() => [])), []);
    const installed = await ensureCloudflared({ stateDir, confirmCloudflaredDownload: async () => { prompts++; return true; } });
    assert.equal(prompts, 2);
    assert.equal(downloads, 2);
    assert.equal(installed, join(stateDir, 'bin', 'cloudflared'));
    assert.equal(await ensureCloudflared({ stateDir, confirmCloudflaredDownload: async () => { throw new Error('Already installed; no prompt expected'); } }), installed);
    assert.equal(downloads, 2);
    const approvedState = join(tmp.directory, 'approved');
    await ensureCloudflared({ stateDir: approvedState, downloadCloudflared: true,
      confirmCloudflaredDownload: async () => { throw new Error('Explicit consent; no prompt expected'); } });
    assert.equal(downloads, 4);
  } finally { process.env.PATH = originalPath; await tmp.cleanup(); }
});

test('named setup recovers a DNS failure and reuses its own credentials on subsequent setup', async () => {
  await chmod(binary, 0o755);
  const tmp = await temporaryDirectory();
  process.env.FAKE_CF_STORE = join(tmp.directory, 'fake-upstream.json');
  try {
    const options = { stateDir: tmp.directory, cloudflaredPath: binary, hostname: 'printer.example.com', login: true };
    process.env.FAKE_CF_DNS_FAIL = '1';
    await assert.rejects(configureCloudflare(options));
    delete process.env.FAKE_CF_DNS_FAIL;
    const config = await configureCloudflare(options);
    assert.equal(config.mode, 'named');
    const reused = await configureCloudflare(options);
    assert.deepEqual(reused, config);
    const args = await tunnelArguments(config, tmp.directory, 'http://127.0.0.1:8787');
    const runtime = await readJson<any>(join(tmp.directory, 'cloudflared-runtime.json'));
    assert.equal(runtime.ingress[0].service, 'http://127.0.0.1:8787');
    assert.equal(runtime.ingress[1].service, 'http_status:404');
    assert.equal(args.at(-1), config.tunnelId);
  } finally {
    delete process.env.FAKE_CF_STORE;
    delete process.env.FAKE_CF_DNS_FAIL;
    await tmp.cleanup();
  }
});

test('quick config and process environment ignore ambient named-tunnel credentials', async () => {
  const tmp = await temporaryDirectory();
  try {
    process.env.TUNNEL_TOKEN = 'ambient-secret';
    process.env.TUNNEL_LOGLEVEL = 'debug';
    const args = await tunnelArguments({ mode: 'quick' }, tmp.directory, 'http://127.0.0.1:8787');
    assert.deepEqual(await readJson(join(tmp.directory, 'cloudflared-runtime.json')), {});
    assert.ok(args.includes('--url'));
    assert.equal(cloudflaredEnvironment().TUNNEL_TOKEN, undefined);
    assert.equal(cloudflaredEnvironment().TUNNEL_LOGLEVEL, undefined);
    const tokenFile = join(tmp.directory, 'token.txt');
    await writeFile(tokenFile, 'secret', { mode: 0o600 });
    const tokenArgs = await tunnelArguments({ mode: 'token', hostname: 'printer.example.com', tokenFile }, tmp.directory, 'http://127.0.0.1:8787');
    assert.ok(tokenArgs.includes('--token-file'));
    assert.ok(!tokenArgs.includes('secret'));
  } finally {
    delete process.env.TUNNEL_TOKEN;
    delete process.env.TUNNEL_LOGLEVEL;
    await tmp.cleanup();
  }
});
