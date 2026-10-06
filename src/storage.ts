import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PrintGoError } from './errors.js';

export function stateDirectory(directory?: string): string {
  return resolve(directory ?? process.env.PRINTGO_HOME ?? join(homedir(), '.printgo'));
}

export async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function processExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export const delay = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

async function recoverLock(directory: string, lock: string): Promise<void> {
  const recovery = join(directory, 'lifecycle.recovery');
  try { await mkdir(recovery, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    throw error;
  }
  try {
    // Re-read after taking the recovery gate. Two contenders must never both
    // delete an old lock: the second could otherwise delete the first's new lock.
    const owner = await readJson<{ pid: number }>(join(lock, 'owner.json'));
    if (owner && !processExists(owner.pid)) {
      await rm(lock, { recursive: true, force: true });
    } else if (!owner) {
      try {
        if (Date.now() - (await stat(lock)).mtimeMs > 30_000) await rm(lock, { recursive: true, force: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  } finally { await rm(recovery, { recursive: true, force: true }); }
}

/** Serializes CLI/SDK lifecycle operations across processes. */
export async function withLock<T>(directory: string, work: () => Promise<T>): Promise<T> {
  await privateDirectory(directory);
  const lock = join(directory, 'lifecycle.lock');
  const token = randomUUID();
  const deadline = Date.now() + 120_000;
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeJson(join(lock, 'owner.json'), { pid: process.pid, token });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await recoverLock(directory, lock);
      if (Date.now() > deadline) throw new PrintGoError('BUSY', 'Another lifecycle command is still running.');
      await delay(100);
    }
  }
  try { return await work(); }
  finally {
    const owner = await readJson<{ token: string }>(join(lock, 'owner.json'));
    if (owner?.token === token) await rm(lock, { recursive: true, force: true });
  }
}
