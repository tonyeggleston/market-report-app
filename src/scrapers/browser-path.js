import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';

let cachedPath = null;

/**
 * Find a usable Chromium-based browser on this machine.
 * Priority: bundled Chromium → Playwright cache → Edge → Chrome
 */
export function getChromiumPath() {
  if (cachedPath) return cachedPath;

  // In dev mode, let Playwright use its own cached browser
  if (!app.isPackaged) return undefined;

  // 1. Try bundled Chromium (correct platform)
  const bundled = findBundledChromium();
  if (bundled) { cachedPath = bundled; return cachedPath; }

  // 2. Try Playwright's cached browsers
  const playwright = findPlaywrightChromium();
  if (playwright) { cachedPath = playwright; return cachedPath; }

  // 3. Try system browsers (Edge, Chrome)
  const system = findSystemBrowser();
  if (system) { cachedPath = system; return cachedPath; }

  return undefined;
}

function findBundledChromium() {
  const chromiumDir = path.join(process.resourcesPath, 'chromium');
  if (!fs.existsSync(chromiumDir)) return null;

  const exeNames = process.platform === 'win32'
    ? ['chrome.exe', 'chromium.exe', 'chrome-headless-shell.exe']
    : ['chrome', 'chromium', 'chrome-headless-shell', 'google chrome for testing'];

  return findExeRecursive(chromiumDir, exeNames);
}

function findPlaywrightChromium() {
  const dirs = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
    dirs.push(path.join(local, 'ms-playwright'));
  } else if (process.platform === 'darwin') {
    dirs.push(path.join(process.env.HOME || '', 'Library', 'Caches', 'ms-playwright'));
  } else {
    dirs.push(path.join(process.env.HOME || '', '.cache', 'ms-playwright'));
  }

  const exeNames = process.platform === 'win32'
    ? ['chrome.exe', 'chromium.exe']
    : ['chrome', 'chromium', 'google chrome for testing'];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const found = findExeRecursive(dir, exeNames);
    if (found) return found;
  }
  return null;
}

function findSystemBrowser() {
  if (process.platform === 'win32') {
    // Edge is on every Windows 10+ machine
    const candidates = [
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  } else if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

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

export function getLaunchOptions() {
  const executablePath = getChromiumPath();
  const options = { headless: true };
  if (executablePath) {
    options.executablePath = executablePath;
  }
  return options;
}

// No-op for backward compatibility
export async function ensureBrowser() {}
