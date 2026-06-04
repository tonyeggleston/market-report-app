import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { app } from 'electron';

let cachedPath = null;

const EXE_NAMES_WIN = ['chrome.exe', 'chromium.exe', 'chrome-headless-shell.exe'];
const EXE_NAMES_UNIX = ['chrome', 'chromium', 'chrome-headless-shell', 'google chrome for testing'];

function findExeRecursive(dir, names) {
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findExeRecursive(full, names);
        if (found) return found;
      } else if (names.includes(entry.name.toLowerCase())) {
        return full;
      }
    }
  } catch { /* permission errors */ }
  return null;
}

/**
 * Try to find a Chromium executable.
 * Priority: bundled (extraResources) → Playwright cache → install on demand.
 * Returns the path, or undefined to let Playwright use its default.
 */
export function getChromiumPath() {
  if (cachedPath) return cachedPath;

  // In dev mode, let Playwright use its own cached browser
  if (!app.isPackaged) return undefined;

  // Try bundled Chromium first (correct platform only)
  const chromiumDir = path.join(process.resourcesPath, 'chromium');
  if (fs.existsSync(chromiumDir)) {
    const exeNames = process.platform === 'win32' ? EXE_NAMES_WIN : EXE_NAMES_UNIX;
    const found = findExeRecursive(chromiumDir, exeNames);
    if (found) {
      cachedPath = found;
      return cachedPath;
    }
  }

  // Bundled Chromium missing or wrong platform — try Playwright's cache
  const playwrightDirs = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
    playwrightDirs.push(path.join(localAppData, 'ms-playwright'));
  } else if (process.platform === 'darwin') {
    playwrightDirs.push(path.join(process.env.HOME || '', 'Library', 'Caches', 'ms-playwright'));
  } else {
    playwrightDirs.push(path.join(process.env.HOME || '', '.cache', 'ms-playwright'));
  }

  for (const dir of playwrightDirs) {
    if (!fs.existsSync(dir)) continue;
    const exeNames = process.platform === 'win32' ? EXE_NAMES_WIN : EXE_NAMES_UNIX;
    const found = findExeRecursive(dir, exeNames);
    if (found) {
      cachedPath = found;
      return cachedPath;
    }
  }

  // No browser found anywhere — return undefined, let getLaunchOptions handle it
  return undefined;
}

/**
 * Install Playwright Chromium if not already present.
 * Call this before the first scraping run.
 */
export async function ensureBrowser() {
  if (getChromiumPath()) return; // already have one

  // Find the playwright CLI bundled in the app
  const playwrightPaths = [
    // Packaged app
    path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'playwright', 'cli.js'),
    path.join(process.resourcesPath, 'app', 'node_modules', 'playwright', 'cli.js'),
    // Dev mode
    path.join(app.getAppPath(), 'node_modules', 'playwright', 'cli.js'),
  ];

  let cliPath = null;
  for (const p of playwrightPaths) {
    if (fs.existsSync(p)) { cliPath = p; break; }
  }

  if (!cliPath) {
    // Try npx as last resort
    try {
      execSync('npx playwright install chromium', { timeout: 120000, stdio: 'pipe' });
      cachedPath = null; // reset so getChromiumPath re-scans
      return;
    } catch {
      throw new Error('Could not find or install Chromium. Please run: npx playwright install chromium');
    }
  }

  try {
    execSync(`node "${cliPath}" install chromium`, { timeout: 120000, stdio: 'pipe' });
    cachedPath = null; // reset so getChromiumPath re-scans
  } catch (err) {
    throw new Error('Failed to install Chromium browser: ' + err.message);
  }
}

export function getLaunchOptions() {
  const executablePath = getChromiumPath();
  const options = { headless: true };
  if (executablePath) {
    options.executablePath = executablePath;
  }
  return options;
}
