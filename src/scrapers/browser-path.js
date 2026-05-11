import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';

let cachedPath = null;

const EXE_NAMES_WIN = ['chrome.exe', 'chromium.exe', 'chrome-headless-shell.exe'];
const EXE_NAMES_UNIX = ['chrome', 'chromium', 'chrome-headless-shell'];

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

export function getChromiumPath() {
  if (cachedPath) return cachedPath;

  if (!app.isPackaged) return undefined;

  const chromiumDir = path.join(process.resourcesPath, 'chromium');

  if (!fs.existsSync(chromiumDir)) {
    throw new Error('Bundled Chromium folder not found at: ' + chromiumDir);
  }

  const exeNames = process.platform === 'win32' ? EXE_NAMES_WIN : EXE_NAMES_UNIX;
  cachedPath = findExeRecursive(chromiumDir, exeNames);

  if (!cachedPath) {
    throw new Error('Chromium executable not found inside: ' + chromiumDir);
  }

  return cachedPath;
}

export function getLaunchOptions() {
  const executablePath = getChromiumPath();
  const options = { headless: true };
  if (executablePath) {
    options.executablePath = executablePath;
  }
  return options;
}
