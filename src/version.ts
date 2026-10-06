import { readFileSync } from 'node:fs';

// package.json sits one level above both src/ and dist/. Bundled subprocesses get this inlined at build time.
export const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
