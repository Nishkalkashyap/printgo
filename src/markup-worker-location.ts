import { fileURLToPath } from 'node:url';

// Source tests use the built helper, just as lifecycle tests use the built daemon.
export const packagedMarkupWorker = fileURLToPath(new URL(
  import.meta.url.endsWith('.ts') ? '../dist/markup-worker.cjs' : './markup-worker.cjs', import.meta.url));
