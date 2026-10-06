import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { Browser, BrowserTag, ChromeReleaseChannel, computeSystemExecutablePath, detectBrowserPlatform, install, resolveBuildId } from '@puppeteer/browsers';
import { PrintGoError } from './errors.js';
import { privateDirectory, readJson, stateDirectory, withLock, writeJson } from './storage.js';

export interface BrowserOptions { stateDir?: string; browserExecutablePath?: string }
export interface BrowserInstallResult { status: 'ready'; executablePath: string; buildId: string }

async function executable(path: string): Promise<boolean> {
  try { await access(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return (await stat(path)).isFile(); }
  catch { return false; }
}

/** Use an explicit, package-managed or installed browser without downloading one. */
export async function findBrowser(options: BrowserOptions = {}): Promise<string> {
  const explicit = options.browserExecutablePath ?? process.env.PRINTGO_CHROME_PATH;
  if (explicit) {
    const path = resolve(explicit);
    if (!await executable(path)) throw new PrintGoError('BROWSER_NOT_FOUND', 'The configured Chromium/Chrome executable is missing or is not executable.');
    return path;
  }
  const saved = await readJson<BrowserInstallResult>(join(stateDirectory(options.stateDir), 'browser.json'));
  if (saved && await executable(saved.executablePath)) return saved.executablePath;
  try { return computeSystemExecutablePath({ browser: Browser.CHROME, channel: ChromeReleaseChannel.STABLE }); }
  catch { /* Also support distribution-provided Chromium on Linux. */ }
  for (const path of ['/usr/bin/chromium', '/usr/bin/chromium-browser']) if (await executable(path)) return path;
  throw new PrintGoError('BROWSER_NOT_FOUND', 'Markdown/HTML rendering needs Chromium or Chrome. Run npx printgo install-browser, use --chrome /path/to/browser, or set PRINTGO_CHROME_PATH.');
}

/** Explicit setup/update command. Browser downloads never run during npm install. */
export async function installBrowser(options: Pick<BrowserOptions, 'stateDir'> = {}): Promise<BrowserInstallResult> {
  const directory = stateDirectory(options.stateDir);
  const cacheDir = join(directory, 'browsers');
  return withLock(cacheDir, async () => {
    await privateDirectory(directory);
    const platform = detectBrowserPlatform();
    if (!platform) throw new PrintGoError('UNSUPPORTED_PLATFORM', 'No Chromium download is available for this platform. Supply --chrome with a supported local browser.');
    const buildId = await resolveBuildId(Browser.CHROME, platform, BrowserTag.STABLE);
    const browser = await install({ cacheDir, browser: Browser.CHROME, buildId, platform, installDeps: false });
    const result: BrowserInstallResult = { status: 'ready', executablePath: browser.executablePath, buildId };
    await writeJson(join(directory, 'browser.json'), result);
    return result;
  });
}
