#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const args = process.argv.slice(2);
const id = '12345678-1234-4234-8234-123456789abc';
if (args.includes('--version')) {
  console.log('cloudflared version test');
} else if (args.includes('list')) {
  console.log(process.env.FAKE_CF_STORE && existsSync(process.env.FAKE_CF_STORE) ? readFileSync(process.env.FAKE_CF_STORE, 'utf8') : '[]');
} else if (args.includes('create')) {
  const file = args[args.indexOf('--credentials-file') + 1];
  writeFileSync(file, JSON.stringify({ TunnelID: id }));
  if (process.env.FAKE_CF_STORE) writeFileSync(process.env.FAKE_CF_STORE, JSON.stringify([{ id, name: args.at(-1) }]));
} else if (args.includes('route')) {
  if (process.env.FAKE_CF_DNS_FAIL) process.exitCode = 1;
} else if (args.includes('login')) {
  console.error('Fake Cloudflare authentication completed');
} else {
  const configuration = JSON.parse(readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
  if (process.env.FAKE_CF_FAIL) process.exit(1);
  if (configuration.ingress && configuration.ingress[1]?.service !== 'http_status:404') process.exit(2);
  console.error('https://test-printgo.trycloudflare.com');
  console.error('Registered tunnel connection');
  setInterval(() => {}, 1000);
  process.on('SIGTERM', () => process.exit(0));
}
